import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { hostOrigin, v5HostOrigin, sameOrigin, restoreBounds, restoreV5Bounds } = require('../../desktop/policy.cjs');

test('desktop/package.json & desktop/policy.cjs configure MAJIN V5 Setup.exe, Majin icon, Desktop shortcut, and V4 compatibility', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('desktop/package.json'), 'utf8'));
  assert.equal(pkg.name, 'majin-v5-desktop');
  assert.equal(pkg.v5Version, '5.0.0');
  assert.equal(pkg.build.appId, 'com.majin.v5');
  assert.equal(pkg.build.productName, 'MAJIN V5');
  assert.equal(pkg.build.extraMetadata?.version, '5.0.0');
  assert.equal(pkg.build.win.artifactName, 'MAJIN-V5-Setup.${ext}');
  assert.equal(pkg.build.win.icon, 'stage/icon.ico');
  assert.equal(pkg.build.nsis.createDesktopShortcut, 'always');
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
  assert.equal(pkg.build.nsis.shortcutName, 'MAJIN V5');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);

  const iconResource = pkg.build.extraResources.find((r) => r.to === 'icon.png');
  assert.ok(iconResource, 'icon.png extraResource must exist');
  assert.equal(iconResource.from, '../assets/majin.png', 'Must bundle official Majin logo assets/majin.png');

  // Verify V5 origin and bounds alongside V4 backward compatibility
  assert.equal(v5HostOrigin(), 'http://127.0.0.1:4555');
  assert.equal(hostOrigin(), 'http://127.0.0.1:7373');
  assert.equal(sameOrigin('http://127.0.0.1:4555/api/v5/state', v5HostOrigin()), true);

  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(restoreV5Bounds(null, displays), { width: 1080, height: 820 });
  assert.deepEqual(restoreBounds(null, displays), { width: 520, height: 860 });

  const mainSource = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
  assert.match(mainSource, /\/api\/v5\/state/, 'desktop/main.cjs must check /api/v5/state');
  assert.match(mainSource, /scripts',\s*'v5',\s*'desktop-host\.mjs'/, 'desktop/main.cjs must spawn scripts/v5/desktop-host.mjs');
  assert.match(mainSource, /com\.majin\.v5/, 'desktop/main.cjs must set AppUserModelId com.majin.v5');
  assert.match(mainSource, /#07080a/, 'desktop/main.cjs must use V5 Black Box background color #07080a');
});

test('scripts/v5/desktop-host.mjs starts automatically via IPC, migrates V1/V4 provider non-destructively, and persists provider across restarts', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-desktop-host-'));
  const v4Dir = path.join(home, 'v4');
  const v5Dir = path.join(home, 'v5');
  fs.mkdirSync(v4Dir, { recursive: true });

  // Seed pre-existing V4 provider config
  const v4ProviderPath = path.join(v4Dir, 'provider.json');
  const v4Content = JSON.stringify(
    { provider: 'opencode-go', model: 'Grok 4.7', baseUrl: 'https://opencode.ai/zen/go/v1' },
    null,
    2,
  );
  fs.writeFileSync(v4ProviderPath, v4Content);

  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  const hostScript = path.resolve('scripts/v5/desktop-host.mjs');

  async function spawnDesktopHost() {
    const child = spawn(
      process.execPath,
      [hostScript, '--host', '127.0.0.1', '--port', String(port), '--data-dir', v5Dir],
      {
        env: { ...process.env, MAJIN_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const readyMsg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for v5-ready IPC')), 8000);
      child.once('message', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return { child, readyMsg };
  }

  // 1. First boot of desktop-host
  const boot1 = await spawnDesktopHost();
  t.after(async () => {
    try {
      boot1.child.kill('SIGTERM');
    } catch { /* ignore */ }
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.equal(boot1.readyMsg.type, 'v5-ready');
  assert.equal(boot1.readyMsg.version, '5.0.0');
  assert.match(boot1.readyMsg.code, /^\d{6}$/);

  const origin = `http://127.0.0.1:${port}`;
  const health1 = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health1.ok, true);
  assert.equal(health1.app, 'majin-v5');
  assert.equal(health1.version, '5.0.0');

  const state1 = await (await fetch(`${origin}/api/v5/state`)).json();
  assert.equal(state1.provider.activeProvider, 'opencode-go');
  assert.equal(state1.provider.activeModelId, 'Grok 4.7', 'Initial boot must seed from existing V4 provider config');

  // Update provider settings in V5
  const saveRes = await fetch(`${origin}/api/v5/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'opencode-go',
      modelId: 'DeepSeek V4 Pro',
      manualOverride: true,
    }),
  });
  assert.equal(saveRes.status, 200);

  // Stop host #1
  const exit1 = once(boot1.child, 'exit');
  boot1.child.kill('SIGTERM');
  await exit1;

  // 2. Restart desktop-host and verify provider settings persisted while V4 file stayed untouched
  const boot2 = await spawnDesktopHost();
  try {
    const state2 = await (await fetch(`${origin}/api/v5/state`)).json();
    assert.equal(state2.provider.activeProvider, 'opencode-go');
    assert.equal(state2.provider.activeModelId, 'DeepSeek V4 Pro', 'Updated V5 provider must persist across restart');
    assert.equal(
      fs.readFileSync(v4ProviderPath, 'utf8'),
      v4Content,
      'V4 provider.json must never be modified by V5',
    );
  } finally {
    const exit2 = once(boot2.child, 'exit');
    boot2.child.kill('SIGTERM');
    await exit2;
  }
});
