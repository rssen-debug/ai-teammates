import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { startTestServer } from '../../test/v4/helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.MAJIN_V4_DESKTOP_EVIDENCE || path.join(root, 'docs/v4/evidence');
fs.mkdirSync(evidence, { recursive: true });
const server = await startTestServer();
const executablePath = process.env.MAJIN_V4_DESKTOP_EXE
  || path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
let application;
try {
  application = await _electron.launch({
    executablePath,
    args: process.env.MAJIN_V4_DESKTOP_EXE ? [] : [path.join(root, 'desktop')],
    env: { ...process.env, MAJIN_HOME: server.home,
      MAJIN_V4_DESKTOP_URL: server.base, MAJIN_V4_DESKTOP_NO_HOST: '1',
      MAJIN_V4_DESKTOP_PROFILE: path.join(server.home, 'desktop-profile') },
  });
  const page = await application.firstWindow();
  await page.waitForSelector('#gate-code');
  await page.fill('#gate-code', server.context.pairingFresh);
  await page.click('#gate-submit');
  await page.waitForSelector('#gate', { state: 'hidden' });
  await page.fill('#input', 'Write file desktop-smoke.txt with content: verified desktop');
  await page.click('#send-btn');
  await page.waitForSelector('.tool[data-state="verified"]', { timeout: 15_000 });
  assert.equal(fs.readFileSync(path.join(server.home, 'workspace/desktop-smoke.txt'), 'utf8'), 'verified desktop');
  const prefs = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const p = win.webContents.getLastWebPreferences();
    return { nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, contextIsolation: p.contextIsolation };
  });
  assert.deepEqual(prefs, { nodeIntegration: false, sandbox: true, contextIsolation: true });
  await page.screenshot({ path: path.join(evidence, 'windows-desktop-chat.png') });
  fs.writeFileSync(path.join(evidence, 'desktop-smoke.json'), JSON.stringify({
    at: new Date().toISOString(), executablePath, nativeWindow: true, pairing: true,
    verifiedFile: true, inference: 'demo (not a live provider)', preferences: prefs,
  }, null, 2));
  process.stdout.write('PASS native desktop window, pairing, real HTTP chat, verified file, renderer isolation\n');
} finally {
  await application?.close();
  await server.close();
}
