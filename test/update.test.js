/**
 * Update checks against GitHub Releases, and the two places they surface.
 *
 * Everything here runs without a network: the fetch is injected, so the test can
 * be a 200 with a release, a 404, or a hang. The property that matters most is
 * the ugly one -- `updates.check:false` must mean *zero requests*, and a failed
 * check must leave the program working exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const U = await import('../src/core/update.js');
const { VERSION } = await import('../src/core/version.js');
/* A mocked "new release" must ALWAYS be newer than the repo's own version —
   hardcoding '0.9.9' exploded the moment the repo itself shipped 0.9.9
   (current == latest → no notice, and the runtime-state test went red). */
const MOCK_LATEST = (() => { const [M, m] = VERSION.split('.').map(Number); return `${M}.${m + 1}.0`; })();

/** load() reads MAJIN_HOME every call, so an isolated home is one env var. */
function fakeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-upd-'));
  const prev = process.env.MAJIN_HOME;
  process.env.MAJIN_HOME = dir;
  fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
  process.env.MAJIN_WORKSPACE = path.join(dir, 'ws');
  t.after(() => {
    if (prev == null) delete process.env.MAJIN_HOME;
    else process.env.MAJIN_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function cfgFor(t, patch = {}) {
  const home = fakeHome(t);
  const { load } = await import('../src/core/config.js');
  const cfg = load();
  if (Object.keys(patch).length) cfg.patch({ updates: patch }, { source: 'test' });
  return { cfg, home };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new Uint8Array(body).buffer,
  };
}

const RELEASE = (name = 'MAJIN-Setup.exe', size = 3_400_000) => ({
  tag_name: `v${MOCK_LATEST}`,
  html_url: `https://github.com/rssen-debug/slurps/releases/tag/v${MOCK_LATEST}`,
  body: `sha256 ${'a'.repeat(64)} · ${size} bytes · MAJIN ${MOCK_LATEST}`,
  published_at: '2026-10-01T10:00:00Z',
  assets: [{ name, size, browser_download_url: `https://example.invalid/${name}`, id: 7 }],
});

/* ------------------------------- versioning -------------------------------- */
test('versions are compared the way a human expects, and garbage is not fatal', () => {
  assert.deepEqual([U.parseVersion('v0.1.2').major, U.parseVersion('0.1.2').minor, U.parseVersion('0.1.2').patch], [0, 1, 2]);
  assert.equal(U.compareVersions('0.1.0', '0.1.1'), -1, 'older');
  assert.equal(U.compareVersions('0.1.1', '0.1.0'), 1, 'newer');
  assert.equal(U.compareVersions('0.1.1', '0.1.1'), 0, 'same');
  assert.equal(U.compareVersions('0.9.9', '0.10.0'), -1, '10 beats 9 as a number, not a string');
  assert.equal(U.compareVersions('1.0.0', '1.0.1'), -1, 'and the leading 1 does not confuse it');
  assert.equal(U.compareVersions('1.0.0', '1.0.0-beta.1'), 1, 'a release beats its own pre-release');
  assert.equal(U.compareVersions('nonsense', '0.0.1'), -1, 'unparseable is the lowest thing there is');
  assert.equal(U.compareVersions(null, null), 0);
});

test('the notice is one sentence, in English, and empty when there is nothing to say', () => {
  assert.equal(U.notice({ latest: '0.9.9' }, '0.1.0'), 'MAJIN 0.9.9 is available (you have 0.1.0)');
  assert.equal(U.notice({ latest: '0.1.0' }, '0.1.0'), '', 'up to date is not news');
  assert.equal(U.notice({ latest: '0.0.9' }, '0.1.0'), '', 'a downgrade is never announced');
  assert.equal(U.notice({ error: 'offline', silent: true }, '0.1.0'), '', 'a background failure stays quiet');
  assert.match(U.notice({ error: 'offline' }, '0.1.0'), /^update check failed: offline$/, 'but a asked-for failure says what happened');
  assert.equal(U.notice(null, '0.1.0'), '');
});

test('the release body can be used as the checksum source, and parsed back', () => {
  const line = U.manifestLine({ sha256: 'b'.repeat(64), bytes: 4096, version: '0.1.1' });
  const p = U.parseManifestLine(line);
  assert.equal(p.sha256, 'b'.repeat(64));
  assert.equal(p.bytes, 4096);
  assert.deepEqual(U.parseManifestLine('nothing here'), { sha256: null, bytes: null }, 'a body without a manifest line is not an error');
});

/* ------------------------------ the check itself ---------------------------- */
test('a new release is reported, remembered, and not re-asked within the interval', async (t) => {
  const { cfg } = await cfgFor(t, { intervalHours: 24 });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return response(RELEASE());
  };
  const first = await U.checkForUpdate({ cfg, version: '0.1.0', fetchImpl, now: 1_000_000, force: true });
  assert.equal(calls, 1);
  assert.equal(first.latest, MOCK_LATEST);
  assert.equal(first.asset.name, 'MAJIN-Setup.exe');
  assert.equal(first.error, null);
  assert.equal(U.notice(first, '0.1.0'), `MAJIN ${MOCK_LATEST} is available (you have 0.1.0)`);

  const stored = cfg.get('updates');
  assert.equal(stored.latest, MOCK_LATEST, 'the answer is cached in config, so a restart does not re-ask');
  assert.equal(stored.checkedVersion, '0.1.0');
  assert.equal(stored.asset.url, 'https://example.invalid/MAJIN-Setup.exe', 'and the download url comes along');

  const second = await U.checkForUpdate({ cfg, version: '0.1.0', fetchImpl, now: 1_000_000 + 60_000 });
  assert.equal(calls, 1, 'a second call inside the interval must not touch the network again');
  assert.equal(second.skipped, 'too soon');
  assert.equal(second.fromCache, true);
  assert.equal(second.latest, MOCK_LATEST, 'and it still answers from the cache');

  const later = await U.checkForUpdate({ cfg, version: '0.1.0', fetchImpl, now: 1_000_000 + 25 * 3600 * 1000 });
  assert.equal(calls, 2, 'after the interval it asks again');
  assert.equal(later.skipped, undefined);
});

test('check:false means not one request, ever', async (t) => {
  const { cfg } = await cfgFor(t, { check: false });
  let calls = 0;
  const info = await U.checkForUpdate({ cfg, version: '0.1.0', fetchImpl: async () => (calls++, response(RELEASE())), force: true });
  assert.equal(calls, 0, 'disabling the check must disable the fetch, not just the output');
  assert.equal(info.skipped, 'disabled');
  assert.equal(info.silent, true);
});

test('a release page that does not exist yet is a fact, not an error', async (t) => {
  const { cfg } = await cfgFor(t);
  let calls = 0;
  const info = await U.checkForUpdate({
    cfg,
    version: '0.1.0',
    force: true,
    fetchImpl: async () => (calls++, { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }),
  });
  assert.equal(calls, 1);
  assert.equal(info.error, 'no release published yet');
  assert.equal(info.latest, null, 'a 404 must not look like "up to date with version null"');
});

test('a broken network, a proxy or a hang never throws', async (t) => {
  const { cfg } = await cfgFor(t);
  const boom = await U.checkForUpdate({ cfg, version: '0.1.0', force: true, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(boom.error, 'socket hang up');
  assert.equal(boom.notice, undefined, 'the background path reports nothing extra');
  const notJson = await U.checkForUpdate({ cfg, version: '0.1.0', force: true, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }) });
  assert.equal(notJson.error, 'the release JSON could not be read');
  const http500 = await U.checkForUpdate({ cfg, version: '0.1.0', force: true, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(http500.error, 'github said 500');
});

test('a release without an installer still tells the truth about it', async (t) => {
  const { cfg } = await cfgFor(t);
  const info = await U.checkForUpdate({
    cfg,
    version: '0.1.0',
    force: true,
    fetchImpl: async () => response({ tag_name: `v${MOCK_LATEST}`, html_url: 'u', assets: [] }),
  });
  assert.equal(info.latest, MOCK_LATEST);
  assert.equal(info.asset, null);
  assert.match(info.note, /no MAJIN-Setup\.exe/, 'this is exactly the "empty release" case the user asked about');
});

/* -------------------------------- download ---------------------------------- */
test('the download refuses anything that is not a plausible installer', async (t) => {
  const dir = fakeHome(t);
  const mk = (buf) => async () => response(buf);

  const tiny = await U.downloadSetup({ url: 'https://example.invalid/x', dir, fetchImpl: mk(Buffer.alloc(500)) });
  assert.equal(tiny.ok, false);
  assert.match(tiny.error, /500 bytes/, 'an HTML error page is 500 bytes, not an installer');

  const html = await U.downloadSetup({ url: 'https://example.invalid/x', dir, fetchImpl: mk(Buffer.from('<html>404</html>'.padEnd(3_000_000, ' '))) });
  assert.equal(html.ok, false);
  assert.match(html.error, /MZ header/, 'right size, wrong file');

  const noUrl = await U.downloadSetup({ dir, cfg: { get: () => ({}) }, fetchImpl: mk(Buffer.alloc(1)) });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /majin update --check/, 'and it says which command fixes it');

  const good = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2_000_000, 7)]);
  const ok = await U.downloadSetup({ url: 'https://example.invalid/x', dir, fetchImpl: mk(good) });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.bytes, good.length);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(ok.file), true, 'the file lands where it says');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.part')).length, 0, 'no half-written file is left behind');
});

/* ------------------------------ wiring + CLI -------------------------------- */
test('the runtime exposes the update state and the server serves it', async (t) => {
  const home = fakeHome(t);
  process.env.MAJIN_HOME = home;
  process.env.MAJIN_NO_UPDATE_CHECK = '1';
  t.after(() => {
    delete process.env.MAJIN_HOME;
    delete process.env.MAJIN_NO_UPDATE_CHECK;
  });
  const { createRuntime } = await import('../src/core/runtime.js');
  const rt = await createRuntime({ channels: false, scheduler: false });
  try {
    assert.equal(rt.state({ includeTools: false }).update, null, 'nothing checked yet, so nothing to show');
    const info = await rt.update.check({ force: true, fetchImpl: async () => response(RELEASE()) });
    assert.equal(info.latest, MOCK_LATEST);
    const st = rt.state({ includeTools: false });
    assert.equal(st.update.latest, MOCK_LATEST, 'the state carries it to the window');
    assert.match(st.update.notice, /is available/);
    assert.equal(typeof rt.update.download, 'function');
  } finally {
    await rt.shutdown?.();
  }
});

test('majin update works with no network at all and never crashes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-upd-cli-'));
  // deterministically "offline": an impossible repo owner yields a 404 with
  // network and a request error without -- either way `error` must be set.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ updates: { repo: 'majin-offline-test/does-not-exist' } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/majin.js'), 'update', '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, MAJIN_HOME: home, MAJIN_WORKSPACE: path.join(home, 'ws'), MAJIN_NO_UPDATE_CHECK: '1' },
  });
  try {
    assert.equal(r.status, 0, `offline exit ${r.status}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.current, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, 'majin update --json must report the released version, not a hardcoded one');
    assert.ok(j.error || j.latest === null || j.skipped, 'either an error or nothing new: ' + r.stdout.slice(0, 160));
    assert.doesNotMatch(r.stdout + r.stderr, /at Object\.<anonymous>|Uncaught/, 'a failed check must not print a stack trace');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the background check is deferred, unref’d and switchable off', () => {
  const seen = [];
  const timer = U.scheduleUpdateCheck({ cfg: { get: () => ({}) }, version: '0.1.0', onInfo: (i) => seen.push(i) });
  assert.ok(timer, 'a normal boot schedules one');
  assert.equal(timer.hasRef(), false, 'it must not hold the process open');
  clearTimeout(timer);
  process.env.MAJIN_NO_UPDATE_CHECK = '1';
  assert.equal(U.scheduleUpdateCheck({ cfg: { get: () => ({}) }, version: '0.1.0' }), null, 'the env switch is honoured too');
  delete process.env.MAJIN_NO_UPDATE_CHECK;
  assert.equal(U.scheduleUpdateCheck({ cfg: { get: (k) => (k === 'updates' ? { check: false } : {}) }, version: '0.1.0' }), null, 'and so is the config one');
});

test('the window shows a chip for it, in the same language as everything else', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const panels = fs.readFileSync(path.join(ROOT, 'src/ui/panels.js'), 'utf8');
  assert.match(html, /id="c-update" hidden/, 'hidden until there is something to say');
  assert.match(panels, /st\.update/, 'the chip reads the state, not its own guess');
  assert.match(panels, /api\('\/update', \{ method: 'POST'/, 'and one endpoint does the work');
  /* livedelivery 2026-10-18: pa linux/mac hjalper en Windows-EXE i Downloads ingen —
     chippen oppnar release-sidan istallet. Windows one-click sitter kvar ovanfor (install). */
  assert.match(panels, /windows_only/, 'icke-Windows far ett ärligt plattformssvar, inte en blind nedladdning');
  assert.match(panels, /releases/, 'och svaret ar release-sidan, plattformsneutrala originet');
});

test('update checks point at the live repo, and a legacy default is migrated', () => {
  const blank = { get: () => undefined, set: () => {} };
  const slug = U.repoSlug(blank);
  assert.equal(slug.owner + '/' + slug.repo, 'rssen-debug/MAJINCLI', 'fresh installs never ask the archived repo');

  const writes = [];
  const legacy = { get: (k) => (k === 'updates.repo' ? 'rssen-debug/slurps' : undefined), set: (k, v) => writes.push([k, v]) };
  const migrated = U.repoSlug(legacy);
  assert.equal(migrated.repo, 'MAJINCLI', 'the old archived repo no longer swallows update checks');
  assert.deepEqual(writes, [['updates.repo', 'rssen-debug/MAJINCLI']], 'and the fix is persisted so it only happens once');
});

test('the silent-update relaunch is a real watchdog script, byte-verified', () => {
  const pid = 4711;
  const encoded = U.relaunchCommand(pid);
  /* decode exactly the way PowerShell -EncodedCommand will read it */
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const fresh = U.relaunchScript(pid);
  assert.equal(script, fresh, 'base64 roundtrip must be lossless — a mangled watchdog silently never relaunches the app');
  assert.match(script, /Get-Process -Id 4711/, 'it waits for the installer process');
  assert.match(script, /AddMinutes\(15\)/, 'a give-up deadline so it never lingers');
  assert.match(script, /Stop-Process -Force/, 'leftover exes are cleaned before start');
  assert.match(script, /majin-win-x64\.exe/, 'it targets the installed exe');
  assert.match(script, /-ArgumentList 'start'/, 'the relaunched app opens its visible user window');
  assert.doesNotMatch(script, /--no-window/, 'update must not silently relaunch headless');
  assert.match(script, /update-relaunch\.log/, 'every step is logged — a failed relaunch must be debuggable');
});

test('Windows updater acknowledges only a successfully spawned installer', { skip: process.platform !== 'win32' }, async (t) => {
  const { EventEmitter } = await import('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-update-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1_100_000)]);
  const options = { dir, url: 'https://example.invalid/installer.exe', cfg: { get: () => ({}) }, fetchImpl: async url => String(url).endsWith('.sha256') ? new Response('', { status: 404 }) : new Response(bytes) };
  let calls = 0;
  const failed = await U.installSetup({ ...options, spawnImpl: () => {
    calls++;
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', new Error('fixture EACCES')));
    return child;
  } });
  assert.equal(failed.ok, false);
  assert.equal(calls, 1, 'failed installer must not launch a restart watchdog');
  calls = 0;
  const started = await U.installSetup({ ...options, spawnImpl: (_file, _args, spawnOptions) => {
    calls++;
    assert.equal(spawnOptions.windowsHide, true);
    const child = new EventEmitter(); child.pid = 1234; child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  } });
  assert.equal(started.ok, true);
  assert.equal(calls, 2, 'successful installer receives a detached restart watchdog');
});
