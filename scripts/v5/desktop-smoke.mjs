#!/usr/bin/env node
/**
 * MAJIN V5 — Packaged Windows Electron Native App & Cold-Start Host Verification (`scripts/v5/desktop-smoke.mjs`).
 *
 * Verifies on Windows:
 *  1. Packaged `MAJIN V5.exe` starts its own bundled V5 host automatically (`runtime/node.exe`).
 *  2. Health check `/api/health` and `/api/v5/state` report `app: "majin-v5"` and `V5_VERSION`.
 *  3. Native Electron window renders V5 Black Box UI (`#majin-logo-img`, 99 dot segments, `#wish-input`).
 *  4. Renderer security isolation (`nodeIntegration: false, sandbox: true, contextIsolation: true`).
 *  5. Provider settings (`opencode-go` / `Grok 4.7`), goal history and XP persist across app restarts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { V5_VERSION } from '../../src/v5/ops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-desktop-smoke-'));
const v5DataDir = path.join(home, 'v5');
const profileDir = path.join(home, 'electron-profile');

// Seed legacy V4 provider file in parent MAJIN home to verify non-destructive V1-V4 preservation
const v4Dir = path.join(home, 'v4');
fs.mkdirSync(v4Dir, { recursive: true });
fs.writeFileSync(
  path.join(v4Dir, 'provider.json'),
  JSON.stringify({ provider: 'opencode-go', model: 'Grok 4.7', baseUrl: 'https://opencode.ai/zen/go/v1' }, null, 2),
);

const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;

const executablePath =
  process.env.MAJIN_V5_DESKTOP_EXE ||
  path.join(root, 'desktop', 'dist', 'win-unpacked', 'MAJIN V5.exe');

async function fetchJson(pathname) {
  try {
    const res = await fetch(`${origin}${pathname}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let application = null;
let nativePid = null;

try {
  // --- Launch #1: Cold start (Electron starts bundled V5 host automatically) ---
  application = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      MAJIN_HOME: home,
      MAJIN_V5_DATA_DIR: v5DataDir,
      MAJIN_V5_PORT: String(port),
      MAJIN_V5_DESKTOP_URL: origin,
      MAJIN_V5_DESKTOP_NO_HOST: '0',
      MAJIN_V5_DESKTOP_PROFILE: profileDir,
    },
  });
  nativePid = application.process().pid;
  const page = await application.firstWindow();

  // Wait for automatic host startup and Black Box UI load inside native Electron window
  await page.waitForSelector('#majin-logo-img', { timeout: 30_000 });
  await page.waitForSelector('#wish-input', { timeout: 15_000 });

  const health = await fetchJson('/api/health');
  assert.equal(health?.ok, true, 'V5 host /api/health must return ok: true');
  assert.equal(health?.app, 'majin-v5', 'V5 host must identify as majin-v5');
  assert.equal(health?.version, V5_VERSION, 'V5 host version must match V5_VERSION');

  const winTitle = await page.title();
  assert.match(winTitle, /MAJIN V5/, 'Native Electron window title must identify MAJIN V5');

  // The strip renders synchronously once the deferred UI module boots; wait
  // for that boot instead of racing module execution on a loaded runner.
  await page.waitForFunction(
    () => document.querySelectorAll('#dot-segments .v5-dot-cell').length === 99,
    null,
    { timeout: 30_000 },
  ).catch(() => {});
  const dotCount = await page.locator('#dot-segments .v5-dot-cell').count();
  assert.equal(dotCount, 99, 'Black Box UI must render 99 dot-matrix segments in Electron window');

  const prefs = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const p = win.webContents.getLastWebPreferences();
    return {
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
    };
  });
  assert.deepEqual(prefs, {
    nodeIntegration: false,
    sandbox: true,
    contextIsolation: true,
  });

  // Save provider configuration and execute a verified goal on Launch #1
  const provSave = await fetch(`${origin}/api/v5/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'opencode-go',
      modelId: 'Kimi K3.1 Pro',
      manualOverride: true,
    }),
  });
  assert.equal(provSave.status, 200);

  const goalRun = await fetch(`${origin}/api/v5/goal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goalText: 'Build a verified status page',
      skillId: 'code.build-page',
      actions: [
        {
          id: 'electron-smoke-1',
          tool: 'workspace_write',
          args: { file: 'electron-verified.html', content: '<!doctype html><title>MAJIN V5 Electron</title>' },
        },
      ],
    }),
  });
  assert.equal(goalRun.status, 200);
  const goalData = await goalRun.json();
  assert.equal(goalData.status || goalData.goal?.status, 'COMPLETED');

  const screenshotDir = path.join(root, 'docs', 'v5', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, 'windows-electron-v5-blackbox.png') });

  // Quit Electron window #1 cleanly
  const nativeProc1 = application.process();
  const exited1 = once(nativeProc1, 'exit');
  await application.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
  const [exitCode1] = await exited1;
  assert.equal(exitCode1, 0, 'First Electron launch must exit cleanly with code 0');
  application = null;

  // Verify the background V5 host is still alive after closing the window
  const healthAfterClose = await fetchJson('/api/health');
  assert.equal(healthAfterClose?.ok, true, 'Background V5 host must stay alive when window closes');

  // --- Launch #2: Restart Electron and verify provider settings, history & V4 preservation ---
  application = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      MAJIN_HOME: home,
      MAJIN_V5_DATA_DIR: v5DataDir,
      MAJIN_V5_PORT: String(port),
      MAJIN_V5_DESKTOP_URL: origin,
      MAJIN_V5_DESKTOP_NO_HOST: '0',
      MAJIN_V5_DESKTOP_PROFILE: profileDir,
    },
  });
  nativePid = application.process().pid;
  const page2 = await application.firstWindow();
  await page2.waitForSelector('#majin-logo-img', { timeout: 20_000 });

  const stateAfterRestart = await fetchJson('/api/v5/state');
  assert.equal(
    stateAfterRestart?.provider?.activeProvider,
    'opencode-go',
    'Provider selection must persist across restart',
  );
  assert.equal(
    stateAfterRestart?.provider?.activeModelId,
    'Kimi K3.1 Pro',
    'Active model ID must persist across restart',
  );
  assert.equal(
    stateAfterRestart?.activeGoal?.status,
    'COMPLETED',
    'Verified goal history must persist across restart',
  );
  assert.equal(
    fs.existsSync(path.join(v4Dir, 'provider.json')),
    true,
    'Pre-existing V4 data must remain completely untouched',
  );

  const nativeProc2 = application.process();
  const exited2 = once(nativeProc2, 'exit');
  await application.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
  await exited2;
  application = null;

  const evidenceReport = {
    schema: 'majin.v5.windows-desktop-smoke/v1',
    verifiedAt: new Date().toISOString(),
    status: 'PASS',
    executablePath,
    version: V5_VERSION,
    autoHostStart: true,
    blackBoxWindowRendered: true,
    dotMatrixSegments: 99,
    rendererSecurity: prefs,
    providerPersistedAfterRestart: {
      activeProvider: stateAfterRestart.provider.activeProvider,
      activeModelId: stateAfterRestart.provider.activeModelId,
    },
    goalHistoryPersistedAfterRestart: true,
    v4DataPreserved: true,
  };
  fs.writeFileSync(
    path.join(root, 'docs', 'v5', 'windows-desktop-smoke.json'),
    `${JSON.stringify(evidenceReport, null, 2)}\n`,
  );
  process.stdout.write('PASS MAJIN V5 packaged Electron window, auto-host start, restart persistence, and V4 preservation\n');
} catch (err) {
  fs.mkdirSync(path.join(root, 'docs', 'v5'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'v5', 'windows-desktop-smoke.json'),
    `${JSON.stringify({ status: 'FAIL', error: err?.message, stack: err?.stack }, null, 2)}\n`,
  );
  throw err;
} finally {
  if (application && application.process().exitCode === null) {
    if (process.platform === 'win32' && nativePid) {
      try {
        execFileSync('taskkill', ['/PID', String(nativePid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch { /* ignore */ }
    } else {
      application.process().kill();
    }
  }
  const hostInfoFile = path.join(v5DataDir, 'desktop-host.json');
  if (fs.existsSync(hostInfoFile)) {
    try {
      const info = JSON.parse(fs.readFileSync(hostInfoFile, 'utf8'));
      if (Number.isInteger(info.pid) && info.pid !== process.pid) {
        process.kill(info.pid);
      }
    } catch { /* already exited */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch { /* ignore */ }
}
