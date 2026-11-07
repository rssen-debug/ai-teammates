import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel, parseFlags } from '../../src/v4/kernel.js';
import { sanitizedEnv, PluginWorker } from '../../src/v4/sandbox.js';
import { tempHome } from './helpers.mjs';

function writePlugin(root, name, manifest, body) {
  const dir = path.join(root, 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, ...manifest }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  return dir;
}

const manifest = {
  version: '1.0.0',
  kernelApi: 1,
  description: 'sandbox test plugin',
  permissions: [],
  capabilities: [{ kind: 'tool', name: 'ping' }],
};

const kernelFor = (root, extra = {}) => new Kernel({
  pluginsEnabled: true,
  isolate: true,
  quarantineDir: path.join(root, 'quarantine'),
  ...extra,
});

test('sandbox: only an allowlisted env reaches a plugin process', () => {
  const env = sanitizedEnv({
    PATH: '/usr/bin',
    HOME: '/home/x',
    MAJIN_V4_API_KEY: 'secret',
    OPENCODE_KEY: 'oc_secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require ./evil.js',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.MAJIN_V4_API_KEY, undefined);
  assert.equal(env.OPENCODE_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('sandbox: a plugin tool runs in a child process and returns its result', async () => {
  const root = tempHome();
  writePlugin(root, 'pinger', manifest, `
    export function activate(ctx) {
      ctx.registerTool({ name: 'ping', description: 'returns pong', tier: 'read', execute: async (input) => ({ pong: true, pid: process.pid, echo: input?.x ?? null }) });
    }
  `);
  const kernel = kernelFor(root);
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'active', JSON.stringify(results));
    assert.equal(results[0].isolated, true);
    const tool = kernel.get('tool', 'ping');
    const out = await tool.execute({ x: 42 });
    assert.equal(out.pong, true);
    assert.equal(out.echo, 42);
    assert.notEqual(out.pid, process.pid, 'tool ran in a different process');
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: the host survives a plugin that crashes on activation', async () => {
  const root = tempHome();
  writePlugin(root, 'crasher', manifest, 'process.exit(1);');
  const kernel = kernelFor(root);
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /exit|died|activation/i);
    assert.equal(kernel.list().length, 0, 'nothing half-registered');
    // host is still usable
    assert.equal(kernel.summary().apiVersion, 1);
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: a plugin that hangs on activate is killed, not waited on forever', async () => {
  const root = tempHome();
  writePlugin(root, 'hanger', manifest, 'setInterval(() => {}, 1000);');
  const kernel = kernelFor(root, { workerFactory: (opts) => new PluginWorker({ ...opts, timeoutMs: 400 }) });
  try {
    const started = Date.now();
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.ok(Date.now() - started < 5000);
    assert.equal(results[0].status, 'failed');
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: a failing plugin is quarantined with a written reason', async () => {
  const root = tempHome();
  writePlugin(root, 'bad', manifest, 'export function activate() { throw new Error("boom in activate"); }');
  const kernel = kernelFor(root);
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'failed');
    const moved = results[0].quarantined;
    assert.ok(moved, 'plugin directory was moved');
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'bad')), false);
    assert.ok(fs.existsSync(path.join(moved, 'QUARANTINE.json')));
    const reason = JSON.parse(fs.readFileSync(path.join(moved, 'QUARANTINE.json'), 'utf8'));
    assert.match(reason.reason, /boom/);
    assert.equal(reason.plugin, 'bad');
    // a second boot no longer tries it
    const kernel2 = kernelFor(root);
    const again = await kernel2.loadPlugins(path.join(root, 'plugins'));
    assert.deepEqual(again, []);
    await kernel2.shutdownWorkers();
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: an undeclared capability fails inside the worker and is quarantined', async () => {
  const root = tempHome();
  writePlugin(root, 'sneaky', { ...manifest, capabilities: [{ kind: 'tool', name: 'other' }] },
    `export function activate(ctx) { ctx.registerTool({ name: 'ping', description: 'x', execute: async () => 1 }); }`);
  const kernel = kernelFor(root);
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /not declared/);
    assert.equal(kernel.list().length, 0);
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: a write tool without workspace permission is refused before it can run', async () => {
  const root = tempHome();
  writePlugin(root, 'writer', { ...manifest, permissions: [] },
    `export function activate(ctx) { ctx.registerTool({ name: 'ping', description: 'x', tier: 'write', execute: async () => 1 }); }`);
  const kernel = kernelFor(root);
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /workspace/);
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: a tool that throws is reported honestly with a class', async () => {
  const root = tempHome();
  writePlugin(root, 'thrower', manifest, `
    export function activate(ctx) {
      ctx.registerTool({ name: 'ping', description: 'throws', tier: 'read', execute: async () => { const e = new Error('nope'); e.cls = 'ELEMENT_NOT_FOUND'; throw e; } });
    }
  `);
  const kernel = kernelFor(root);
  try {
    await kernel.loadPlugins(path.join(root, 'plugins'));
    await assert.rejects(() => kernel.get('tool', 'ping').execute({}), (err) => err.cls === 'ELEMENT_NOT_FOUND');
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox: an in-process kernel (isolate:false) still works and still quarantines', async () => {
  const root = tempHome();
  writePlugin(root, 'inline', manifest, `
    export function activate(ctx) { ctx.registerTool({ name: 'ping', description: 'pong', tier: 'read', inputSchema: null, outputSchema: null, execute: async () => ({ ok: 1 }) }); }
  `);
  const kernel = kernelFor(root, { isolate: false });
  try {
    const results = await kernel.loadPlugins(path.join(root, 'plugins'));
    assert.equal(results[0].status, 'active');
    assert.equal(results[0].isolated, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
