import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, DEFAULTS, clone, hasKey } from '../src/core/config.js';
import { relaunchCommand, relaunchScript } from '../src/core/update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (pathName) => fs.readFileSync(path.join(root, pathName), 'utf8');

test('automatically detects existing provider environment keys without copying secrets into config', () => {
  const key = 'MAJIN_TEST_PROVIDER_KEY';
  const was = process.env[key];
  process.env[key] = 'secret-for-test-only';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-auto-provider-'));
  try {
    const cfg = new Config(clone(DEFAULTS), path.join(dir, 'config.json'));
    cfg.patch({ providers: { openrouter: { apiKey: null, keyEnv: key } } });
    const p = cfg.get('providers.openrouter');
    assert.equal(hasKey(p), true, 'the provider is ready when the configured key env is present');
    assert.equal(cfg.needsSetup(), false, 'a configured environment provider needs no wizard');
    assert.equal(cfg.resolveModel('openrouter/test-model', 'chat').apiKey, process.env[key], 'only the executor resolves the secret');
    assert.equal(cfg.redacted().providers.openrouter.apiKey, null, 'state contains no secret');
    assert.doesNotMatch(fs.readFileSync(cfg.file, 'utf8'), /secret-for-test-only/, 'no key is copied to disk');
    delete process.env[key];
    assert.equal(hasKey(p), false, 'a missing env key is not marked connected');
  } finally {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first run is one connection decision, not a wall of provider cards', () => {
  const onboard = read('src/ui/onboard.js');
  assert.match(onboard, /Save and choose model/, 'one primary action leads to explicit model selection');
  assert.match(onboard, /Choose your AI/, 'plain language');
  assert.match(onboard, /connected\(\)/, 'detect configured providers first');
  assert.match(onboard, /policy: 'off'/, 'onboarding stays single model');
  assert.doesNotMatch(onboard, /ob-grid|ob-card ob-custom/, 'the old provider grid is not rendered');
  assert.doesNotMatch(onboard, /innerHTML/, 'provider metadata cannot inject HTML');
  const app = read('src/ui/app.js');
  assert.match(app, /showWelcome\(\)/, 'new chat has a helpful, quiet empty state');
  assert.match(app, /await api\('\/update', \{ method: 'POST', body: \{ action: 'check', force: true \} \}\)/, 'startup checks for updates and repaints on completion');
  assert.match(app, /await refresh\(true\)/, 'the update badge repaints after GitHub check finishes');
  assert.match(app, /force: true/, 'the running window checks for releases later');
});

test('silent updates restart the installed executable, including per-user installations', () => {
  const exe = "C:\\Users\\O'Connor\\AppData\\Local\\Programs\\MAJIN\\majin-win-x64.exe";
  const script = relaunchScript(1234, exe);
  assert.ok(script.includes("O''Connor"), 'PowerShell single quotes in paths are escaped');
  assert.ok(script.includes('majin-win-x64.exe'), 'the actual executable is targeted');
  assert.ok(script.includes('Get-Process -Id 1234'), 'the installer is awaited before relaunch');
  assert.equal(Buffer.from(relaunchCommand(1234, exe), 'base64').toString('utf16le'), script, 'the command survives Windows UTF16 encoding');
  const update = read('src/core/update.js');
  assert.match(update, /relaunchCommand\(child\.pid, process\.execPath\)/, 'the live executable path is passed, not guessed');
  const server = read('src/core/server/index.js');
  assert.match(server, /rt\.shutdown\('update'\)\.finally/, 'old executable is asked to exit before replacement');
});
