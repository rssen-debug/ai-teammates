import path from 'node:path';
import { ALL_TOOLS } from '../core/tools/index.js';
import { browserTools } from '../core/tools/browser.js';
import { desktopAppTools } from '../core/tools/desktop-app.js';
import { ToolRegistry } from '../v2/tools/registry.js';
import { runTool } from '../v2/tools/runner.js';
import { jsonSchemaFor } from '../v4/schema.js';
import { V1_LANES, hostCapabilities, registerHostTools } from '../v4/tools/host.js';

const SERVICE_BOUND = [
  // Specific entries first (first match wins): name the working V5 surface so
  // the catalog shows the real path instead of a generic placeholder. None of
  // these make the legacy tool itself available — partial coverage is never
  // reported as parity.
  [/^majin\.memory$/, 'long-term memory is split by design: model surface majin_memory (status/read/remember), full lifecycle owner-only via `majin-v5 memory` (list/search/get/forget/clear/export/import); the legacy all-in-one tool is not supplied to the isolated driver'],
  [/^majin\.provider$/, 'provider reads are model-reachable via majin_provider (list/models); configuring providers or handling API keys is owner-only via `majin-v5 model` or the UI and never supplied to the isolated driver'],
  [/^majin\.routes$/, 'model routing is owner configuration (`majin-v5 model`); the active selection is visible to the model via majin_provider and majin_status'],
  [/^majin\.skill$/, 'verified procedures are model-reachable via procedures_search and procedures_read; procedures are learned host-side from independently verified goals, and legacy skill file management is not supplied to the isolated driver'],
  [/^majin\.backup$/, 'owner backup surface: `majin-v5 memory export` / `import --yes` covers long-term memory with validated sync records; no full-host backup service is supplied to the isolated driver'],
  [/^majin\.schedule$/, 'scheduled work is supplied by the provider-host majin_schedule tool while chat/serve is running; it uses saved model/grants, host local time and a bounded run count; the isolated driver has no scheduler'],
  [/^majin\.heartbeat$/, 'the V5 provider-host majin_heartbeat tool observes real goal outcomes and persists a local CLI inbox; the isolated driver has no heartbeat daemon'],
  [/^majin\.channel$/, 'external messaging channels require host adapters and credentials configured by the owner; none are supplied to the isolated driver'],
  [/^majin\.(configure|control|guard)$/, 'owner-only configuration/guard surface (`majin-v5 grants`, `majin-v5 doctor`, the UI); settings and permissions are never writable from model text'],
  [/^majin\.(?!self_audit$)/, 'requires the V1/V5 host service context (config, memory, skills, scheduler, channels, dataset, or adapters); use the corresponding V5 surface until that service is supplied to the isolated driver'],
  [/^media\./, 'requires a configured media provider service; the deterministic driver does not supply media credentials or provider inference'],
  [/^(agent|team)\./, 'legacy agent orchestration requires a model runtime; the V5 provider supplies agent_plan, agent_checkpoint, and agent_delegate on the host side'],
  [/^memory\./, 'requires the legacy memory service; V5 procedural memory is supplied host-side through procedures_search and procedures_read, and owner memory sync/backup runs through `majin-v5 memory export` / `import --yes`'],
  [/^(reset|plugin)\./, 'requires the host runtime service that owns reset/plugin state; it is not supplied to the isolated deterministic driver'],
];

const PATH_KEYS_BY_PREFIX = [
  [/^fs\./, ['path', 'from', 'to', 'archive', 'cwd']],
  [/^re\./, ['path', 'file', 'filePath', 'a', 'b', 'left', 'right', 'output', 'out']],
  [/^jobs\./, ['path', 'filePath', 'cvPath']],
  [/^(shell|exec)\./, ['cwd']],
  [/^net\.serve/, ['path', 'root', 'dir', 'cwd']],
  [/^web\.download$/, ['path']],
];

export const V5_TOOL_UNIVERSE = Object.freeze([...new Set([
  ...ALL_TOOLS.map((tool) => tool.name),
  ...browserTools.map((tool) => tool.name),
  ...desktopAppTools.map((tool) => tool.name),
])].sort());

export function driverToolName(sourceName) {
  return String(sourceName).replaceAll('.', '_');
}

export function laneForSourceTool(sourceName) {
  if (sourceName === 'majin.self_audit') return 'sys';
  if (sourceName === 'tools.search') return 'meta';
  if (sourceName.startsWith('fs.')) return 'files';
  if (sourceName.startsWith('exec.')) return 'shell';
  if (sourceName.startsWith('shell.')) return 'shelltools';
  if (sourceName.startsWith('sys.')) return sourceName === 'sys.notify' ? 'screen' : 'sys';
  if (sourceName.startsWith('net.')) return 'net';
  if (sourceName.startsWith('screen.')) return 'screen';
  if (sourceName.startsWith('web.')) return 'web';
  if (sourceName.startsWith('browser.')) return 'browser';
  if (sourceName.startsWith('research.')) return 'research';
  if (sourceName.startsWith('jobs.')) return 'jobs';
  if (sourceName.startsWith('flows.')) return 'flows';
  if (sourceName.startsWith('github.')) return 'github';
  if (sourceName.startsWith('channel.')) return 'channels';
  if (sourceName.startsWith('ma.')) return 'learn';
  if (sourceName.startsWith('marketing.')) return 'marketing';
  if (sourceName.startsWith('re.')) return 're';
  if (sourceName.startsWith('trading.')) return 'trading';
  if (sourceName.startsWith('power.')) return 'power';
  if (sourceName.startsWith('control.') || sourceName.startsWith('mouse.') || sourceName.startsWith('desktop.')) return 'desktop';
  if (sourceName.startsWith('computer.') || sourceName.startsWith('cursor.')) return 'computer';
  if (sourceName.startsWith('majin.')) return 'majin-service';
  if (sourceName.startsWith('agent.') || sourceName.startsWith('team.')) return 'agent-service';
  if (sourceName.startsWith('media.')) return 'media-service';
  if (sourceName.startsWith('memory.')) return 'memory-service';
  if (sourceName.startsWith('reset.') || sourceName.startsWith('plugin.')) return 'host-service';
  return 'unknown';
}

export function selectedHostLanes({ grantedLanes = null, desktop = false, browser = false, processAccess = false } = {}) {
  let lanes;
  if (Array.isArray(grantedLanes)) {
    lanes = grantedLanes.filter((lane) => Object.hasOwn(V1_LANES, lane));
    // The owner-facing `browser` grant is a runtime grant. In the legacy lane
    // map the non-browser web tools and legacy browser helpers live under `web`.
    if (grantedLanes.includes('browser')) lanes.push('web');
    // Process/desktop are separate host execution gates. A caller that
    // explicitly disables them (for example the read-only delegation driver)
    // must not have those lanes re-enabled by the bridge.
    if (!processAccess) lanes = lanes.filter((lane) => !['shell', 'shelltools'].includes(lane));
    if (!desktop) lanes = lanes.filter((lane) => !['desktop', 'screen', 'computer'].includes(lane));
  } else {
    // Direct/Codex controller mode has no persisted owner-lane list. Mirror the
    // capabilities already explicitly enabled by its startup flags instead of
    // silently granting every host lane.
    lanes = ['files', 'web'];
    if (processAccess) lanes.push('shell', 'shelltools');
    if (desktop) lanes.push('desktop', 'screen', 'computer');
    if (browser) lanes.push('web');
  }
  return [...new Set(lanes)];
}

function normalizePathArguments(sourceName, args, resolveToolPath) {
  const rule = PATH_KEYS_BY_PREFIX.find(([pattern]) => pattern.test(sourceName));
  if (!rule || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  for (const key of rule[1]) {
    const value = out[key];
    if (typeof value !== 'string' || !value.trim() || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    out[key] = resolveToolPath(value);
  }
  return out;
}

/**
 * Register the existing V4 universal host bridge inside the V5 deterministic
 * driver. Owner/controller-selected lanes are the authorization boundary;
 * individual legacy tools retain their own guards (prepared-state checks,
 * origin gates, approval-token checks, and structured refusals).
 */
export async function createUniversalHostTools({
  workspace,
  allowedFolders = [],
  grantedLanes = null,
  desktop = false,
  browser = false,
  processAccess = false,
  browserExecutable = null,
  reservedNames = new Set(),
  resolveToolPath,
  session,
  approvals = { check: () => ({ decision: 'allow' }) },
} = {}) {
  const selectedLanes = selectedHostLanes({ grantedLanes, desktop, browser, processAccess });
  const report = { selectedLanes, registered: [], skipped: [], events: [] };
  const tools = new Map();
  if (!selectedLanes.length) return { tools, report };

  const laneSpecs = Object.fromEntries(selectedLanes.map((lane) => [lane, V1_LANES[lane]]));
  const caps = await hostCapabilities({ lanes: laneSpecs });
  caps.browserRuntime = browserExecutable
    ? { available: true, binary: browserExecutable }
    : { available: false, reason: browser ? 'no browser binary found' : 'browser lane is not enabled for this driver' };

  for (const [lane, cap] of Object.entries(caps.lanes || {})) {
    if (!Array.isArray(cap.tools)) continue;
    const keep = [];
    for (const toolName of cap.tools) {
      if (toolName.startsWith('browser.')) {
        report.skipped.push({
          lane,
          tool: toolName,
          reason: 'legacy CDP browser surface is superseded by the V5 Playwright browser tools; legacy-only form helpers still require a port to that session',
        });
      } else if (toolName === 'computer.use') {
        report.skipped.push({
          lane,
          tool: toolName,
          reason: 'requires a provider vision/desktop model service; the deterministic driver does not supply one',
        });
      } else if (toolName === 'jobs.search' || toolName === 'jobs.match') {
        report.skipped.push({
          lane,
          tool: toolName,
          reason: 'provided by the deterministic V5 jobs adapter with local deduplication and matching',
        });
      } else {
        keep.push(toolName);
      }
    }
    cap.tools = keep;
  }

  const registry = new ToolRegistry();
  const bridge = registerHostTools(registry, caps, {
    workspaceDir: workspace,
    cfg: { get: (key) => (key === 'workspace' ? workspace : undefined) },
    dataFile: path.join(workspace, 'config.json'),
    approvals,
    session: session || 'majin-v5-driver',
    emit: (event) => {
      report.events.push(event);
      if (report.events.length > 100) report.events.splice(0, report.events.length - 100);
    },
    folders: () => [workspace, ...allowedFolders],
  });
  report.registered.push(...bridge.registered);
  report.skipped.push(...bridge.skipped);

  for (const entry of bridge.registered) {
    const def = registry.get(entry.name);
    if (!def) continue;
    if (reservedNames.has(def.name) || tools.has(def.name)) {
      report.skipped.push({
        lane: entry.lane,
        tool: entry.sourceName,
        reason: 'provided by the existing deterministic V5 driver implementation',
      });
      continue;
    }
    const inputSchema = jsonSchemaFor(def.inputSchema);
    if (!inputSchema) {
      report.skipped.push({ lane: entry.lane, tool: entry.sourceName, reason: 'input schema could not be converted without guessing' });
      continue;
    }
    if (inputSchema.type === 'object') inputSchema.additionalProperties = false;

    tools.set(def.name, {
      name: def.name,
      source: entry.sourceName,
      description: def.description,
      inputSchema,
      lane: entry.lane,
      tier: entry.tier,
      async run(rawArgs = {}) {
        const eventStart = report.events.length;
        try {
          const args = normalizePathArguments(entry.sourceName, rawArgs, resolveToolPath);
          const out = await runTool(
            { tool: def.name, input: args },
            { registry, approvals, mode: 'balanced', timeoutMs: 118_000 },
          );
          if (out.ok === false) {
            return {
              ok: false,
              error: { code: 'CONSENT_PENDING', message: out.reason || 'consent pending' },
              meta: { pendingScope: out.pendingScope || null },
            };
          }
          const data = out.data && typeof out.data === 'object' ? out.data : { ok: true, result: out.data ?? null };
          const hostEvents = report.events.slice(eventStart);
          return {
            ...data,
            ...(hostEvents.length ? {
              meta: {
                ...(data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? data.meta : {}),
                ...(data.meta != null && (typeof data.meta !== 'object' || Array.isArray(data.meta)) ? { toolMeta: data.meta } : {}),
                hostEvents,
              },
            } : {}),
            durationMs: out.durationMs,
          };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error?.code || error?.cls || 'TOOL_FAILURE',
              message: String(error?.message || error),
            },
          };
        }
      },
    });
  }

  return { tools, report };
}

/**
 * Legacy tools whose capability is genuinely provided by a current V5 tool.
 * Only list a mapping when the agent can actually achieve the same outcome
 * through the named tool(s) today; anything weaker stays an honest blocker.
 * `surface: 'driver'` tools are callable in the isolated driver;
 * `surface: 'provider-host'` tools exist in provider-driven goals.
 */
export const SUPERSEDED_TOOLS = new Map([
  ['browser.read', { coveredBy: ['browser_inspect'], surface: 'driver' }],
  ['browser.elements', { coveredBy: ['browser_inspect'], surface: 'driver' }],
  ['browser.form', { coveredBy: ['browser_inspect'], surface: 'driver' }],
  ['browser.form_fill', { coveredBy: ['browser_fill', 'browser_check', 'browser_select'], surface: 'driver' }],
  ['browser.form_submit', { coveredBy: ['browser_click'], surface: 'driver' }],
  ['agent.plan', { coveredBy: ['agent_plan'], surface: 'provider-host' }],
  ['agent.delegate', { coveredBy: ['agent_delegate'], surface: 'provider-host' }],
  ['team.run', { coveredBy: ['agent_plan', 'agent_delegate', 'agent_checkpoint'], surface: 'provider-host' }],
  ['majin.tools', { coveredBy: ['tools_search', 'driver_status'], surface: 'driver' }],
  ['majin.status', { coveredBy: ['majin_status'], surface: 'provider-host' }],
  ['majin.doctor', { coveredBy: ['majin_doctor'], surface: 'provider-host' }],
]);

export function parityCategory({ sourceName, lane, reason }) {
  const text = String(reason || '');
  if (/Windows-only|only on Windows|interactive Windows/i.test(text)) return 'platform';
  if (/no supported browser binary|configured media provider|vision\/desktop model/i.test(text)) return 'missing-dependency';
  if (/owner lane not granted|lane is not enabled/i.test(text)) return 'lane-not-granted';
  if (SERVICE_BOUND.some(([pattern]) => pattern.test(sourceName)) || /host service|host runtime service|legacy memory service/i.test(text) || String(lane).endsWith('-service')) return 'host-service';
  if (/legacy CDP browser surface is superseded/i.test(text)) return 'legacy-unported';
  return 'unregistered';
}

export function buildToolParity({ tools, hostBridge = { registered: [], skipped: [], selectedLanes: [] }, grantedLanes = null } = {}) {
  const skippedByTool = new Map();
  const skippedByLane = new Map();
  for (const item of hostBridge.skipped || []) {
    if (item.tool) skippedByTool.set(item.tool, item.reason);
    else if (item.lane && !skippedByLane.has(item.lane)) skippedByLane.set(item.lane, item.reason);
  }

  const entries = V5_TOOL_UNIVERSE.map((sourceName) => {
    const name = driverToolName(sourceName);
    const lane = laneForSourceTool(sourceName);
    const tool = tools.get(name);
    const available = Boolean(tool && (tool.source === sourceName || tool.source == null || String(tool.source).startsWith(sourceName)));
    if (available) return { sourceName, name, lane, available, category: 'available' };
    const service = SERVICE_BOUND.find(([pattern]) => pattern.test(sourceName));
    const selected = new Set(hostBridge.selectedLanes || []);
    const laneSelected = selected.has(lane) || (lane === 'browser' && selected.has('web'));
    const baseReason = skippedByTool.get(sourceName)
      || service?.[1]
      || skippedByLane.get(lane)
      || (Array.isArray(grantedLanes) && !grantedLanes.includes(lane) && !(lane === 'web' && grantedLanes.includes('browser'))
        ? `owner lane not granted: ${lane}`
        : !laneSelected && (Object.hasOwn(V1_LANES, lane) || lane === 'browser')
          ? `lane is not enabled for this driver: ${lane}`
          : 'not registered on this host; inspect lane capability and runtime requirements');
    const superseded = SUPERSEDED_TOOLS.get(sourceName);
    if (superseded) {
      return {
        sourceName, name, lane, available, category: 'superseded',
        coveredBy: [...superseded.coveredBy], surface: superseded.surface,
        reason: `capability provided by ${superseded.coveredBy.join(', ')} (${superseded.surface === 'driver' ? 'isolated driver' : 'provider host'}); the legacy name itself is not registered: ${baseReason}`,
      };
    }
    return { sourceName, name, lane, available, category: parityCategory({ sourceName, lane, reason: baseReason }), reason: baseReason };
  });

  const available = entries.filter((entry) => entry.available).length;
  const categories = {
    available,
    superseded: 0, platform: 0, 'missing-dependency': 0,
    'host-service': 0, 'lane-not-granted': 0, 'legacy-unported': 0, unregistered: 0,
  };
  for (const entry of entries) {
    if (!entry.available) categories[entry.category] = (categories[entry.category] || 0) + 1;
  }
  const capabilityCovered = available + categories.superseded;
  const percent = (value) => (entries.length ? Math.round((value / entries.length) * 1000) / 10 : 0);
  return {
    universe: entries.length,
    available,
    unavailable: entries.length - available,
    coveragePercent: percent(available),
    capabilityCovered,
    capabilityPercent: percent(capabilityCovered),
    categories,
    entries,
  };
}
