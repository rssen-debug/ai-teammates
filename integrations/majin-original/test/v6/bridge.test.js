import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, assertIsolatedState } from '../../src/v6/bridge.js';
import { EventLog } from '../../src/v6/events.js';
import { isAuthorized, filterCatalog, requiredLane } from '../../src/v6/policy.js';

class StubDriver {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.catalog = null;
    this.calls = [];
    this.closed = false;
    StubDriver.instances.push(this);
  }
  async start() {
    this.catalog = [
      {
        name: 'fs_read', source: 'fs.read', description: 'Read a file inside the workspace',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, operationId: { type: 'string' } },
          required: ['path', 'operationId'], additionalProperties: false,
        },
      },
      {
        name: 'shell_run', source: 'shell.run', description: 'Run a shell command',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' }, operationId: { type: 'string' } },
          required: ['command', 'operationId'], additionalProperties: false,
        },
      },
    ];
  }
  list() { return this.catalog || []; }
  async call(name, args) {
    this.calls.push({ name, args });
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'completed' }) }],
      structuredContent: { status: 'completed', result: { ok: true }, operationId: args.operationId, evidence: [] },
      isError: false,
    };
  }
  async close() { this.closed = true; }
}

function fixture(t, { lanes = ['files'], folders } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'v5');
  const v6Home = path.join(root, 'v6');
  const workspace = path.join(root, 'workspace');
  for (const dir of [dataDir, v6Home, workspace]) fs.mkdirSync(dir, { recursive: true });
  const owner = { lanes: [...lanes], folders: folders || [workspace] };
  const log = new EventLog(path.join(v6Home, 'events'));
  StubDriver.instances = [];
  const bridge = createBridge({
    workspace, dataDir, v6Home, Driver: StubDriver, getOwner: () => owner, log,
  });
  return { root, dataDir, v6Home, workspace, owner, bridge, log };
}

test('policy maps tools to lanes and requires an explicit owner grant', () => {
  assert.equal(requiredLane({ name: 'fs_read' }), 'files');
  assert.equal(requiredLane({ name: 'shell_run' }), 'shelltools');
  assert.equal(requiredLane({ name: 'driver_status' }), 'meta');
  assert.equal(isAuthorized({ name: 'driver_status' }, []), true);
  assert.equal(isAuthorized({ name: 'fs_read' }, []), false);
  assert.equal(isAuthorized({ name: 'fs_read' }, ['files']), true);
  assert.equal(isAuthorized({ name: 'web_fetch' }, ['research']), true, 'research covers the legacy web lane');
  const catalog = [
    { name: 'fs_read', description: 'read a file' },
    { name: 'shell_run', description: 'run a command' },
  ];
  assert.deepEqual(filterCatalog(catalog, ['files'], '', 10).map((entry) => entry.name), ['fs_read']);
});

test('the bridge lists only authorized tools and never sends operationId inside arguments', async (t) => {
  const { bridge, workspace } = fixture(t, { lanes: ['files'] });
  const status = await bridge.operate('majin_status');
  const statusValue = JSON.parse(status.content[0].text);
  assert.equal(statusValue.registered, 2);
  assert.equal(statusValue.authorized, 1);
  assert.equal(statusValue.ownerGrantedLanes.join(','), 'files');
  assert.ok(statusValue.driverStateDir.startsWith(path.join(path.dirname(workspace), 'v6')));

  const search = await bridge.operate('majin_tools_search', { query: 'read' });
  assert.deepEqual(JSON.parse(search.content[0].text).matches.map((entry) => entry.name), ['fs_read']);

  const schema = await bridge.operate('majin_tool_schema', { name: 'fs_read' });
  const schemaValue = JSON.parse(schema.content[0].text);
  assert.deepEqual(schemaValue.inputSchema.required, ['path']);
  assert.equal(schemaValue.inputSchema.properties.operationId, undefined);

  const denied = await bridge.operate('majin_tool_call', {
    name: 'shell_run', operationId: 'op-denied', arguments: { command: 'whoami' },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error, 'TOOL_NOT_AUTHORIZED');

  const allowed = await bridge.operate('majin_tool_call', {
    name: 'fs_read', operationId: 'op-1', arguments: { path: 'a.txt' },
  });
  assert.equal(allowed.isError, false);
  assert.equal(allowed.structuredContent.status, 'completed');
  const driver = StubDriver.instances.at(-1);
  assert.deepEqual(driver.calls, [{ name: 'fs_read', args: { path: 'a.txt', operationId: 'op-1' } }]);

  const nested = await bridge.operate('majin_tool_call', {
    name: 'fs_read', operationId: 'op-2', arguments: { path: 'a.txt', operationId: 'nested' },
  });
  assert.equal(JSON.parse(nested.content[0].text).error, 'INVALID_ARGUMENTS');
});

test('changing grants rebuilds the driver so revocation and new lanes take effect', async (t) => {
  const { bridge, owner } = fixture(t, { lanes: ['files'] });
  await bridge.operate('majin_status');
  assert.equal(StubDriver.instances.length, 1);
  const firstDriver = StubDriver.instances[0];

  owner.lanes = ['files', 'shelltools'];
  const status = await bridge.operate('majin_status');
  assert.equal(JSON.parse(status.content[0].text).authorized, 2);
  assert.equal(StubDriver.instances.length, 2, 'a new driver is built from the current owner file');
  assert.equal(firstDriver.closed, true, 'the stale driver is closed');

  owner.lanes = [];
  const revoked = await bridge.operate('majin_tool_call', {
    name: 'fs_read', operationId: 'op-revoked', arguments: { path: 'a.txt' },
  });
  assert.equal(JSON.parse(revoked.content[0].text).error, 'TOOL_NOT_AUTHORIZED');
  const meta = await bridge.operate('majin_tools_search', { query: 'fs' });
  assert.equal(JSON.parse(meta.content[0].text).matches.length, 0);
});

test('the worker tool path uses the same authorization boundary', async (t) => {
  const { bridge, owner } = fixture(t, { lanes: ['files'] });
  await assert.rejects(
    () => bridge.callTool('shell_run', { command: 'whoami', operationId: 'op-x' }),
    (error) => error.code === 'TOOL_NOT_AUTHORIZED',
  );
  const response = await bridge.callTool('fs_read', { path: 'a', operationId: 'op-y' });
  assert.equal(response.structuredContent.operationId, 'op-y');
  await assert.rejects(
    () => bridge.callTool('fs_read', { path: 'a' }),
    (error) => error.code === 'INVALID_ARGUMENTS',
  );
  owner.lanes = ['files'];
});

test('V6 state can never share the V5 data directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => assertIsolatedState({ dataDir: root, v6Home: root }), (error) => error.code === 'V6_HOME_CONFLICT');
  assert.throws(() => assertIsolatedState({ dataDir: root, v6Home: path.join(root, 'v6') }), (error) => error.code === 'V6_HOME_CONFLICT');
  assert.throws(() => createBridge({
    workspace: root, dataDir: path.join(root, 'missing-v5'), v6Home: path.join(root, 'v6'), Driver: StubDriver,
  }), (error) => error.code === 'V5_DATA_MISSING');
  assert.ok(!fs.existsSync(path.join(root, 'missing-v5')), 'V6 must not create a V5 profile');
});
