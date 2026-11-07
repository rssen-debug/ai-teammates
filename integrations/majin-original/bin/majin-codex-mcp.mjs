#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { CodexDriver } from '../src/v5/codex-driver.js';
import { VERSION } from '../src/core/version.js';

console.log = (...args) => console.error(...args);
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const workspace = path.resolve(arg('--workspace', process.cwd()));
const driver = new CodexDriver({ workspace, stateDir: path.resolve(arg('--state-dir', path.join(workspace, '.codex-driver'))),
  desktop: args.includes('--desktop'), browser: args.includes('--browser'), processAccess: args.includes('--process'), skillsDir: arg('--skills-dir', undefined),
  browserWriteOrigins: args.flatMap((value, index) => value === '--submit-origin' ? [args[index + 1]] : []) });
await driver.start();
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let initialized = false;
const controls = [
  { name: 'execution_status', description: 'Inspect a persisted operation. Does not repeat it.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false } },
  { name: 'execution_cancel', description: 'Stop current worker and descendants. Effects may require inspection.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false } },
];
const requests = new Map();
async function dispatch(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'notifications/cancelled') {
    const op = requests.get(params.requestId);
    if (op) await driver.cancel(op);
    return;
  }
  if (id == null) return;
  try {
    let result;
    if (method === 'initialize') {
      initialized = true;
      result = { protocolVersion: ['2024-11-05','2025-03-26','2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
        serverInfo: { name: 'majin-codex-driver', version: VERSION }, capabilities: { tools: {} } };
    } else if (!initialized) throw new Error('initialize required');
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: [...driver.list(), ...controls] };
    else if (method === 'tools/call') {
      const input = params.arguments || {};
      if (params.name === 'execution_status') {
        const record = driver.operations.get(input.operationId);
        if (!record) throw new Error('Unknown operation ID');
        result = driver.result(record);
      } else if (params.name === 'execution_cancel') result = await driver.cancel(input.operationId);
      else {
        requests.set(id, input.operationId);
        try { result = await driver.call(params.name, input); } finally { requests.delete(id); }
      }
    } else {
      write({ id, error: { code: -32601, message: 'Method not found' } }); return;
    }
    write({ id, result });
  } catch (error) { write({ id, error: { code: -32602, message: error.message } }); }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) { write({ id: null, error: { code: -32600, message: 'Message exceeds 4 MB' } }); return; }
  try { dispatch(JSON.parse(line)).catch(error => console.error(error.message)); }
  catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
});
input.on('close', () => driver.close().catch(error => console.error(error.message)));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => driver.close().finally(() => process.exit(0)));
