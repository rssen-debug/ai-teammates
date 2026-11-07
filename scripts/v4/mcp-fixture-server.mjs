#!/usr/bin/env node
/**
 * A tiny but real MCP server over stdio, used to test the V4 client.
 *
 * It speaks the protocol properly: newline-delimited JSON-RPC, an initialize
 * handshake, tools/list and tools/call. Behaviour can be changed with an env
 * var so the client's failure paths are testable:
 *
 * The mode comes from argv (`--mode=die`), not from the environment, because the
 * V4 client scrubs the child's environment by design — a test that needed an env
 * var would have to weaken that. That the env var does NOT work is itself
 * covered by the client tests.
 *
 *   --mode=die     exit immediately
 *   --mode=hang    accept input, never answer
 *   --mode=noisy   print a log line before every response
 *   --mode=error   answer every call with isError:true
 */
import { V4_VERSION } from '../../src/v4/config.js';
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=normal').slice('--mode='.length);

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the text you were given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'fail',
    description: 'Always reports an error.',
    inputSchema: { type: 'object', properties: {} },
  },
];

if (MODE === 'die') process.exit(3);
if (MODE === 'hang') {
  // Accept input and never answer: the client must cut us off, not wait forever.
  process.stdin.resume();
  setInterval(() => {}, 1000);
}

function send(msg) {
  if (MODE === 'noisy') process.stdout.write(`[fixture] ${msg.id ?? msg.method}\n`);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

if (MODE !== 'hang') {
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'majin-fixture', version: V4_VERSION },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    if (MODE === 'error' || name === 'fail') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'this tool always fails' }] } });
      return;
    }
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
      return;
    }
    if (name === 'add') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
    return;
  }
  if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
}
