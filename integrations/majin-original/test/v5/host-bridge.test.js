import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriverTools } from '../../src/v5/codex-tools.js';
import { CodexDriver } from '../../src/v5/codex-driver.js';
import { V5_TOOL_UNIVERSE, selectedHostLanes } from '../../src/v5/host-bridge.js';

const ALL_OWNER_LANES = [
  'files', 'shell', 'shelltools', 'sys', 'power', 'web', 'research', 'jobs', 'flows', 'github',
  'channels', 'audit', 'learn', 'marketing', 're', 'trading', 'net', 'agent', 'desktop', 'screen',
  'computer', 'browser', 'mcp',
];

function workspaceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-host-bridge-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return workspace;
}

test('host lane selection is owner-scoped and maps the browser grant to the legacy web lane', () => {
  assert.deepEqual(selectedHostLanes({ grantedLanes: [] }), []);
  assert.deepEqual(selectedHostLanes({ grantedLanes: ['sys', 'browser'] }), ['sys', 'web']);
  assert.deepEqual(selectedHostLanes({ grantedLanes: ['shell', 'desktop'], processAccess: false, desktop: false }), []);
  assert.deepEqual(selectedHostLanes({ grantedLanes: ['shell', 'desktop'], processAccess: true, desktop: true }), ['shell', 'desktop']);
  assert.deepEqual(selectedHostLanes({ grantedLanes: null, processAccess: true }), ['files', 'web', 'shell', 'shelltools']);
});

test('WP1 universal bridge exposes previously unreachable lanes and reports every unavailable tool with a reason', async (t) => {
  const workspace = workspaceFixture(t);
  fs.writeFileSync(path.join(workspace, 'sample.bin'), 'MAJIN universal bridge test\n');
  fs.writeFileSync(path.join(workspace, 'copy-source.txt'), 'copy-me');

  const tools = await createDriverTools({
    workspace,
    grantedLanes: ALL_OWNER_LANES,
    processAccess: true,
    browser: true,
    desktop: true,
  });

  for (const name of [
    'fs_copy', 'fs_move', 'fs_delete', 'web_download', 'sys_info', 'sys_ps', 'net_dns',
    'exec_backends', 'exec_start', 'shell_env', 'research_run', 'jobs_list', 'jobs_prepare',
    'jobs_send', 'flows_list', 'github_verify', 'channel_send', 'marketing_status',
    're_hash', 'trading_plan', 'tools_search',
  ]) {
    assert.ok(tools.has(name), `${name} must be reachable through the universal bridge`);
  }

  const status = (await tools.get('driver_status').run({})).result;
  assert.equal(V5_TOOL_UNIVERSE.length, 157);
  assert.equal(status.toolParity.universe, 157);
  assert.ok(status.toolParity.available >= 90, `expected at least 90 reachable universe tools, got ${status.toolParity.available}`);
  assert.ok(status.toolParity.unavailableTools.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 10));

  const sys = await tools.get('sys_info').run({});
  assert.equal(sys.ok, true);
  assert.match(String(sys.result), /workspace/);

  const hash = await tools.get('re_hash').run({ path: 'sample.bin' });
  assert.equal(hash.ok, true);
  assert.equal(hash.meta.hashes[0].sha256.length, 64);

  const copied = await tools.get('fs_copy').run({ from: 'copy-source.txt', to: 'copy-dest.txt' });
  assert.equal(copied.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'copy-dest.txt'), 'utf8'), 'copy-me');

  const moved = await tools.get('fs_move').run({ from: 'copy-dest.txt', to: 'moved.txt' });
  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(path.join(workspace, 'moved.txt')), true);

  const dryRun = await tools.get('channel_send').run({
    channel: 'webhook',
    url: 'https://example.invalid/hook',
    text: 'dry run only',
    dryRun: 'true',
  });
  assert.equal(dryRun.ok, true);
  assert.match(String(dryRun.result), /DRY-RUN webhook/);

  const found = (await tools.get('tools_search').run({ query: 're.hash', limit: 5 })).result;
  assert.equal(found.matches[0].sourceName, 're.hash');
  assert.equal(found.matches[0].available, true);
});

test('tool parity classifies every unavailable tool and names the current tool covering superseded capabilities', async (t) => {
  const workspace = workspaceFixture(t);
  const tools = await createDriverTools({
    workspace,
    grantedLanes: ALL_OWNER_LANES,
    processAccess: true,
    browser: true,
    desktop: true,
  });
  const status = (await tools.get('driver_status').run({})).result;
  const parity = status.toolParity;
  assert.equal(Object.values(parity.categories).reduce((sum, value) => sum + value, 0), parity.universe);
  assert.equal(parity.capabilityCovered, parity.available + parity.categories.superseded);
  assert.ok(parity.capabilityPercent >= parity.coveragePercent);
  assert.equal(parity.categories.unregistered, 0, 'every unavailable tool must carry a classified, concrete reason');
  const byName = new Map(parity.unavailableTools.map((entry) => [entry.sourceName, entry]));
  assert.equal(byName.get('browser.form_fill').category, 'superseded');
  assert.deepEqual(byName.get('browser.form_fill').coveredBy, ['browser_fill', 'browser_check', 'browser_select']);
  assert.equal(byName.get('agent.plan').category, 'superseded');
  assert.deepEqual(byName.get('agent.plan').coveredBy, ['agent_plan']);
  assert.equal(byName.get('agent.plan').surface, 'provider-host');
  assert.equal(byName.get('majin.tools').category, 'superseded');
  assert.equal(byName.get('majin.status').category, 'superseded');
  assert.deepEqual(byName.get('majin.status').coveredBy, ['majin_status']);
  assert.equal(byName.get('majin.status').surface, 'provider-host');
  assert.equal(byName.get('majin.doctor').category, 'superseded');
  assert.deepEqual(byName.get('majin.doctor').coveredBy, ['majin_doctor']);
  // Read-only subsets are useful, but they are not honest full replacements
  // for legacy tools that also mutate provider or memory state.
  assert.equal(byName.get('majin.provider').category, 'host-service');
  assert.equal(byName.get('majin.memory').category, 'host-service');
  const clearMarks = byName.get('browser.clear_marks');
  if (tools.has('browser_clear_marks')) assert.equal(clearMarks, undefined, 'Playwright clear_marks must be directly available when a browser binary exists');
  else assert.equal(clearMarks?.category, 'missing-dependency', 'without a browser binary, clear_marks is a concrete dependency gap, not an unported capability');
  const browserVerify = byName.get('browser.verify');
  if (tools.has('browser_verify')) assert.equal(browserVerify, undefined, 'Playwright browser_verify must be directly available when a browser binary exists');
  else assert.equal(browserVerify?.category, 'missing-dependency', 'browser_verify is a direct Playwright tool now; without a binary it is a dependency gap, not superseded by inspection');
  assert.equal(byName.get('media.speak').category, 'missing-dependency');
  assert.equal(byName.get('majin.configure').category, 'host-service');
  if (process.platform !== 'win32') assert.equal(byName.get('control.click_button').category, 'platform');
  // The model-facing search must lead to the covering tool, not a dead end.
  const found = (await tools.get('tools_search').run({ query: 'form_fill', limit: 5 })).result;
  const formFill = found.matches.find((entry) => entry.sourceName === 'browser.form_fill');
  assert.ok(formFill, `tools_search must surface browser.form_fill: ${JSON.stringify(found.matches)}`);
  assert.equal(formFill.category, 'superseded');
  assert.ok(formFill.coveredBy.includes('browser_fill'));
  assert.equal(found.capabilityCovered, parity.capabilityCovered);
});

test('universal bridge failures are structured observations and path policy stays enforced', async (t) => {
  const workspace = workspaceFixture(t);
  const tools = await createDriverTools({ workspace, grantedLanes: ['re'], processAccess: false });

  const denied = await tools.get('re_hash').run({ path: '../outside.bin' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PATH_DENIED');

  const invalid = await tools.get('re_hash').run({ path: 123 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error.code, /INVALID_TOOL_INPUT/);
});

test('without owner lanes the universal lanes stay closed but remain discoverable with concrete reasons', async (t) => {
  const workspace = workspaceFixture(t);
  const tools = await createDriverTools({ workspace, grantedLanes: [] });

  assert.equal(tools.has('sys_info'), false);
  assert.equal(tools.has('research_run'), false);
  assert.equal(tools.has('re_hash'), false);
  assert.equal(tools.has('tools_search'), true);

  const found = (await tools.get('tools_search').run({ query: 'research.run', limit: 5 })).result;
  assert.equal(found.matches[0].available, false);
  assert.match(found.matches[0].reason, /owner lane not granted: research/);
});

test('universal tools execute through the isolated V5 driver worker used by the live provider', async (t) => {
  const workspace = workspaceFixture(t);
  fs.writeFileSync(path.join(workspace, 'worker.bin'), 'worker bridge proof');
  const driver = new CodexDriver({
    workspace,
    stateDir: path.join(path.dirname(workspace), 'state'),
    grantedLanes: ['files', 'sys', 're'],
    controller: 'provider',
  });
  t.after(async () => driver.close());
  await driver.start();

  const advertised = new Set(driver.list().map((tool) => tool.name));
  assert.equal(advertised.has('sys_info'), true);
  assert.equal(advertised.has('re_hash'), true);
  assert.equal(advertised.has('tools_search'), true);

  const hash = await driver.call('re_hash', { operationId: 'worker-re-hash', path: 'worker.bin' });
  assert.equal(hash.isError, false, hash.content[0].text);
  assert.equal(hash.structuredContent.status, 'completed');
  assert.match(hash.content[0].text, /worker bridge proof|worker\.bin/);

  const found = await driver.call('tools_search', { operationId: 'worker-tools-search', query: 'sys.info', limit: 5 });
  assert.equal(found.isError, false, found.content[0].text);
  assert.match(found.content[0].text, /sys_info/);
});
