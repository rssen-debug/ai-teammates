import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../src/v4/config.js';
import { loadSecret, ensurePairing } from '../../src/v4/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-desktop-cold-'));
const config = loadConfig({ env: { MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo' } });
// Known fixture credential, created only in this disposable test home.
const code = ensurePairing(config.paths.pairing, loadSecret(config.paths.secret));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let application;
let nativePid;
let verdict;
const health = async () => {
  try { return await (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return null; }
};
try {
  application = await _electron.launch({
    executablePath: process.env.MAJIN_V4_DESKTOP_EXE || path.join(root, 'desktop/dist/win-unpacked/MAJIN V4.exe'),
    env: { ...process.env, MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo', MAJIN_V4_DEMO: '1',
      MAJIN_V4_DESKTOP_URL: origin, MAJIN_V4_DESKTOP_NO_HOST: '0', MAJIN_V4_DESKTOP_PROFILE: path.join(home, 'profile') },
  });
  nativePid = application.process().pid;
  const page = await application.firstWindow();
  await page.waitForSelector('#gate-code', { timeout: 30_000 });
  assert.equal((await health())?.app, 'majin');
  assert.equal((await health())?.version, config.version, 'bundled host version must match the tested candidate');
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), config.version,
    'installed native shell version must match its shared host');
  await page.fill('#gate-code', code);
  await page.click('#gate-submit');
  await page.waitForSelector('#gate', { state: 'hidden' });
  await page.fill('#input', 'Write file cold-start.txt with content: bundled runtime');
  await page.click('#send-btn');
  await page.waitForSelector('.tool[data-state="verified"]', { timeout: 15_000 });
  assert.equal(fs.readFileSync(path.join(home, 'workspace/cold-start.txt'), 'utf8'), 'bundled runtime');
  await page.waitForSelector('#stop-btn', { state: 'hidden', timeout: 15_000 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.tool[data-state="verified"][data-historical="true"]', { timeout: 15_000 });
  assert.match(await page.textContent('.tool[data-historical="true"] .tool-summary'), /cold-start.txt/);
  // Verify normal app exit explicitly. Some Electron/Playwright combinations
  // wait for background host descendants when closing the entire test context.
  const nativeProcess = application.process();
  const exited = once(nativeProcess, 'exit');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  application = null;
  assert.equal((await health())?.ok, true, 'closing the client must leave the shared host running');
  verdict = { at: new Date().toISOString(), status: 'PASS', packagedHost: true,
    version: config.version, bundledNode: true, firstConnection: true, pairing: true,
    verifiedOutput: true, historicalReceipts: true, survivesClientClose: true,
    inference: 'demo; no production credentials accessed' };
  fs.mkdirSync(path.join(root, 'docs/v4/evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/v4/evidence/desktop-cold-smoke.json'), JSON.stringify(verdict, null, 2));
  process.stdout.write('PASS packaged cold start, bundled runtime, authenticated chat and background host lifetime\n');
} catch (error) {
  process.stderr.write(`Cold-start acceptance failed: ${error.stack}\n`);
  throw error;
} finally {
  if (application && application.process().exitCode === null) {
    if (process.platform === 'win32' && nativePid) {
      try { execFileSync('taskkill', ['/PID', String(nativePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already exited */ }
    } else application.process().kill();
  }
  // Terminate only the process IDs recorded by this test's private supervisor.
  const events = fs.existsSync(config.paths.logs) ? fs.readdirSync(config.paths.logs)
    .filter((name) => name.startsWith('supervisor-')).flatMap((name) => fs.readFileSync(path.join(config.paths.logs, name), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))) : [];
  for (const event of [...events.filter((item) => item.event === 'launcher_started'), ...events.filter((item) => item.event === 'healthy')]) {
    if (Number.isInteger(event.pid) && event.pid !== process.pid) {
      try { process.kill(event.pid); } catch { /* already exited */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { process.stderr.write(`Test cleanup retained ${home}: ${error.code}\n`); }
}
