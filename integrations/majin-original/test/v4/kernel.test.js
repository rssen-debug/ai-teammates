import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel, KERNEL_API_VERSION, parseFlags, PluginManifest } from '../../src/v4/kernel.js';
import { tempHome } from './helpers.mjs';

function writePlugin(root, name, manifest, body) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, ...manifest }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

const baseManifest = {
  version: '1.0.0',
  kernelApi: 1,
  description: 'test plugin',
  permissions: ['workspace'],
  capabilities: [{ kind: 'tool', name: 'echo' }],
};

test('kernel: plugins are disabled unless explicitly enabled', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'echoer', baseManifest, `export function activate(ctx){ ctx.registerTool({ name:'echo', description:'echo', tier:'read', inputSchema:null, outputSchema:null, execute: async (i)=>i }); }`);
  const kernel = new Kernel({ pluginsEnabled: false });
  const results = await kernel.loadPlugins(dir);
  assert.deepEqual(results, []);
  assert.equal(kernel.list().length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: a valid plugin registers its declared capability', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'echoer', baseManifest, `export function activate(ctx){ ctx.registerTool({ name:'echo', description:'echo back', tier:'read', inputSchema:null, outputSchema:null, execute: async (i)=>i }); }`);
  const kernel = new Kernel({ pluginsEnabled: true });
  const results = await kernel.loadPlugins(dir);
  assert.equal(results[0].status, 'active');
  assert.equal(kernel.list().length, 1);
  assert.equal(kernel.list()[0].kind, 'tool');
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: an undeclared capability is refused', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'sneaky', { ...baseManifest, capabilities: [{ kind: 'tool', name: 'other' }] },
    `export function activate(ctx){ ctx.registerTool({ name:'echo', description:'x', tier:'read', inputSchema:null, outputSchema:null, execute: async ()=>1 }); }`);
  const kernel = new Kernel({ pluginsEnabled: true });
  const results = await kernel.loadPlugins(dir);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /not declared/);
  assert.equal(kernel.list().length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: a write tool without the workspace permission is refused', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'writer', { ...baseManifest, permissions: [] },
    `export function activate(ctx){ ctx.registerTool({ name:'echo', description:'x', tier:'write', inputSchema:null, outputSchema:null, execute: async ()=>1 }); }`);
  const kernel = new Kernel({ pluginsEnabled: true });
  const results = await kernel.loadPlugins(dir);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /workspace/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: a plugin that throws mid-activation is rolled back completely', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'halfway', {
    ...baseManifest,
    capabilities: [{ kind: 'tool', name: 'one' }, { kind: 'tool', name: 'two' }],
  }, `export function activate(ctx){
    ctx.registerTool({ name:'one', description:'x', tier:'read', inputSchema:null, outputSchema:null, execute: async ()=>1 });
    throw new Error('boom');
  }`);
  const kernel = new Kernel({ pluginsEnabled: true });
  const results = await kernel.loadPlugins(dir);
  assert.equal(results[0].status, 'failed');
  assert.equal(kernel.list().length, 0, 'no partial registration survives');
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: broken manifests and future API versions are contained', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken', 'plugin.json'), '{ not json');
  writePlugin(dir, 'future', { ...baseManifest, kernelApi: KERNEL_API_VERSION + 1 }, 'export function activate(){}');
  writePlugin(dir, 'mismatch', baseManifest, 'export function activate(){}');
  fs.renameSync(path.join(dir, 'mismatch'), path.join(dir, 'other-name'));
  const kernel = new Kernel({ pluginsEnabled: true });
  const results = await kernel.loadPlugins(dir);
  const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
  assert.equal(byName.broken, 'rejected');
  assert.equal(byName.future, 'incompatible');
  assert.equal(byName['other-name'], 'rejected');
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: experimental plugins stay off without their flag', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'lab', { ...baseManifest, experimental: true }, 'export function activate(){}');
  const off = new Kernel({ pluginsEnabled: true });
  assert.equal((await off.loadPlugins(dir))[0].status, 'flagged-off');
  const on = new Kernel({ pluginsEnabled: true, features: parseFlags('experimental-plugins=1') });
  assert.equal((await on.loadPlugins(dir))[0].status, 'active');
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: the allowlist limits what can load', async () => {
  const home = tempHome();
  const dir = path.join(home, 'plugins');
  writePlugin(dir, 'allowed', baseManifest, 'export function activate(){}');
  writePlugin(dir, 'blocked', { ...baseManifest, capabilities: [{ kind: 'surface', name: 'x' }] }, 'export function activate(){}');
  const kernel = new Kernel({ pluginsEnabled: true, allowlist: ['allowed'] });
  const results = await kernel.loadPlugins(dir);
  assert.deepEqual(results.map((r) => r.name), ['allowed']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('kernel: manifests are validated, not trusted', () => {
  assert.throws(() => PluginManifest.parse({ name: 'Bad Name', version: '1.0.0', kernelApi: 1, description: 'xxxx', capabilities: [{ kind: 'tool', name: 'aa' }] }));
  assert.throws(() => PluginManifest.parse({ name: 'ok', version: '1', kernelApi: 1, description: 'xxxx', capabilities: [{ kind: 'tool', name: 'aa' }] }));
  assert.throws(() => PluginManifest.parse({ name: 'ok', version: '1.0.0', kernelApi: 1, description: 'xxxx', capabilities: [] }));
  assert.doesNotThrow(() => PluginManifest.parse({ name: 'ok', version: '1.0.0', kernelApi: 1, description: 'xxxx', capabilities: [{ kind: 'tool', name: 'aa' }] }));
});

test('flags: stable features default on, experimental default off', () => {
  const f = parseFlags();
  assert.equal(f.voice, true);
  assert.equal(f.pwa, true);
  assert.equal(f['experimental-plugins'], false);
  const g = parseFlags('voice=0,experimental-plugins=on');
  assert.equal(g.voice, false);
  assert.equal(g['experimental-plugins'], true);
});
