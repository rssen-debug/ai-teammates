import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertSafeRoutes, resolveConfigPath } from '../scripts/eval-live.mjs';

test('live eval resolves explicit config paths without consulting provider secrets', () => {
  const configPath = path.join(os.tmpdir(), 'custom-majin.json');
  const homePath = path.join(os.tmpdir(), 'custom-home');
  assert.equal(resolveConfigPath({ MAJIN_CONFIG: configPath }), path.resolve(configPath));
  assert.equal(resolveConfigPath({ MAJIN_HOME: homePath }), path.join(path.resolve(homePath), 'config.json'));
});

test('live eval requires explicit consent before any paid provider calls', () => {
  const script = path.resolve('scripts/eval-live.mjs');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /may cost money.*--yes/i);
});

test('live eval refuses OpenCode and Qwen routes before making calls', () => {
  assert.throws(
    () => assertSafeRoutes({ models: { routes: { tasks: 'opencode-go/qwen3-coder' } }, providers: { 'opencode-go': { label: 'OpenCode Go' } } }),
    /refused.*OpenCode\/Qwen/i,
  );
  assert.throws(
    () => assertSafeRoutes({ models: { routes: { code: 'local/qwen-coder' } }, providers: { local: { label: 'Local' } } }),
    /refused.*OpenCode\/Qwen/i,
  );
  assert.doesNotThrow(() => assertSafeRoutes({ models: { routes: { tasks: 'deepseek/deepseek-flash' } }, providers: { deepseek: { label: 'DeepSeek' } } }));
});
