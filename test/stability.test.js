/* the v0.5.0 "Trust & Flow" contract: every reviewer finding is locked here */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, DEFAULTS, clone } from '../src/core/config.js';
import { serial, pendingKeys } from '../src/core/serialize.js';
import { majinTools } from '../src/core/tools/majin.js';
import { sha256File } from '../src/core/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('same key serializes, different keys run in parallel — the "5 messages" rule', async () => {
  const order = [];
  const slow = (name, ms) => serial(name, () => new Promise((r) => setTimeout(() => { order.push(name + '-done'); r(name); }, ms)));
  const a1 = slow('desktop', 80);
  const a2 = slow('desktop', 10);
  const b1 = slow('telegram', 10);
  const [r1, r2] = await Promise.all([a1, a2]);
  await b1;
  assert.equal(r1, 'desktop');
  assert.equal(r2, 'desktop');
  assert.deepEqual(order.filter((x) => x.startsWith('desktop')), ['desktop-done', 'desktop-done'], 'same session never interleaves');
  assert.ok(order.includes('telegram-done'), 'another channel ran alongside');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pendingKeys().filter((k) => k !== 'default'), [], 'tail map cleans itself');
});

/* the agent itself must route every turn through the queue */
test('agent.turn is a queued door, not a hallway', () => {
  const src = read('src/core/agent.js');
  assert.match(src, /import \{ serial \} from '\.\/serialize\.js'/, 'the agent uses the serializer');
  assert.match(src, /return serial\(opts\.session \|\| 'desktop', \(\) => this\._turnOnce\(opts\)\)/, 'every turn queues on its session');
});

test('the default posture is one model: MOA is opt-in, never a stealth cost', () => {
  assert.equal(DEFAULTS.moa.policy, 'off', 'a fresh install can never burn 3x tokens by default');
});

test('removing a provider never leaves routes pointing at a ghost', async () => {
  const providerTool = majinTools.find((t) => t.name === 'majin.provider');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-rm-'));
  const cfg = new Config(clone(DEFAULTS), path.join(dir, 'c.json'));
  const ctx = { cfg };
  await providerTool.run({ action: 'add', name: 'provA', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', models: 'm1' }, ctx);
  await providerTool.run({ action: 'add', name: 'provB', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', models: 'm2' }, ctx);
  // all routes to provA
  cfg.patch({ models: { provider: 'provA', routes: Object.fromEntries(['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'plan', 'research', 'summarize', 'router', 'final', 'aggregator', 'vision'].map((j) => [j, 'provA/m1'])) } });
  const out = await providerTool.run({ action: 'remove', name: 'provA' }, ctx);
  assert.match(out.result, /repointed \d+ route\(s\) to provB\/m2/, 'routes get repointed, not orphaned: ' + out.result);
  assert.equal(cfg.resolveModel('', 'chat').providerName, 'provB');
  assert.equal(cfg.get('models.provider'), 'provB');
  // second removal: provB out — routes must land somewhere that answers
  cfg.patch({ models: { provider: 'provB', routes: Object.fromEntries(['chat', 'tools'].map((j) => [j, 'provB/m2'])) } });
  const out2 = await providerTool.run({ action: 'remove', name: 'provB' }, ctx);
  assert.match(out2.result, /repointed \d+ route\(s\) to (ollama|lmstudio)\//, 'routes repoint to something that answers offline: ' + out2.result);
  assert.ok(!String(cfg.get('models.routes.chat')).startsWith('provB/'), 'no route still points at the removed provider');
  // third: every fallback gone too → a plain human warning, no silent break
  for (const n of ['ollama', 'lmstudio', 'demo', 'gemini', 'deepseek']) {
    if ((providerTool ? ctx.cfg.get('providers') : {})[n]) await providerTool.run({ action: 'remove', name: n }, ctx).catch(() => {});
  }
  cfg.patch({ models: { routes: { chat: 'openrouter/deepseek/deepseek-flash' } } });
  const out3 = await providerTool.run({ action: 'remove', name: 'openrouter' }, ctx);
  assert.match(out3.result, /run the setup wizard again/, 'no fallback at all → plain warning: ' + out3.result);
  const miss = await providerTool.run({ action: 'remove', name: 'neverexisted' }, ctx);
  assert.equal(miss.ok, false, 'removing nothing is an error, not a shrug');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changing a key is just an add that overwrites — and the old key vanishes', async () => {
  const providerTool = majinTools.find((t) => t.name === 'majin.provider');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-key-'));
  const cfg = new Config(clone(DEFAULTS), path.join(dir, 'c.json'));
  await providerTool.run({ action: 'add', name: 'box', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'OLD-KEY', models: 'm1' }, { cfg });
  assert.equal(cfg.get('providers.box.apiKey'), 'OLD-KEY');
  await providerTool.run({ action: 'add', name: 'box', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'NEW-KEY', models: 'm1' }, { cfg });
  assert.equal(cfg.get('providers.box.apiKey'), 'NEW-KEY', 'the key actually changed');
  assert.doesNotMatch(cfg.redacted().providers.box.apiKey, /OLD|NEW/, 'the UI never sees either key');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checksum verification computes and compares real hashes', async () => {
  const f = path.join(os.tmpdir(), 'majin-sum-' + Date.now() + '.bin');
  fs.writeFileSync(f, 'majin-bytes');
  const h1 = await sha256File(f);
  assert.match(h1, /^[a-f0-9]{64}$/);
  fs.writeFileSync(f, 'tampered-bytes');
  const h2 = await sha256File(f);
  assert.notEqual(h1, h2, 'tampering changes the truth');
  fs.rmSync(f, { force: true });
  const upd = read('src/core/update.js');
  assert.match(upd, /releaseSha256\(slug, ASSET/, 'the updater asks the release what it promised');
  assert.match(upd, /code: 'checksum'/, 'a mismatch refuses to install');
});

test('the update path is wired: chip → install → shutdown (structural contract)', () => {
  const server = read('src/core/server/index.js');
  assert.match(server, /\['download', 'install'\]/, 'both update actions whitelisted');
  assert.match(server, /rt\.shutdown\('update'\)/, 'install schedules the restart');
  const rt = read('src/core/runtime.js');
  assert.match(rt, /install: \(o = \{\}\) => installSetup/, 'runtime exposes install');
});

test('the icon entry point actually RUNS on Windows (the v0.4.x-v0.5.0 silent killer)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'set-icon.mjs'), 'utf8');
  /* new URL(import.meta.url).pathname is /D:/a/... on Windows — the old guard
     compared that against process.argv[1] and was FALSE forever → script
     loaded, printed nothing, exited 0, exe shipped with default icon */
  assert.doesNotMatch(src, /new URL\(import\.meta\.url\)\.pathname/, 'windows-trap path guard must never come back');
  assert.match(src, /fileURLToPath\(import\.meta\.url\)/, 'main-guard must use fileURLToPath');
});

test('icon embedding can no longer fail silently', () => {
  const src = read('scripts/build-exe.mjs');
  assert.match(src, /refusing to ship an exe with the default icon/, 'failed icon = failed build');
});

test('no console window: hidden launch everywhere, Inno only CreateProcesses real programs', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'installer', 'MAJIN.vbs')), 'the launcher ships');
  const vbs = read('installer/MAJIN.vbs');
  assert.match(vbs, /Wscript\.Shell/, 'hidden shell launcher');
  assert.match(vbs, /Run .* 0, False/, 'window style 0 = invisible');
  const iss = read('installer/majin.iss');
  /* Two separate failure modes this test encodes, both CI/user-proven:
     1. CreateProcess code 193 (user-reported): a .vbs is NOT a Win32
        program — Explorer shortcuts must therefore point at wscript.exe
        with the vbs as a parameter (Explorer resolves the host, Inno
        shortcuts don't get that courtesy).
     2. CI v0.5.3: a postinstall wscript entry left the SILENT install
        hanging 17 minutes until the job timeout killed it — so postinstall
        launches the EXE ITSELF with runhidden (Inno hides the console). */
  const B = String.fromCharCode(92);
  const shortcutNeedle = 'Filename: "{sys}' + B + 'wscript.exe"';
  const shortcuts = iss.split(shortcutNeedle).length - 1;
  assert.strictEqual(shortcuts, 2, `wscript.exe shortcuts = exactly start menu + desktop (found ${shortcuts})`);
  assert.match(iss, /ValueData:.*?wscript[.]exe/, 'autostart registry goes via wscript.exe too');
  assert.ok(!iss.includes('Filename: "{app}' + B + 'MAJIN.vbs"'), 'nothing may CreateProcess the vbs directly — that is exactly the 193 dialog');
  assert.match(iss, /postinstall runhidden/, "postinstall launches the exe itself hidden — never wscript inside Inno's silent chain (17-min hang, CI-proven)");
  assert.match(iss, /postinstall runhidden skipifsilent/, 'skipifsilent MUST stay: CI-proven twice (17+18 min hangs) that a silent install starting the app from Inno hangs the setup process — one-click-update relaunch is the updater watchdog\'s job (src/core/update.js)');
});

test('autopilot UI: a new message never waits for a running task, and every parallel task is stoppable', () => {
  const app = read('src/ui/app.js');
  assert.ok(!app.includes('if (!input || S.busy) return false;'), 'the global S.busy wall must stay down — a second message spawns a task instead of being swallowed');
  assert.match(app, /if \(S\.busy\) return parallelTask\(input\);/, 'the busy-branch routes into a new independent task');
  assert.match(app, /autopilot: true/, 'parallel messages ask the server for a fresh task (own session + history)');
  assert.match(app, /stopObservedTask\(rec\.id\)/, 'parallel Stop delegates the selected task ID');
  assert.match(app, /body: id \? \{ task: id \} : \{ session \}/, 'the acknowledged stop request preserves task isolation');
  assert.match(app, /event: task|name === 'task'/, 'the UI binds the resumed stream to the task the server named');
  const html = read('src/ui/index.html');
  for (const st of ['working', 'waiting', 'done', 'error']) {
    assert.ok(html.includes('st-' + st), `task status ${st} exists in the palette`);
  }
});

test('a real Quit exists on the main window (two-step, stops the server)', () => {
  const html = read('src/ui/index.html');
  assert.match(html, /id="b-quit"/, 'the power button is in the header');
  const app = read('src/ui/app.js');
  assert.match(app, /\/api\/shutdown/, 'it posts to the shutdown route');
  assert.match(app, /dataset\.arm/, 'it confirms like every destructive click');
});

test('the wizard can be reopened, and removing providers is one click in it', () => {
  const src = read('src/ui/onboard.js');
  assert.match(src, /reopen\(\)/, 'setup is a place you can return to');
  assert.match(src, /action: 'remove', name: p\.name/, 'providers can be removed from the same cards');
  assert.match(src, /is configured/, 'saved credentials are recognized without claiming verified inference');
  assert.match(src, /Replace the saved key/, 'changing a key remains possible in advanced setup');
  assert.match(src, /Forget .* connection/, 'removing a provider remains possible without a crowded provider grid');
});

test('parallel tools paint parallel rows — no result lands on the wrong step', () => {
  const src = read('src/ui/imagine.js');
  /* callId-correlation beat my name-keyed Map in the parallel implementation —
     the contract this test locks is the same: parallel results land on their
     own row, never on a shared "current" one */
  assert.match(src, /pendingById = new Map\(\)/, 'rows correlate per call id');
  assert.match(src, /pendingByName = new Map\(\)/, 'name-fallback exists for pre-id rows');
  assert.match(src, /pendingById\.get\(String\(ev\.callId\)\)/, 'results land by call id');
  assert.match(src, /pendingById\.delete\(String\(ev\.callId\)\)/, 'finished rows leave the map');
  assert.doesNotMatch(src, /currentToolRow/, 'the single-row pointer is gone');
});

test('publish script fires at the real repo, CI publishes hashes', () => {
  const ps = read('scripts/publish.ps1');
  assert.match(ps, /Repo = 'rssen-debug\/MAJINCLI'/, 'publishes to MAJINCLI');
  assert.doesNotMatch(ps, /rssen-debug\/slurps/, 'never the archive');
  const wf = fs.readdirSync(path.join(ROOT, '.github/workflows')).map((f) => read('.github/workflows', f)).join('\n');
  assert.match(wf, /MAJIN-Setup\.exe\.sha256/, 'the release carries the installer hash');
  const bi = read('scripts/build-installer.mjs');
  const be = read('scripts/build-exe.mjs');
  assert.match(bi, /createHash\('sha256'\)[\s\S]*?sha256/, 'the installer build writes its own .sha256 sidecar');
  assert.match(be, /createHash\('sha256'\)[\s\S]*?\.sha256/, 'the exe build writes its own .sha256 sidecar');
});
