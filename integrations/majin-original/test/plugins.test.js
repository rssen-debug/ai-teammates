import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-plugins-'));
process.env.MAJIN_HOME = home;

const { DEFAULTS, Config, clone } = await import('../src/core/config.js');
const { buildRegistry } = await import('../src/core/tools/index.js');
const { loadUserPlugins } = await import('../src/core/tools/plugins.js');
const { dirs } = await import('../src/core/paths.js');

function setup() {
  const cfg = new Config(clone(DEFAULTS), path.join(home, `config-${Math.random()}.json`));
  cfg.save = () => true;
  cfg.patch({ guard: { mode: 'off' } });
  const ctx = { cfg, emit: () => {}, approvals: null };
  return { cfg, registry: buildRegistry(ctx), ctx };
}

test('majin.plugin creates a live custom tool that survives reload and can be removed', async (t) => {
  fs.rmSync(dirs.plugins, { recursive: true, force: true });
  fs.mkdirSync(dirs.plugins, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { registry } = setup();
  const created = await registry.exec('majin.plugin', {
    action: 'create',
    name: 'plugin.hello_world',
    description: 'Return a simple personalized greeting for a supplied name.',
    params: { name: 'string: person to greet' },
    code: "globalThis.__majin_plugin_test_ran = true; return { result: `hello ${args.name}`, summary: 'greeting' };",
  }, { session: 'plugins-test' });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.ok(registry.has('plugin.hello_world'));
  assert.equal(globalThis.__majin_plugin_test_ran, undefined, 'plugin body is not run merely by loading it');

  const result = await registry.exec('plugin.hello_world', { name: 'Ada' }, { session: 'plugins-test' });
  assert.equal(globalThis.__majin_plugin_test_ran, true, 'plugin body runs only when its tool is invoked');
  delete globalThis.__majin_plugin_test_ran;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.match(result.result, /hello Ada/);

  const second = setup().registry;
  const loaded = await loadUserPlugins(second, { dir: dirs.plugins });
  assert.deepEqual(loaded.loaded, ['plugin.hello_world']);
  assert.ok(second.has('plugin.hello_world'));

  const removed = await second.exec('majin.plugin', { action: 'remove', name: 'plugin.hello_world' }, { session: 'plugins-test' });
  assert.equal(removed.ok, true, JSON.stringify(removed.error));
  assert.equal(second.has('plugin.hello_world'), false);
});

test('plugin loader refuses source modified after it was approved', async (t) => {
  fs.rmSync(dirs.plugins, { recursive: true, force: true });
  fs.mkdirSync(dirs.plugins, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = "export default {name:'plugin.changed',group:'plugin',desc:'A test plugin with a useful description.',risk:'exec',params:{},async run(){return 'ok'}};\n";
  const file = path.join(dirs.plugins, 'changed.mjs');
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(dirs.plugins, 'index.json'), JSON.stringify({
    version: 1,
    plugins: { 'plugin.changed': { file: 'changed.mjs', sha256: createHash('sha256').update(source).digest('hex') } },
  }));
  fs.appendFileSync(file, '// modified after approval\n');
  const { registry } = setup();
  const loaded = await loadUserPlugins(registry, { dir: dirs.plugins });
  assert.deepEqual(loaded.loaded, []);
  assert.match(loaded.skipped[0].reason, /source changed/i);
  assert.equal(registry.has('plugin.changed'), false);
});
