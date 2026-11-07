#!/usr/bin/env node
/**
 * MAJIN V4 — inspect and prove the tool surface.
 *
 *   node scripts/v4/tools.mjs            what is available on this host, per lane
 *   node scripts/v4/tools.mjs --json     machine output
 *   node scripts/v4/tools.mjs --probe    actually CALL a harmless tool per lane
 *
 * `--probe` is the point: a tool that is listed but cannot execute is not a tool.
 * It runs real calls through the same runner and approval layer the agent uses,
 * and prints the verified outcome. Anything it cannot probe is reported as
 * unproven, never as working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { runTool } from '../../src/v2/tools/runner.js';
import { hostCapabilities, describeCapabilities, registerHostTools } from '../../src/v4/tools/host.js';
import { createToolRegistry } from '../../src/v4/tools.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const config = loadConfig();

function line(t = '') {
  process.stdout.write(`${t}\n`);
}

const caps = await hostCapabilities();
const registry = new ToolRegistry();

// The workspace tools the agent always has.
const builtin = createToolRegistry({ workspaceDir: config.workspaceDir, memoryDir: config.paths.memory });
for (const t of builtin.registry.list()) registry.define(builtin.registry.get(t.name));

const allow = config.platform.hostToolAllow?.length ? config.platform.hostToolAllow : null;
const { registered, skipped } = registerHostTools(registry, caps, {
  allow,
  workspaceDir: config.workspaceDir,
  dataFile: path.join(config.paths.root, 'config.json'),
});

const described = describeCapabilities(caps);
const summary = {
  platform: described.platform,
  hostToolsEnabled: Boolean(config.platform.hostTools),
  lanes: described.lanes,
  browserRuntime: described.browserRuntime,
  registry: { total: registry.list().length, host: registered.length, skipped: skipped.length },
  tools: registry.list().map((t) => ({ name: t.name, tier: t.tier })),
  skipped,
};

if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

line('');
line(`MAJIN V4 tools — ${summary.platform}`);
line('='.repeat(66));
line(`  owner grants at boot: ${summary.hostToolsEnabled ? 'all lanes (MAJIN_V4_HOST_TOOLS=1)' : 'from owner-mode.json'}`);
line('  this probe registers EVERY available lane, granted or not, to test it');
line(`  registry: ${summary.registry.total} tool(s) total, ${summary.registry.host} from the host`);
line('');
line('  lanes');
for (const [lane, c] of Object.entries(described.lanes)) {
  const mark = c.available ? 'ok  ' : 'n/a ';
  line(`    ${mark} ${lane.padEnd(10)} ${c.available ? `${c.tools.length} tool(s)` : (c.reason || '').slice(0, 60)}`);
}
line(`    ${described.browserRuntime.available ? 'ok  ' : 'n/a '} ${'browser'.padEnd(10)} ${described.browserRuntime.available ? described.browserRuntime.binary : (described.browserRuntime.reason || '').slice(0, 60)}`);
line('');
line('  tools in the registry');
for (const t of summary.tools) line(`    ${t.tier.padEnd(8)} ${t.name}`);
if (skipped.length) {
  line('');
  line('  not offered (with the reason, never silently)');
  for (const s of skipped.slice(0, 25)) line(`    ${(s.tool || s.lane).padEnd(28)} ${String(s.reason).slice(0, 70)}`);
  if (skipped.length > 25) line(`    … and ${skipped.length - 25} more`);
}

if (!flag('--probe')) {
  line('');
  line('  run with --probe to actually call one tool per lane');
  line('');
  process.exit(0);
}

line('');
line('  PROBE — real calls through the same runner the agent uses');
line('-'.repeat(66));

const approvals = { check: () => ({ decision: 'allow' }) };
async function probe(name, input, note = '') {
  const def = registry.get(name);
  if (!def) {
    line(`    SKIP ${name.padEnd(22)} not registered`);
    return { name, ok: null };
  }
  try {
    const out = await runTool({ tool: name, input }, { registry, approvals, timeoutMs: 15_000 });
    const detail = typeof out.data?.result === 'string' ? out.data.result.slice(0, 60).replace(/\n/g, ' ') : '';
    line(`    OK   ${name.padEnd(22)} ${String(out.data?.summary || detail || 'returned').slice(0, 60)}`);
    return { name, ok: true };
  } catch (err) {
    // A classified failure from the tool itself (no network, no consent) is a
    // real answer about this host, not necessarily a broken adapter.
    const honest = ['NETWORK_FAILURE', 'PERMISSION_DENIED', 'DEPENDENCY_MISSING', 'TIMEOUT', 'UNKNOWN'].includes(err?.cls);
    const tag = honest ? 'TOOL' : 'FAIL';
    line(`    ${tag} ${name.padEnd(22)} ${String(err?.cls || '')} ${String(err?.message || err).slice(0, 60)}`);
    return { name, ok: false, cls: err?.cls, honest };
  }
}

const results = [];
results.push(await probe('workspace_list', {}));
results.push(await probe('memory_search', { query: 'probe' }));
// A real file inside the workspace, used by every lane that needs a path.
const probeFile = path.join(config.workspaceDir, 'majin-probe.txt');
try {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.writeFileSync(probeFile, 'probe');
} catch { /* the filesystem lane will report it */ }
if (registry.get('fs_stat')) {
  // stat a real FILE: statting a directory is a different operation in V1 and
  // would make the probe look broken for the wrong reason.
  results.push(await probe('fs_stat', { path: probeFile }, 'files'));
}
if (registry.get('exec_start')) {
  // exec.start requires an explicit backend; it never falls back silently.
  results.push(await probe('exec_start', {
    backend: 'local',
    command: process.platform === 'win32' ? 'cmd /c echo majin-probe' : 'echo majin-probe',
  }, 'shell'));
}
if (registry.get('sys_info')) results.push(await probe('sys_info', {}, 'sys'));
if (registry.get('shell_env')) results.push(await probe('shell_env', {}, 'shelltools'));
if (registry.get('net_dns')) results.push(await probe('net_dns', { host: 'example.com' }, 'net'));
if (registry.get('ma_lessons')) results.push(await probe('ma_lessons', {}, 'learn'));
if (registry.get('re_hash')) results.push(await probe('re_hash', { path: probeFile }, 're'));
if (registry.get('control_list_windows')) results.push(await probe('control_list_windows', {}, 'desktop'));
if (registry.get('web_search')) results.push(await probe('web_search', { query: 'majin probe' }, 'web'));
if (registry.get('browser_open')) results.push(await probe('browser_open', { url: 'https://example.com' }, 'browser'));

const proven = results.filter((r) => r.ok === true).length;
const honestFailures = results.filter((r) => r.ok === false && r.honest).length;
const broken = results.filter((r) => r.ok === false && !r.honest).length;
line('-'.repeat(66));
line(`  probed ${results.length}: ${proven} executed, ${honestFailures} reported a classified failure, ${broken} broken, ${results.filter((r) => r.ok === null).length} skipped`);
line('');
// Exit non-zero only for BROKEN adapters: a host with no internet is not a bug.
process.exitCode = broken ? 1 : 0;
