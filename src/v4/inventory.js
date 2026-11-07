/**
 * MAJIN V4 — executable capability inventory.
 *
 * The owner asked for a full inventory of every tool, skill, MCP integration,
 * agent feature, computer-control, browser, terminal, memory, voice,
 * automation and multi-agent capability in V1–V4, with every reuse decision
 * recorded. A markdown table written by hand would be a claim. This module
 * computes the inventory from the code:
 *
 *   - V1: every `src/core/tools/*.js` module is imported and its tool arrays
 *     are read. A module with no decision (lane or exclusion + reason) makes
 *     the command fail, so a new tool can never be silently forgotten.
 *   - V2/V3: every file under `src/v2` and `src/v3` is checked for an import
 *     from `src/v4`. Reused means an actual import path exists, not that
 *     somebody remembered it.
 *   - V4: the live registry on this host (built-ins + available lanes), the
 *     shipped skills and the MCP configuration.
 *
 * Nothing here executes a host tool; it reads the same capability map the
 * server uses at boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { V1_LANES, LANE_EXPORTS, hostCapabilities } from './tools/host.js';

/**
 * Every V1 tool module must appear here OR be mapped to a lane in V1_LANES.
 * `lane` modules with several lanes (net.js) are handled by the lane map.
 */
export const V1_MODULE_DECISIONS = Object.freeze({
  'agent.js': {
    status: 'replaced',
    reason: 'V1 agent.plan/delegate/moa/approve are bound to V1\'s own loop, registry and guard. '
      + 'V4 provides the same capability natively (agent_delegate) with its own approval policy; '
      + 'running V1\'s second agent runtime inside V4 would duplicate state and bypass receipts.',
  },
  'meta.js': {
    status: 'replaced',
    reason: 'tools.search needs V1\'s registry.search. V4 ships tools_search/tools_activate over the '
      + 'live V4 registry, which also makes discovered tools callable in the next round.',
  },
  'majin.js': {
    status: 'excluded',
    reason: 'Self-configuration writes V1\'s config.json and restarts V1\'s agent. V4 has its own '
      + 'setup, doctor, owner-mode and updater. Adapting these would let the model edit the wrong '
      + 'configuration while appearing to manage MAJIN.',
  },
  'heartbeat.js': {
    status: 'replaced',
    reason: 'The existing core Heartbeat engine is reused by src/v4/heartbeat.js with actual V4 '
      + 'goal/approval events, durable queue and shared-history/opt-in push delivery. The old tool '
      + 'wrapper uses V1 journal events and is not a second V4 heartbeat owner.',
  },
  'memory-sync.js': {
    status: 'replaced',
    reason: 'The existing core memory-sync entry point now supports canonical V2 namespaced records. '
      + 'V4 memory_sync uses that engine and MemoryStore with approval, folder checks and tombstones. '
      + 'The old wrapper assumes V1 text facts and is not used to create a shadow V4 store.',
  },
  'reset.js': {
    status: 'excluded',
    reason: 'Deletes artifacts measured by V1 recovery inside a shared data dir. V4 reconciles its '
      + 'own goals and must never run destructive V1 recovery on paths it does not own.',
  },
  'teams.js': {
    status: 'replaced',
    reason: 'The V1 tool wrapper binds team.run to V1\'s loop and registry. Its ENGINE '
      + '(src/core/teams.js: TeamStore, runTeam) and the scheduler behind it (src/core/swarm.js) '
      + 'are reused verbatim by V4\'s team_run, with V4 subagents as the worker.',
  },
  'browser.js': {
    status: 'replaced',
    reason: 'These Playwright-Core browser tools own a separate persistent browser profile and '
      + 'session. V4 exposes browser work through its own browser lane and form engine, while '
      + 'V5 uses this module directly in its deterministic driver; registering both in V4 would '
      + 'create two competing browser sessions and duplicate form/submission state.',
  },
  'desktop-app.js': {
    status: 'replaced',
    reason: 'The Notepad/window-capture helpers are narrow V5 deterministic-driver adapters. '
      + 'V4 already exposes the general Windows desktop and screen lanes through wincontrol '
      + 'and net/screen tools, so adding these wrappers in V4 would duplicate the same host '
      + 'effects under a second contract instead of improving capability coverage.',
  },
  'media.js': {
    status: 'excluded',
    reason: 'Image and speech generation need the configured provider/media service, credentials '
      + 'and model routing owned outside the deterministic V1 tool wrapper. V4 keeps those '
      + 'capabilities on its provider/voice surfaces; adapting media.* here would either fail '
      + 'without that service context or bypass V4 provider selection and accounting.',
  },
  'plugins.js': {
    status: 'replaced',
    reason: 'The legacy plugin wrapper manages V1 plugin state directly. V4 loads plugins through '
      + 'its kernel and sandboxed PluginWorker, then registers their tools in the same registry '
      + 'with V4 schema validation, approvals and receipts; the V1 management wrapper must not '
      + 'become a second plugin owner inside the V4 host.',
  },
});

const V2_REASONS = Object.freeze({
  'src/v2/runtime/orchestrator.js': 'Drives V2\'s compile→plan→schedule→verify pipeline. V4\'s agent loop owns planning and verification; running it would be a second orchestrator.',
  'src/v2/runtime/scheduler.js': 'V4 runs one durable goal per turn; the DAG scheduler is for V2 multi-task graphs that V4 does not compile.',
  'src/v2/runtime/dag.js': 'Task-graph model used by the V2 scheduler, which V4 does not run.',
  'src/v2/runtime/verify-bridge.js': 'Bridges V2 acceptance to V2 verifiers; V4 calls runVerifier directly.',
  'src/v2/runtime/events.js': 'V2 studio event bus; V4 streams SSE from the agent.',
  'src/v2/compiler/router.js': 'V2 intent compiler targets V2 tool vocabulary and orchestration.',
  'src/v2/supervisor/supervisor.js': 'Plans V2 task graphs for the V2 scheduler.',
  'src/v2/supervisor/plan-with-model.js': 'Model-assisted V2 planning; V4 plans inside the conversation turn.',
  'src/v2/studio/server.js': 'Desktop operator surface without a session model (rejected in SOURCE_AUDIT).',
  'src/v2/ops/doctor.js': 'All checks are V2-specific (V2 binary, OpenCode key, Studio port).',
  'src/v2/gauntlet/harness.js': 'V2 test gauntlet, not a runtime capability.',
  'src/v2/gauntlet/runner.js': 'V2 test gauntlet, not a runtime capability.',
  'src/v2/spawn/safe-exec.js': 'Runs operator-supplied adapter templates. V4 does not run adapters, and exec tools go through the approval layer.',
  'src/v2/exec/local.js': 'V2 executor used by the V2 scheduler; V4 uses V1 exec.* through the same runner.',
  'src/v2/exec/docker.js': 'V2 executor used by the V2 scheduler; no V4 caller.',
  'src/v2/exec/runner.js': 'V2 executor used by the V2 scheduler; no V4 caller.',
  'src/v2/config/schema.js': 'V2 configuration schema; V4 has its own config contract.',
  'src/v2/config/load.js': 'V2 configuration loader; V4 has its own config contract.',
  'src/v2/model/provider.js': 'V2 model provider; V4 uses V1\'s proven provider transports.',
  'src/v2/telemetry/aggregate.js': 'Renders V2\'s report; V4 reads the ledger directly.',
  'src/v2/audit/export.js': 'V2 audit bundle format is reused as a format and documented in SOURCE_AUDIT, not imported; V4 backup has its own manifest + verify path.',
  'src/v2/audit/index.js': 'V2 cryptographic audit chain (hash chain, anchors). V4\'s audit trail is goal receipts + the V2 telemetry ledger.',
  'src/v2/audit/chain.js': 'V2 hash-chained audit log; only the V2 audit bundle uses it.',
  'src/v2/audit/bind.js': 'Binds the V2 audit chain to an operator identity; V4 sessions are their own identity model.',
  'src/v2/audit/anchor.js': 'RFC 3161 anchoring for the V2 audit chain; no V4 caller.',
  'src/v2/audit/timestamp.js': 'Timestamp helpers for the V2 audit chain; no V4 caller.',
  'src/v2/audit/permissions.js': 'Protects V2 audit keys and chain files with POSIX modes or NTFS ACLs. V4 cryptographic audit integration remains an explicit release blocker; this helper alone does not establish V4 audit parity.',
  'src/v2/compiler/goal-compiler.js': 'Compiles natural language into V2 task graphs; V4 plans inside the conversation turn.',
  'src/v2/config/config.js': 'Trust-gated V2 config loader. V4\'s configuration is explicit and env-overridable.',
  'src/v2/exec/approval-modes.js': 'Execution approval modes for the V2 executor. V4 uses V2\'s Approvals + runner directly.',
  'src/v2/exec/sandbox.js': 'Sandbox for the V2 executor; V4 does not spawn via the V2 executor.',
  'src/v2/exec/whitelist.js': 'Command whitelisting for the V2 executor; V4\'s shell tools run through V1\'s executor and V4 approvals.',
  'src/v2/gauntlet/gauntlet.js': 'V2 test gauntlet, not a runtime capability.',
  'src/v2/gauntlet/scenarios.js': 'V2 test scenarios, not a runtime capability.',
  'src/v2/gauntlet/scenarios-objectives.js': 'V2 test scenarios, not a runtime capability.',
  'src/v2/model/profiles.js': 'V2 model profiles; V4 resolves models from V1\'s provider catalog.',
  'src/v2/model/registry.js': 'V2 model failover/circuit registry; V4 uses V1\'s transport and V4\'s model cache.',
  'src/v2/model/registry-refresh.js': 'Refreshes the V2 model registry; V4 caches the V1 catalog instead.',
  'src/v2/recover/outer-loop.js': 'Drives V2\'s runObjective; V4 runs its own loop and reuses only recover/advisor.js.',
  'src/v2/runtime/errors.js': 'Failure vocabulary is mirrored in V4\'s WorkspaceError mapping; the module is imported only by the V2 scheduler, which V4 does not run.',
  'src/v2/studio/page.js': 'UI for the V2 studio server, which V4 rejected for having no session model.',
  'src/v2/supervisor/roles.js': 'Planning roles for the V2 supervisor, which V4 does not run.',
  'src/v2/tools/builtins.js': 'V2\'s read_file/write_file/verify_now demo tools; V4 defines its own workspace tools on the same V2 contract.',
});

const V3_REASONS = Object.freeze({
  'src/v3/server.js': 'V3\'s single-purpose HTTP server (one file deliverable). V4\'s server supersedes it.',
  'src/v3/ui/page.js': 'V3\'s static page for the file-deliverable demo; V4 has the PWA.',
  'src/v3/runtime/file-deliverable.js': 'V3\'s file vertical slice is V4\'s workspace_write + V2 file verifier, with approvals and receipts added.',
  'src/v3/platform/runtime.js': 'Node >= 22 check; V4 performs the same check in assertNodeSupported().',
});

function listFiles(dir, suffix = '.js') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Real import specifiers only — a path mentioned in a comment is not a reuse. */
function importSpecifiers(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

function buildImportGraph({ root }) {
  const v2Files = listFiles(path.join(root, 'src', 'v2'), '.js');
  const v3Files = listFiles(path.join(root, 'src', 'v3'), '.js');
  const v4Files = listFiles(path.join(root, 'src', 'v4'), '.js');
  const parents = new Map();
  const add = (target, importer) => {
    if (!parents.has(target)) parents.set(target, new Set());
    parents.get(target).add(importer);
  };
  for (const file of [...v2Files, ...v3Files, ...v4Files]) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target)) add(target, file);
    }
  }
  // Seeds are imported directly by V4 code; the rest of a seed's own tree is
  // reused transitively (a reused runner's error module is reused too).
  const reused = new Set();
  const queue = [];
  for (const file of v4Files) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target) && !reused.has(target)) {
        reused.add(target);
        queue.push(target);
      }
    }
  }
  while (queue.length) {
    const file = queue.pop();
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target) && !reused.has(target)) {
        reused.add(target);
        queue.push(target);
      }
    }
  }
  return { parents, reused };
}

/** Which lane(s) serve a V1 module file, and which tools they include. */
function lanesFor(moduleFile) {
  const out = [];
  for (const [lane, spec] of Object.entries(V1_LANES)) {
    if (spec.module.endsWith(`/${moduleFile}`)) out.push({ lane, ...spec });
  }
  return out;
}

export async function readV1Modules({ root, reusedFiles = new Map() }) {
  const dir = path.join(root, 'src', 'core', 'tools');
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !['index.js', 'registry.js'].includes(f))
    .sort();
  const modules = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href).catch((err) => ({ __error: String(err?.message || err) }));
    if (mod.__error) {
      modules.push({ file, error: mod.__error, tools: [], decision: { status: 'undecided', reason: null } });
      continue;
    }
    const arrays = Object.entries(mod).filter(([, v]) => Array.isArray(v) && v.length && v[0]?.name);
    const tools = [];
    for (const [exportName, list] of arrays) {
      for (const tool of list) {
        tools.push({ name: tool.name, risk: tool.risk || 'read', exportName });
      }
    }
    const lanes = lanesFor(file);
    // A module imported directly by V4 code is reused as an ENGINE, not as a
    // lane. That is how teams.js (TeamStore + runTeam) is used now, and the
    // inventory has to say so instead of calling it "replaced".
    const importedBy = [...(reusedFiles.get(path.join(dir, file)) || [])];
    const decision = importedBy.length
      ? { status: 'reused-engine', reason: `imported by ${importedBy.slice(0, 3).join(', ')}` }
      : lanes.length
        ? { status: 'lane', reason: `reused through ${lanes.map((l) => l.lane).join(', ')}` }
        : (V1_MODULE_DECISIONS[file] || { status: 'undecided', reason: null });

    const registered = new Set();
    for (const lane of lanes) {
      for (const tool of tools) {
        if (Array.isArray(lane.only) && !lane.only.includes(tool.name)) continue;
        registered.add(tool.name);
      }
    }
    modules.push({
      file,
      exportNames: arrays.map(([name]) => name),
      tools: tools.map((t) => {
        const serving = lanes.filter((l) => !l.only || l.only.includes(t.name));
        const requires = /^browser\./.test(t.name)
          ? 'browser runtime'
          : (serving.some((l) => l.windowsOnly) ? 'windows interactive session' : null);
        return {
          ...t,
          status: registered.has(t.name)
            ? 'integrated'
            : (lanes.length ? 'not-in-any-lane' : 'excluded'),
          lanes: serving.map((l) => l.lane),
          requires,
        };
      }),
      lanes: lanes.map((l) => ({ lane: l.lane, windowsOnly: Boolean(l.windowsOnly), only: l.only || null })),
      decision,
    });
  }
  return modules;
}

function readVersionComponents({ root, version, reasons, graph }) {
  const base = path.join(root, 'src', version);
  return listFiles(base, '.js')
    .sort()
    .map((full) => {
      const rel = path.relative(root, full).split(path.sep).join('/');
      const importedBy = [...(graph.parents.get(full) || [])]
        .map((f) => path.relative(root, f).split(path.sep).join('/'))
        .sort();
      const reason = reasons[rel] || null;
      return {
        path: rel,
        status: graph.reused.has(full) ? 'reused' : (reason ? 'not-used' : 'undecided'),
        importedBy,
        reason: graph.reused.has(full)
          ? (importedBy.length ? `imported by ${importedBy.join(', ')}` : 'imported by V4')
          : reason,
      };
    });
}

async function readV4Surface({ root, platform }) {
  const { createToolRegistry } = await import('./tools.js');
  const home = path.join(root, '.inventory-home');
  fs.mkdirSync(path.join(home, 'ws'), { recursive: true });
  fs.mkdirSync(path.join(home, 'mem'), { recursive: true });
  const builtin = createToolRegistry({ workspaceDir: path.join(home, 'ws'), memoryDir: path.join(home, 'mem') });
  const builtinTools = builtin.registry.list().map((t) => ({ name: t.name, tier: t.tier }));
  const caps = await hostCapabilities({ platform });
  const lanes = Object.entries(caps.lanes).map(([lane, cap]) => ({
    lane,
    available: Boolean(cap.available),
    reason: cap.reason || null,
    tools: cap.tools || [],
  }));
  const skillsDir = path.join(root, 'src', 'v4', 'skills');
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((n) => fs.existsSync(path.join(skillsDir, n, 'skill.json')))
    : [];
  fs.rmSync(home, { recursive: true, force: true });
  return { builtinTools, lanes, browserRuntime: caps.browserRuntime, skills };
}

/**
 * The eleven capability domains the owner asked about, answered from the
 * inventory rather than from prose. Each row names the concrete modules and
 * whether this host can execute them.
 */
function capabilityDomains(inv) {
  const lane = (name) => inv.v4.lanes.find((l) => l.lane === name) || { available: false, tools: [], reason: 'lane not defined' };
  const toolsIn = (names) => names.flatMap((n) => lane(n).tools || []);
  return {
    tools: {
      builtin: inv.v4.builtinTools,
      v1Integrated: inv.v1.totals.integrated,
      registeredOnHost: inv.v4.registeredOnThisHost,
    },
    skills: {
      shipped: inv.v4.skills,
      mechanism: 'src/v4/skills.js — declared required/preferred tools decide visibility, not app code',
      learned: 'src/v4/learning.js — procedures extracted from goals that completed with an independently '
        + 'verified receipt; stored in the same skills directory with a `learned` block, so one loader '
        + 'serves both. States: EXPERIMENTAL, VERIFIED, REUSABLE, STALE, FAILED.',
      learnedAcceptance: 'npm run v4:learn-accept — the mandatory A–H gate against the real provider',
    },
    mcp: {
      state: inv.v4.mcp,
      mechanism: 'src/v4/mcp.js + mcp-tools.js — stdio JSON-RPC, scrubbed env, tools at process tier',
    },
    agentFunctions: {
      turnEngine: 'src/v4/agent.js — goal, rounds, receipts, verification, recovery advisor',
      discovery: 'tools_search + tools_activate (src/v4/tool-exposure.js)',
      delegation: 'agent_delegate — bounded subagent, owner-gated',
      resume: 'resumeGoal — re-verifies every artifact against the recorded SHA-256',
    },
    computerControl: {
      lanes: ['desktop', 'computer', 'screen'].map((n) => ({ lane: n, available: lane(n).available, tools: lane(n).tools.length, reason: lane(n).reason })),
      mechanism: 'V1 wincontrol.js / computer.js through the V1 lane adapter; Windows interactive session only',
    },
    browser: {
      lane: 'web',
      tools: toolsIn(['web']).filter((t) => t.startsWith('browser.')),
      runtime: inv.v4.browserRuntime,
    },
    terminal: {
      lanes: ['shell', 'shelltools'].map((n) => ({ lane: n, available: lane(n).available, tools: lane(n).tools.length })),
      mechanism: 'V1 exec.js (managed jobs) and shell.js (command/background) through the V2 runner and approvals',
    },
    memory: {
      tools: ['memory_save', 'memory_search'],
      store: 'src/v2/memory/store.js (used directly)',
      promptInjection: 'src/v4/memory.js memoryForPrompt — retrieval, not just writes',
    },
    voice: {
      server: 'src/v2/voice/{speak,listen,tts,stt}.js imported by src/v4/voice.js',
      client: 'browser-native speech + text fallback (src/v4/ui/voice.js)',
      measured: false,
    },
    automation: {
      flows: lane('flows').tools.length,
      supervisor: 'src/v4/supervisor.js — crash recovery and health checks',
      updater: 'signed release, overlay activation, journal recovery, daily Windows task',
      scheduler: 'Windows Task Scheduler (logon host + daily update)',
    },
    multiAgent: {
      implemented: 'agent_delegate (1 level), agent_graph (V2 DAG), team_run (V1 standing teams, resumable)',
      teams: 'V1 TeamStore + runTeam + runSwarm reused unchanged; members executed by V4 subagents',
      graph: 'V2 TaskGraph + runGraph reused unchanged, executed by V4 subagents',
      notUsed: 'V2 orchestrator/compiler/supervisor (they compile and plan for the V2 loop, which V4 does not run)',
    },
  };
}

export async function buildInventory({ root = process.cwd(), platform = process.platform } = {}) {
  const graph = buildImportGraph({ root });
  // Direct importer map for src/core (and src/v2) files -> V4 files that use them.
  const directImporters = new Map();
  for (const file of listFiles(path.join(root, 'src', 'v4'), '.js')) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) continue;
      if (!directImporters.has(target)) directImporters.set(target, []);
      directImporters.get(target).push(path.relative(root, file).split(path.sep).join('/'));
    }
  }

  const v1Modules = await readV1Modules({ root, reusedFiles: directImporters });
  // V1's engines (not its tool wrappers): src/core/*.js used directly by V4.
  // The architect's report counted only tool lanes, which made the reuse of
  // TeamStore/runTeam/runSwarm invisible.
  const coreDir = path.join(root, 'src', 'core');
  const v1Engines = fs.readdirSync(coreDir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const importedBy = [...(directImporters.get(path.join(coreDir, f)) || [])];
      return { path: `src/core/${f}`, status: importedBy.length ? 'reused' : 'not-used', importedBy };
    });
  const v2 = readVersionComponents({ root, version: 'v2', reasons: V2_REASONS, graph });
  const v3 = readVersionComponents({ root, version: 'v3', reasons: V3_REASONS, graph });
  const v4 = await readV4Surface({ root, platform });

  const v1Tools = v1Modules.flatMap((m) => m.tools);
  const undecided = [
    ...v1Modules.filter((m) => m.decision.status === 'undecided').map((m) => `src/core/tools/${m.file}`),
    ...v2.filter((c) => c.status === 'undecided').map((c) => c.path),
    ...v3.filter((c) => c.status === 'undecided').map((c) => c.path),
  ];

  const laneTools = v1Modules.flatMap((m) => m.tools.filter((t) => t.status === 'integrated'));

  const inventory = {
    schema: 'majin.v4.capability-inventory/v1',
    generatedAt: new Date().toISOString(),
    platform,
    v1: {
      modules: v1Modules,
      totals: {
        modules: v1Modules.length,
        tools: v1Tools.length,
        integrated: v1Tools.filter((t) => t.status === 'integrated').length,
        excluded: v1Tools.filter((t) => t.status === 'excluded').length,
        lanes: new Set(laneTools.flatMap((t) => t.lanes)).size,
      },
    },
    v1Engines,
    v2: {
      components: v2,
      totals: {
        components: v2.length,
        reused: v2.filter((c) => c.status === 'reused').length,
        notUsed: v2.filter((c) => c.status === 'not-used').length,
      },
    },
    v3: {
      components: v3,
      totals: {
        components: v3.length,
        reused: v3.filter((c) => c.status === 'reused').length,
        notUsed: v3.filter((c) => c.status === 'not-used').length,
      },
    },
    v4: {
      builtinTools: v4.builtinTools.length,
      registeredOnThisHost: v4.builtinTools.length + v4.lanes.filter((l) => l.available).reduce((n, l) => n + l.tools.length, 0),
      lanes: v4.lanes,
      browserRuntime: v4.browserRuntime,
      skills: v4.skills,
      mcp: fs.existsSync(path.join(root, 'v4', 'mcp.json')) ? 'config present' : 'configured by the owner in <data>/v4/mcp.json',
    },
    undecided,
  };
  inventory.domains = capabilityDomains(inventory);
  return inventory;
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderInventoryMarkdown(inv) {
  const lines = [];
  lines.push('# MAJIN capability inventory (generated)');
  lines.push('');
  lines.push(`Generated ${inv.generatedAt} on ${inv.platform}. Every row is computed from the code; `
    + 'a module without a recorded decision fails `npm run v4:inventory`.');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(mdTable(['Version', 'Unit', 'Count'], [
    ['V1', 'tool modules', inv.v1.totals.modules],
    ['V1', 'tools', inv.v1.totals.tools],
    ['V1', 'integrated into V4 lanes', inv.v1.totals.integrated],
    ['V1', 'excluded with a recorded reason', inv.v1.totals.excluded],
    ['V2', 'components reused', `${inv.v2.totals.reused}/${inv.v2.totals.components}`],
    ['V3', 'components reused', `${inv.v3.totals.reused}/${inv.v3.totals.components}`],
    ['V4', 'built-in tools', inv.v4.builtinTools],
    ['V4', 'tools registered on this host', inv.v4.registeredOnThisHost],
  ]));
  lines.push('');
  if (inv.domains) {
    lines.push('## Capability domains');
    lines.push('');
    const rows = [];
    for (const [name, value] of Object.entries(inv.domains)) {
      const summary = typeof value === 'object' && value !== null
        ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')
        : String(value);
      rows.push([name, summary.replace(/\|/g, '\\|')]);
    }
    lines.push(mdTable(['Domain', 'What exists'], rows));
    lines.push('');
  }
  lines.push('## V1 tool modules');
  lines.push('');
  lines.push(mdTable(['Module', 'Tools', 'Lanes', 'Decision', 'Reason'], inv.v1.modules.map((m) => [
    `\`${m.file}\``,
    m.tools.length,
    m.lanes.map((l) => l.lane).join(', ') || '—',
    m.decision.status,
    (m.decision.reason || 'UNDECIDED').replace(/\|/g, '\\|'),
  ])));
  lines.push('');
  lines.push('## V1 tools');
  lines.push('');
  lines.push(mdTable(['Tool', 'Risk', 'Status', 'Lane', 'Requires'], inv.v1.modules.flatMap((m) => m.tools.map((t) => [
    `\`${t.name}\``, t.risk, t.status, t.lanes.join(', ') || '—', t.requires || '—',
  ]))));
  lines.push('');
  if (Array.isArray(inv.v1Engines)) {
    const reused = inv.v1Engines.filter((e) => e.status === 'reused');
    lines.push('## V1 engines reused directly');
    lines.push('');
    lines.push(mdTable(['Engine', 'Status', 'Imported by'], reused.map((e) => [
      `\`${e.path}\``, e.status, e.importedBy.join(', ') || '—',
    ])));
    lines.push('');
  }
  lines.push('## V2 components');
  lines.push('');
  lines.push(mdTable(['Component', 'Status', 'Reason'], inv.v2.components.map((c) => [
    `\`${c.path}\``, c.status, String(c.reason || 'UNDECIDED').replace(/\|/g, '\\|'),
  ])));
  lines.push('');
  lines.push('## V3 components');
  lines.push('');
  lines.push(mdTable(['Component', 'Status', 'Reason'], inv.v3.components.map((c) => [
    `\`${c.path}\``, c.status, String(c.reason || 'UNDECIDED').replace(/\|/g, '\\|'),
  ])));
  lines.push('');
  lines.push('## V4 lanes on this host');
  lines.push('');
  lines.push(mdTable(['Lane', 'Available', 'Tools', 'Reason'], inv.v4.lanes.map((l) => [
    l.lane, l.available ? 'yes' : 'no', l.tools.length, String(l.reason || '').replace(/\|/g, '\\|'),
  ])));
  lines.push('');
  if (inv.undecided.length) {
    lines.push('## UNDECIDED (must be zero)');
    lines.push('');
    for (const item of inv.undecided) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n');
}
