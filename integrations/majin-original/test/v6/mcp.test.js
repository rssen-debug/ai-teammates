import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue } from '../../src/v6/queue.js';
import { EventLog } from '../../src/v6/events.js';
import { createV6Server } from '../../src/v6/mcp.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(path.join(root, 'events'));
  const queue = new TaskQueue({ file: path.join(root, 'queue.json'), log });
  const bridge = {
    calls: [],
    cancelled: [],
    async operate(name, args) {
      this.calls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name }) }], isError: false };
    },
    async cancel(operationId) { this.cancelled.push(operationId); },
  };
  const server = createV6Server({
    bridge, queue, log, home: root,
    workersDir: path.join(root, 'workers'), stopFile: path.join(root, 'STOP'),
    ...overrides,
  });
  return { root, log, queue, bridge, server };
}

const call = (server, id, name, args = {}, extra = {}) => server.handle({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...extra },
});

test('MCP handshake, discovery and legacy bridge tools work with exact schemas', async (t) => {
  const { server, bridge } = fixture(t);
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'majin-v6');

  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = list.result.tools.map((tool) => tool.name);
  for (const expected of ['majin_status', 'majin_tools_search', 'majin_tool_schema', 'majin_tool_call', 'v6_status', 'v6_queue_add', 'v6_work_start']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const lastPage = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: '50' } });
  assert.deepEqual(lastPage.result.tools, []);
  assert.equal(lastPage.result.nextCursor, undefined);

  const status = await call(server, 4, 'majin_status');
  assert.equal(status.result.isError, false);
  assert.equal(bridge.calls.length, 1);

  const invalid = await call(server, 5, 'v6_queue_add', { kind: 'tool', priority: 500 });
  assert.equal(invalid.error.code, -32602);
  const unknown = await call(server, 6, 'not_a_tool');
  assert.equal(unknown.error.code, -32602);
});

test('V6 tools persist durable tasks through the same queue the worker uses', async (t) => {
  const { server, queue } = fixture(t);
  const added = await call(server, 10, 'v6_queue_add', {
    kind: 'tool', title: 'hash a file', payload: { tool: 're_hash', arguments: { path: 'a.txt' } },
    dedupeKey: 'hash-a', priority: 3,
  });
  const value = JSON.parse(added.result.content[0].text);
  assert.equal(value.deduplicated, false);
  assert.equal(value.task.state, 'QUEUED');

  const duplicate = await call(server, 11, 'v6_queue_add', { kind: 'tool', payload: { tool: 're_hash' }, dedupeKey: 'hash-a' });
  assert.equal(JSON.parse(duplicate.result.content[0].text).deduplicated, true);

  const listed = await call(server, 12, 'v6_queue_list', { state: 'QUEUED' });
  assert.equal(JSON.parse(listed.result.content[0].text).tasks.length, 1);

  const fetched = await call(server, 13, 'v6_task_get', { id: value.task.id });
  assert.equal(JSON.parse(fetched.result.content[0].text).priority, 3);

  const cancelled = await call(server, 14, 'v6_task_cancel', { id: value.task.id });
  assert.equal(JSON.parse(cancelled.result.content[0].text).state, 'CANCELLED');
  assert.equal((await queue.stats()).byState.CANCELLED, 1);

  const missing = await call(server, 15, 'v6_task_get', { id: 'tsk_missing' });
  assert.equal(missing.result.isError, true);
});

test('progress notifications are honest and cancellation reaches the bridge', async (t) => {
  let release;
  const bridge = {
    calls: [], cancelled: [],
    async operate(name, args) {
      this.calls.push({ name, args });
      await new Promise((resolve) => { release = resolve; });
      return { content: [{ type: 'text', text: '{}' }], isError: false };
    },
    async cancel(operationId) { this.cancelled.push(operationId); release?.(); },
  };
  const { root, queue, log } = fixture(t);
  const server = createV6Server({
    bridge, queue, log, home: root,
    workersDir: path.join(root, 'workers'), stopFile: path.join(root, 'STOP'),
  });
  const notifications = [];
  const pending = server.handle({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: {
      name: 'majin_tool_call',
      arguments: { name: 'fs_read', operationId: 'op-123', arguments: { path: 'a' } },
      _meta: { progressToken: 'p-1' },
    },
  }, { notify: (message) => notifications.push(message) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20, reason: 'user' } });
  await pending;
  assert.deepEqual(bridge.cancelled, ['op-123']);
  assert.equal(notifications[0].params.progressToken, 'p-1');
  assert.equal(notifications.length, 2);
  assert.equal(log.read({ types: ['tool.cancelled'], limit: 5 }).length, 1);
});

test('worker start is bounded, detached and reports the real budget', async (t) => {
  const spawned = [];
  const { root, server } = fixture(t, {
    workspace: 'C:\\work\\project',
    dataDir: 'C:\\Users\\owner\\AppData\\Local\\MAJIN\\v5',
    spawnWorker: (command, argv, options) => {
      spawned.push({ command, argv, options });
      return { pid: 4242, unref() {} };
    },
  });
  const result = await call(server, 30, 'v6_work_start', { maxTasks: 7, maxRuntimeMs: 12345, workerId: 'test-worker' });
  const value = JSON.parse(result.result.content[0].text);
  assert.equal(value.started, true);
  assert.equal(value.pid, 4242);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].argv.includes('worker'));
  assert.ok(spawned[0].argv.includes('--max-tasks'));
  assert.ok(spawned[0].argv.includes('7'));
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.env.MAJIN_V6_HOME, root);

  const tooMany = await call(server, 31, 'v6_work_start', { maxTasks: 501 });
  assert.equal(tooMany.error.code, -32602);
});

test('stop writes a real STOP marker rather than pretending work finished', async (t) => {
  const { root, server } = fixture(t);
  const result = await call(server, 40, 'v6_work_stop');
  assert.equal(JSON.parse(result.result.content[0].text).stopRequested, true);
  assert.ok(fs.existsSync(path.join(root, 'STOP')));
});
