import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const BIN = path.resolve('bin/majin-v6.mjs');

function rpcSession(child) {
  const waiting = new Map();
  const notifications = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else notifications.push(message);
  });
  let seq = 0;
  return {
    notifications,
    call(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 20000);
        waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

test('a real MCP session executes real MAJIN tools through the V5 driver', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-live-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'v5');
  const v6Home = path.join(root, 'v6');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const contents = 'MAJIN V6 live MCP test\n';
  fs.writeFileSync(path.join(workspace, 'sample.txt'), contents);
  fs.writeFileSync(path.join(dataDir, 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes: ['files'],
    folders: [workspace],
    browserOrigins: [],
    history: [],
  }));

  const child = spawn(process.execPath, [BIN, 'mcp', '--workspace', workspace, '--data-dir', dataDir, '--v6-home', v6Home], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const session = rpcSession(child);
  t.after(() => { try { child.kill(); } catch { /* already exited */ } });

  try {
    const init = await session.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const status = await session.call('tools/call', { name: 'majin_status', arguments: {} });
    const statusValue = JSON.parse(status.result.content[0].text);
    assert.equal(statusValue.operational, true);
    assert.ok(statusValue.registered > 0);
    assert.ok(statusValue.authorized > 0);
    assert.ok(statusValue.ownerGrantedLanes.includes('files'));

    const search = await session.call('tools/call', { name: 'majin_tools_search', arguments: { query: 'fs.read' } });
    const matches = JSON.parse(search.result.content[0].text).matches;
    assert.ok(matches.some((entry) => entry.name === 'fs_read'), 'the real catalog contains fs_read');

    const schema = await session.call('tools/call', { name: 'majin_tool_schema', arguments: { name: 'fs_read' } });
    const schemaValue = JSON.parse(schema.result.content[0].text);
    assert.ok(schemaValue.inputSchema.properties.path);

    const operationId = 'test-read-1';
    const read = await session.call('tools/call', {
      name: 'majin_tool_call',
      arguments: { name: 'fs_read', operationId, arguments: { path: 'sample.txt' } },
    });
    const record = read.result.structuredContent || JSON.parse(read.result.content[0].text);
    assert.equal(record.operationId, operationId);
    assert.equal(record.status, 'completed');
    const returnedText = JSON.stringify(record.result);
    assert.ok(returnedText.includes('MAJIN V6 live MCP test'));

    const again = await session.call('tools/call', {
      name: 'majin_tool_call',
      arguments: { name: 'fs_read', operationId, arguments: { path: 'sample.txt' } },
    });
    const againRecord = again.result.structuredContent || JSON.parse(again.result.content[0].text);
    assert.equal(againRecord.status, 'completed');
    assert.equal(againRecord.finishedAt, record.finishedAt, 'the same operationId returns the previous receipt');

    const mismatch = await session.call('tools/call', {
      name: 'majin_tool_call',
      arguments: { name: 'fs_read', operationId, arguments: { path: 'other.txt' } },
    });
    assert.equal(mismatch.result.isError, true);
    assert.match(mismatch.result.content[0].text, /different arguments/);

    const denied = await session.call('tools/call', {
      name: 'majin_tool_call',
      arguments: { name: 'shell_run', operationId: 'test-shell-1', arguments: { command: 'whoami' } },
    });
    assert.equal(denied.result.isError, true);
    const deniedValue = JSON.parse(denied.result.content[0].text);
    assert.equal(deniedValue.error, 'TOOL_NOT_AUTHORIZED');

    const digest = createHash('sha256').update(contents).digest('hex');
    assert.equal(digest.length, 64);
  } finally {
    child.stdin.end();
  }
  void stderr;
});
