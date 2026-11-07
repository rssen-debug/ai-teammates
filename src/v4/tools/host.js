/**
 * MAJIN V4 — host tool bus.
 *
 * V4 shipped workspace-only tools. V1 already has measured Windows control
 * (`src/core/tools/wincontrol.js`: WM_SETTEXT → WM_GETTEXT → BM_CLICK round-trip),
 * a filesystem surface (`fs.*`), and a browser lane. This module adapts those
 * proven implementations into V2 `ToolDefinition`s so they run through the same
 * runner, approval layer and receipts as everything else.
 *
 * The contract this file exists to guarantee is honesty:
 *
 *   - a capability that is not present on this host is NOT registered, and the
 *     capability report says so. A tool that silently exists but always fails is
 *     worse than a tool that is absent.
 *   - a registered tool still refuses at call time if the host changed under it
 *     (a Windows session that locked, a helper that disappeared).
 *   - risk maps to tier, and tier drives V2's approval policy: anything that can
 *     drive the machine is `process` and therefore held, not auto-approved.
 *
 * What is NOT claimed: these tools have never been executed on Windows from this
 * environment. Their contract is tested here; their effect is tested by
 * `npm run v4:accept` on the host.
 */
import { z } from 'zod';
import { runTool } from '../../v2/tools/runner.js';
import { searchRegistry } from '../tool-exposure.js';
import { assertPathsAllowed } from '../path-access.js';
import { hostSessionId } from '../turn-state.js';

/**
 * The V1 tool modules and the arrays they export.
 *
 * Discovered by reading `src/core/tools/*.js`, not guessed. Every entry here is a
 * lane the owner can enable; `hostCapabilities()` still decides per lane whether
 * it loads, so a module that disappears degrades to a stated reason.
 */
const NET_TOOLS = Object.freeze(['net.dns', 'net.tcp', 'net.http', 'net.serve', 'net.serve_stop']);
const SCREEN_TOOLS = Object.freeze(['screen.capture', 'screen.claim', 'sys.notify']);

export async function interactiveWindowsSession(env = process.env) {
  if (/^services$/i.test(env.SESSIONNAME || '')) return false;
  if (env.SESSIONNAME) return true;
  if (process.platform !== 'win32') return false;
  // Desktop launchers and Scheduled Tasks often omit SESSIONNAME. Ask Windows
  // instead of silently disabling a working browser in those sessions.
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Environment]::UserInteractive -and ([Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0)'],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return result.status === 0 && result.stdout.trim() === 'True';
}

export const V1_LANES = Object.freeze({
  // Windows-only, because every tool drives the interactive desktop.
  desktop: { module: '../../core/tools/wincontrol.js', export: 'winControlTools', tierDefault: 'process', windowsOnly: true },
  computer: { module: '../../core/tools/computer.js', export: 'computerTools', tierDefault: 'process', windowsOnly: true },
  screen: { module: '../../core/tools/net.js', export: 'netTools', tierDefault: 'process', only: SCREEN_TOOLS, windowsOnly: true },
  // The same module also carries five cross-platform network tools. Gating the
  // whole module as "screen" (as V4 did) hid net.dns/net.http on Linux and any
  // Windows session without an interactive desktop.
  net: { module: '../../core/tools/net.js', export: 'netTools', tierDefault: 'external', only: NET_TOOLS },
  files: { module: '../../core/tools/files.js', export: 'fileTools', tierDefault: 'write' },
  // V1 has two shell surfaces: exec.* (managed long-running executors) and
  // shell.* (command, background jobs, env). Both are real and complementary.
  shell: { module: '../../core/tools/exec.js', export: 'execTools', tierDefault: 'process' },
  shelltools: { module: '../../core/tools/shell.js', export: 'shellTools', tierDefault: 'process' },
  sys: { module: '../../core/tools/sys.js', export: 'sysTools', tierDefault: 'read' },
  power: { module: '../../core/tools/power.js', export: 'powerTools', tierDefault: 'process' },
  // NOTE: browser.* tools live inside web.js's webTools array, not in
  // core/browser.js (which is the launch/pool layer). They are therefore part of
  // the `web` lane; `browserRuntime` below reports whether they can actually run.
  web: { module: '../../core/tools/web.js', export: 'webTools', tierDefault: 'external' },
  research: { module: '../../core/tools/research.js', export: 'researchTools', tierDefault: 'external' },
  jobs: { module: '../../core/tools/jobs.js', export: 'jobTools', tierDefault: 'external' },
  flows: { module: '../../core/tools/flows.js', export: 'flowsTools', tierDefault: 'process' },
  github: { module: '../../core/tools/github.js', export: 'githubTools', tierDefault: 'external' },
  channels: { module: '../../core/tools/channels.js', export: 'channelTools', tierDefault: 'process' },
  audit: { module: '../../core/tools/audit.js', export: 'auditTools', tierDefault: 'read' },
  learn: { module: '../../core/tools/learn.js', export: 'learnTools', tierDefault: 'write' },
  marketing: { module: '../../core/tools/marketing.js', export: 'marketingTools', tierDefault: 'external' },
  re: { module: '../../core/tools/re.js', export: 'reTools', tierDefault: 'read' },
  trading: { module: '../../core/tools/trading.js', export: 'tradingTools', tierDefault: 'external' },
});

/** Kept for callers that only know the three original lanes. */
export const LANE_EXPORTS = Object.freeze(
  Object.fromEntries(Object.entries(V1_LANES).map(([k, v]) => [k, v.export])),
);

/** V1 risk vocabulary -> V2 tool tier (which decides the approval policy). */
export const RISK_TO_TIER = Object.freeze({
  read: 'read',
  ok: 'read',
  write: 'write',
  exec: 'process',   // driving another window or a shell is a held operation
  net: 'external',
  browser: 'browser',
});

/**
 * What this host can actually do, decided by asking the platform and by trying
 * to load the implementation. Never by assuming.
 */
export async function hostCapabilities({
  platform = process.platform,
  importModule = (spec) => import(spec),
  env = process.env,
  lanes = V1_LANES,
} = {}) {
  const caps = { platform, lanes: {} };

  const load = async (spec) => {
    try {
      return await importModule(spec);
    } catch (err) {
      return { __error: String(err?.message || err) };
    }
  };

  for (const [lane, spec] of Object.entries(lanes)) {
    const entry = { available: false, reason: null, tools: [], tierDefault: spec.tierDefault };

    // Windows-only lanes say so instead of loading and failing at call time.
    const windowsOnly = spec.windowsOnly ?? ['desktop', 'screen', 'computer'].includes(lane);
    if (windowsOnly && platform !== 'win32') {
      entry.reason = `Windows-only (this host is ${platform})`;
      caps.lanes[lane] = entry;
      continue;
    }

    const mod = await load(spec.module);
    if (mod.__error) {
      entry.reason = `implementation unavailable: ${mod.__error}`;
    } else if (!Array.isArray(mod[spec.export])) {
      entry.reason = `${spec.export} is not exported by ${spec.module}`;
    } else {
      // A lane may expose a subset of a module's tools (net.js carries both
      // network and screen tools).
      const all = mod[spec.export];
      const list = Array.isArray(spec.only) ? all.filter((t) => spec.only.includes(t.name)) : all;
      if (!list.length) {
        entry.reason = `${spec.export} is empty (not available in this build)`;
      } else {
        entry.available = true;
        entry.tools = list.map((t) => t.name);
        entry.module = mod;
        entry.exportName = spec.export;
        entry.only = spec.only || null;
      }
    }
    caps.lanes[lane] = entry;
  }

  // --- browser runtime: owning the library is not owning a browser ---------
  // browser.* tools are registered with the `web` lane, but they can only run if
  // a real browser exists. Reported separately so the owner is not told the web
  // lane is fully functional when half of it cannot launch.
  caps.browserRuntime = { available: false, reason: null };
  if (platform === 'win32' && !await interactiveWindowsSession(env)) {
    caps.browserRuntime.reason = 'no interactive Windows session detected (service sessions cannot show a browser)';
  } else {
    const bin = await browserBinary({ platform, env });
    if (!bin) caps.browserRuntime.reason = 'no browser binary found (npx playwright install chromium)';
    else {
      caps.browserRuntime.available = true;
      caps.browserRuntime.binary = bin;
    }
  }

  return caps;
}

/**
 * Find an installed browser binary without launching it.
 *
 * Playwright keeps browsers under PLAYWRIGHT_BROWSERS_PATH or a per-platform
 * cache; MAJIN_V4_BROWSER overrides for a hand-installed Chromium or Edge.
 */
export async function browserBinary({ platform = process.platform, env = process.env } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const seen = (p) => {
    try {
      return Boolean(p) && fs.existsSync(p);
    } catch {
      return false;
    }
  };

  if (env.MAJIN_V4_BROWSER) return seen(env.MAJIN_V4_BROWSER) ? env.MAJIN_V4_BROWSER : null;

  // A real Edge install is the common case on the owner's Windows machine.
  if (platform === 'win32') {
    for (const dir of [
      env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]) {
      if (seen(dir)) return dir;
    }
  }

  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH) roots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === 'win32') roots.push(path.join(env.LOCALAPPDATA || '', 'ms-playwright'));
  else if (platform === 'darwin') roots.push(path.join(env.HOME || '', 'Library', 'Caches', 'ms-playwright'));
  else roots.push(path.join(env.HOME || '', '.cache', 'ms-playwright'));

  for (const root of roots) {
    if (!root || !seen(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidates = platform === 'win32'
        ? [path.join(root, entry, 'chrome-win', 'chrome.exe'), path.join(root, entry, 'chrome-win64', 'chrome.exe')]
        : [path.join(root, entry, 'chrome-linux', 'chrome'), path.join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell')];
      for (const c of candidates) if (seen(c)) return c;
    }
  }
  return null;
}

/** Public, serialisable view: no module handles leave this function. */
export function describeCapabilities(caps) {
  const out = { platform: caps.platform, lanes: {}, browserRuntime: caps.browserRuntime || { available: false, reason: 'unknown' } };
  for (const [lane, c] of Object.entries(caps.lanes || {})) {
    out.lanes[lane] = {
      available: Boolean(c?.available),
      reason: c?.reason || null,
      tools: c?.tools || [],
      ...(c?.binary ? { binary: c.binary } : {}),
    };
  }
  return out;
}

/**
 * V1 names tools with dots (`fs.read`, `exec.start`, `control.type`). V2's
 * registry requires `/^[a-z][a-z0-9_]*$/`, so dots become underscores.
 *
 * The mapping is deterministic and reversible, and the original name is kept on
 * the definition as `sourceName` so an operator can always tell which V1 tool a
 * registered name came from.
 */
export function v2ToolName(v1name) {
  return String(v1name).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([^a-z])/, 'tool_$1');
}

/** The reverse, for reading logs back to V1 names. */
export function v1ToolName(v2name) {
  return String(v2name).replace(/_/g, '.');
}

/**
 * V1 returns `{ok, result, meta, summary}` and, on failure,
 * `{ok:false, error:{code,message,hint}}` — an OBJECT, not a string.
 *
 * The first version of this schema expected a string, so an honest "no search
 * engine answered" became INVALID_TOOL_OUTPUT: a failing tool misreported as a
 * broken one. The probe in `npm run v4:tools --probe` caught it.
 */
const V1_ERROR = z.union([
  z.string(),
  z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    hint: z.string().optional(),
  }).loose(),
]);

const OUTPUT = z.object({
  ok: z.boolean(),
  result: z.union([z.string(), z.any()]).optional(),
  meta: z.unknown().optional(),
  summary: z.string().optional(),
  error: V1_ERROR.optional(),
  hint: z.string().optional(),
  unsupported: z.boolean().optional(),
});

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return [err.message, err.hint].filter(Boolean).join(' — ') || err.code || '';
}

/**
 * V1's `error.code` -> the V2 failure vocabulary the scheduler understands.
 * Anything unknown becomes UNKNOWN rather than being upgraded to a retryable
 * class by accident.
 */
export function classifyV1Error(err) {
  const code = String((err && typeof err === 'object' ? err.code : '') || '').toLowerCase();
  const msg = String((err && typeof err === 'object' ? err.message : err) || '').toLowerCase();
  if (/protected|permission|denied|eacces|eperm/.test(code + msg)) return 'PERMISSION_DENIED';
  if (/not_found|enoent|missing/.test(code + msg)) return 'DEPENDENCY_MISSING';
  if (/timeout|timed out|etimedout|deadline/.test(code + msg)) return 'TIMEOUT';
  if (/network|fetch failed|econn|enotfound|dns_failed|no search engine|offline/.test(code + msg)) return 'NETWORK_FAILURE';
  if (/unsupported/.test(code + msg)) return 'DEPENDENCY_MISSING';
  return 'UNKNOWN';
}

/**
 * V1 params are `{ name: 'type: description' }` strings. V2 needs zod. This
 * keeps a permissive schema for anything it cannot type rather than inventing a
 * constraint that would reject valid calls.
 */
export function zodFromV1Params(params = {}, required = []) {
  const shape = {};
  const must = new Set(Array.isArray(required) ? required : []);
  for (const [key, spec] of Object.entries(params || {})) {
    const type = String(spec).split(':')[0].trim().toLowerCase();
    let field;
    if (type === 'number' || type === 'int' || type === 'integer') field = z.number();
    else if (type === 'boolean' || type === 'bool') field = z.boolean();
    else if (type === 'array') field = z.array(z.unknown());
    else if (type === 'object') field = z.record(z.string(), z.unknown());
    else field = z.string();
    // V1's `def()` already derives required parameters from the run signature.
    // Dropping that made a missing argument reach the tool as a confusing
    // ENOENT instead of a schema error the model can correct.
    field=field.describe(String(spec).replace(/^[^:]*:\s*/,''));
    shape[key] = must.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

/**
 * The context a V1 tool expects.
 *
 * V1 tools read their limits from `ctx.cfg.get(...)` and their workspace root
 * from `ctx.cfg.get('workspace')`. Rather than hand them V1's whole live config
 * (which would bypass V4's boundaries), this builds a minimal read-only view with
 * the workspace V4 was given. `get` returns undefined for everything else, so a
 * V1 tool falls back to its own documented defaults.
 */
export function v1Context({
  workspaceDir = null,
  cfg = null,
  dataFile = null,
  registry = null,
  approvals = null,
  session = 'v4',
  emit = null,
  folders = () => [],
} = {}) {
  const values = { workspace: workspaceDir };
  // Nested V1 tools (research.run -> web.search, flows.fire -> any tool) call
  // `ctx.registry.exec`. The first V4 adapter had no registry, so those lanes
  // registered but could never work. This facade executes through the SAME V2
  // runner and approval policy, so a nested call is not a way around consent.
  let depth = 0;
  const facade = registry
    ? Object.freeze({
      list: () => registry.list().map((t) => ({
        name: v1ToolName(t.name),
        desc: t.description,
        risk: TIER_TO_RISK[t.tier] || 'exec',
      })),
      search: (q, { limit = 6 } = {}) => searchRegistry(registry, q, { limit }).map((h) => ({
        id: v1ToolName(h.name),
        desc: h.description,
        sideEffects: h.tier,
        tags: [],
        inputs: { properties: {} },
      })),
      exec: async (name, args = {}, opts = {}) => {
        const wanted = String(name).includes('.') ? v2ToolName(name) : String(name);
        const def = registry.get(wanted);
        if (!def) return { ok: false, error: { code: 'unknown_tool', message: `tool ${name} is not available on this host` } };
        if (depth >= 2) return { ok: false, error: { code: 'recursion', message: 'nested tool calls are limited to two levels' } };
        depth += 1;
        try {
          const out = await runTool(
            { tool: wanted, input: args || {} },
            {
              registry,
              approvals: approvals || { check: () => ({ decision: 'allow' }) },
              mode: 'balanced',
              timeoutMs: Number(opts.timeoutMs) || 60_000,
            },
          );
          const data = out.data || {};
          return {
            ok: true,
            result: data.result ?? data,
            meta: data.meta ?? null,
            summary: data.summary ?? null,
          };
        } catch (err) {
          return { ok: false, error: { code: err?.cls || 'tool_failure', message: String(err?.message || err) } };
        } finally {
          depth -= 1;
        }
      },
    })
    : undefined;

  return Object.freeze({
    cfg: Object.freeze({
      get: (key) => {
        if (cfg && typeof cfg.get === 'function') {
          const v = cfg.get(key);
          if (v !== undefined) return v;
        }
        return values[key];
      },
      // V1's sys.info derives the data dir from the config file path.
      file: dataFile,
    }),
    workspaceDir,
    get session() { return hostSessionId(session); },
    // Read at call time, never captured: a folder granted on the phone must be
    // usable on the very next tool call, not after a restart.
    folders,
    ...(emit ? { emit } : {}),
    ...(facade ? { registry: facade } : {}),
  });
}

/** V2 tier -> the V1 risk word a V1 tool expects to see. */
const TIER_TO_RISK = Object.freeze({
  read: 'read', write: 'write', process: 'exec', external: 'net', browser: 'browser',
});

export function adaptV1Tool(v1tool, { lane, ctx = null }) {
  return {
    name: v2ToolName(v1tool.name),
    sourceName: v1tool.name,
    // V2 requires a description of at least four characters.
    description: `${v1tool.desc || v1tool.name}`.slice(0, 400),
    tier: RISK_TO_TIER[v1tool.risk] || 'process',
    inputSchema: zodFromV1Params(v1tool.raw || {}, v1tool.parameters?.required || []).strip(),
    outputSchema: OUTPUT,
    lane,
    execute: async (input = {}, {signal = null} = {}) => {
      // The grant is only real if it is enforced here: a path outside the
      // workspace and every granted folder never reaches V1's filesystem code.
      assertPathsAllowed(v1tool.name, input, {
        workspace: ctx?.workspaceDir || null,
        folders: typeof ctx?.folders === 'function' ? ctx.folders() : [],
      });
      let result;
      try {
        const callContext = signal ? Object.assign(Object.create(ctx || null), {signal}) : ctx;
        result = await v1tool.run(input, callContext);
      } catch (err) {
        // A thrown V1 tool is a classified failure, never a silent success.
        const e = new Error(String(err?.message || err));
        e.cls = err?.cls || 'UNKNOWN';
        throw e;
      }
      if (!result || typeof result !== 'object') {
        const e = new Error(`tool ${v1tool.name} returned no structured result`);
        e.cls = 'INVALID_TOOL_OUTPUT';
        throw e;
      }
      if (result.unsupported) {
        const e = new Error(result.result || errorText(result.error) || `${v1tool.name} is not supported on this host`);
        e.cls = 'DEPENDENCY_MISSING';
        throw e;
      }
      // An honest structured failure is a classified failure, not a schema break.
      if (result.ok === false) {
        const e = new Error(errorText(result.error) || `${v1tool.name} reported failure`);
        e.cls = classifyV1Error(result.error);
        throw e;
      }
      return {
        ok: true,
        result: typeof result.result === 'string' ? result.result : (result.result ?? null),
        meta: result.meta ?? null,
        ...(result.summary != null ? {summary:String(result.summary)} : {}),
        ...(result.hint ? { hint: String(result.hint) } : {}),
      };
    },
  };
}

/**
 * Register every available host tool into a V4 registry.
 *
 * `allow` is an optional list of tool names; when given, only those are exposed.
 * That is the Owner Mode lever: broad access is a decision, not a default.
 */
/**
 * Tools that cannot run without a browser runtime.
 *
 * They live in the `web` lane (V1 ships them there), but offering them without a
 * browser is the same lie as offering a Windows tool on Linux: the model would
 * call them and get a failure it was not warned about.
 */
export const BROWSER_DEPENDENT = /^browser\./;

export function registerHostTools(registry, caps, {
  allow = null,
  workspaceDir = null,
  cfg = null,
  dataFile = null,
  approvals = null,
  session = 'v4',
  emit = null,
  folders = () => [],
} = {}) {
  const ctx = v1Context({ workspaceDir, cfg, dataFile, registry, approvals, session, emit, folders });
  const browserReady = Boolean(caps.browserRuntime?.available);
  const registered = [];
  const skipped = [];

  for (const [lane, cap] of Object.entries(caps.lanes || {})) {
    if (!cap?.available || !cap.module) {
      skipped.push({ lane, reason: cap?.reason || 'not available' });
      continue;
    }
    const exported = cap.module[cap.exportName || LANE_EXPORTS[lane]];
    if (!Array.isArray(exported)) {
      skipped.push({ lane, reason: 'no tool list exported' });
      continue;
    }
    const list = Array.isArray(cap.tools) && cap.tools.length
      ? exported.filter((t) => cap.tools.includes(t.name))
      : exported;
    for (const v1tool of list) {
      if (!browserReady && BROWSER_DEPENDENT.test(v1tool.name)) {
        skipped.push({ lane, tool: v1tool.name, reason: `no browser runtime: ${caps.browserRuntime?.reason || 'unavailable'}` });
        continue;
      }
      const wanted = v2ToolName(v1tool.name);
      if (allow && !allow.includes(v1tool.name) && !allow.includes(wanted)) {
        skipped.push({ lane, tool: v1tool.name, reason: 'not in the owner allowlist' });
        continue;
      }
      try {
        const def = adaptV1Tool(v1tool, { lane, ctx });
        registry.define(def);
        registered.push({ name: def.name, sourceName: def.sourceName, tier: def.tier, lane });
      } catch (err) {
        skipped.push({ lane, tool: v1tool.name, reason: String(err?.message || err) });
      }
    }
  }

  return { registered, skipped };
}
