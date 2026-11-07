/**
 * Varuma MAJIN ser ut och hur man far den pa skrivbordet: M-loggan som ikon och
 * i terminalen, rosa palett, och genvagen som den fristande exe:n sjalv skapar.
 * Allt mats pa filerna och kommandot — inget kraver en webblisare.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { LOGO_ROWS, logoArt } = await import('../src/cli/banner.js');
const SC = await import('../src/core/shortcut.js');

/* ---------------- bilderna som ska finnas pa riktigt ---------------- */
test('assets: the M exists as png, ico and ui logo, and is the thing the UI shows', () => {
  const pngs = ['assets/majin.png', 'assets/majin-256.png', 'assets/majin-transparent.png', 'src/ui/logo.png'];
  for (const f of pngs) {
    const b = fs.readFileSync(path.join(ROOT, f));
    assert.equal(b.slice(0, 8).toString('hex'), '89504e470d0a1a0a', `${f} must be a real PNG`);
  }
  const ico = fs.readFileSync(path.join(ROOT, 'assets/majin.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ico: reserved must be 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ico: type must be 1 (icon)');
  assert.ok(ico.readUInt16LE(4) >= 6, `ico must carry sizes for taskbar..desktop, got ${ico.readUInt16LE(4)}`);
  const big = Number(fs.readFileSync(path.join(ROOT, 'assets/majin-256.png')).length);
  assert.ok(big > 5000, 'a 1x1 placeholder is not an icon');
  assert.ok(fs.readFileSync(path.join(ROOT, 'src/ui/logo.png')).length < 300000, 'the UI logo ships inside the exe — keep it small');
});

test('the workflow file is valid YAML, with the node pin and the release asset still in place', async (t) => {
  let yaml;
  try {
    yaml = (await import('js-yaml')).default || (await import('js-yaml'));
  } catch {
    // js-yaml is a devDependency, and a bare clone that only wants to *run* MAJIN
    // never installs it. A missing test helper is a skip, never a red suite.
    return t.skip('js-yaml is not installed — npm i -D js-yaml to enable this check');
  }
  const doc = yaml.load(read('.github/workflows/build-exe.yml'));
  const job = doc.jobs.exe;
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job.steps.find((s) => s.uses && s.uses.includes('setup-node')).with['node-version'], '22.23.2', 'pkg needs this exact host binary');
  const rel = job.steps.find((s) => s.uses && s.uses.includes('action-gh-release'));
  assert.match(rel.with.files, /dist\/majin-win-x64\.exe/);
  const build = job.steps.find((s) => s.name === 'build the exe');
  assert.match(build.run, /Test-Path dist\/majin-win-x64\.exe/, 'the step must fail when no exe came out');
});

test('ui: the header and the tab use the M image, not a second drawn shape to keep in sync', () => {
  const html = read('src/ui/index.html');
  assert.match(html, /<img class="logo" src="\/logo\.png"/, 'the header must use the same M as the icon');
  assert.match(html, /rel="icon" type="image\/png" href="\/logo\.png\?v=__MAJIN_FAVICON_VERSION__"/, 'favicon must be versioned to refresh Windows Edge app icon');
  const server = read('src/core/server/index.js');
  assert.match(server, /p === '\/logo\.png'/, 'server must serve one canonical favicon route');
  assert.match(server, /assets\/majin\.png/, 'browser app icon must use the same pink source as Windows installer');
  assert.match(server, /__MAJIN_FAVICON_VERSION__/, 'favicon cache key comes from actual running version');
  const build = read('scripts/build-exe.mjs');
  assert.match(build, /copyFileSync\(path\.join\(root, 'assets', 'majin\.png'\), path\.join\(dist, 'ui', 'logo\.png'\)\)/,
    'packaged UI icon must be the exact same PNG bytes as Windows installer');
  assert.doesNotMatch(html, /<svg class="logo"/, 'no second logo to keep in sync');
});

/* ---------------- rosa, som anvandaren bad om ---------------- */
test('ui: the palette is pink edge to edge, not blue with a pink accent', () => {
  const html = read('src/ui/index.html');
  const root = /:root\{([^}]*)\}/.exec(html)?.[1] || '';
  const vars = Object.fromEntries(root.split(';').filter(Boolean).map((kv) => kv.split(':').map((x) => x.trim())));
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const key of ['--cy', '--pink', '--line']) {
    assert.match(String(vars[key]), /^#[0-9a-f]{6}$/i, `${key} must be a hex colour`);
    const [r, g, b] = rgb(vars[key]);
    assert.ok(r > g && r >= b, `${key}=${vars[key]} should be pink: red must lead`);
  }
  const [br, bg, bb] = rgb(vars['--bg']);
  assert.ok(br >= bg && bb >= bg && br < 30, `--bg=${vars['--bg']} should be near-black with a warm cast, not blue`);
  assert.doesNotMatch(html, /#57e6ff|#0f7f9c|#04070a|#bfeaf7/, 'the old cyan theme must not survive anywhere in the file');
  const light = /body\.light\{([^}]*)\}/.exec(html)?.[1] || '';
  const lc = /--cy:(#[0-9a-f]{6})/.exec(light)?.[1];
  assert.ok(lc, 'the light theme needs its own pink');
  const [lr, lg, lb] = rgb(lc);
  assert.ok(lr > lg && lr > lb, `light --cy=${lc} should be a deep pink`);
});

/* ---------------- loggan i terminalen ---------------- */
test('banner: the pixel M reads as an M and degrades politely without colour or Unicode', (t) => {
  for (const name of ['NO_COLOR', 'MAJIN_NO_COLOR']) {
    const original = process.env[name];
    delete process.env[name];
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
  assert.ok(LOGO_ROWS.length >= 8, 'a M needs some height');
  for (const row of LOGO_ROWS) assert.ok(row.length <= 60, `row too wide for an 80-col terminal: ${row.length}`);
  assert.ok(LOGO_ROWS.some((r) => r.includes('█')), 'solid blocks must be used, not only dots');
  const plain = logoArt({ color: false });
  assert.ok(!plain.includes(String.fromCharCode(27)), 'color:false must not emit escapes');
  assert.ok(plain.split('\n').length === LOGO_ROWS.length, 'one line per row');
  const ascii = logoArt({ color: false, ascii: true });
  assert.match(ascii, /#/, 'ascii mode must draw with #');
  assert.doesNotMatch(ascii, /[▄▀█]/, 'and never emit block characters');
  assert.match(logoArt(), /38;2;/, 'colour mode uses truecolor, so the pink is the same pink as the icon');
  process.env.NO_COLOR = '1';
  assert.ok(!logoArt().includes(String.fromCharCode(27)), 'NO_COLOR is respected');
  delete process.env.NO_COLOR;
});

test('cli: the start banner draws the M and the help knows the shortcut command', () => {
  const src = read('src/cli/majin.js');
  const bannerStart = src.indexOf('const shortcutLine = ensureDesktopShortcut(flags);');
  assert.ok(bannerStart > 0, 'serve() must install the desktop shortcut before it prints');
  assert.ok(src.indexOf('logoArt()') < src.indexOf('listening on'), 'the M comes before the text');
  assert.match(src, /case 'shortcut':/, 'majin shortcut must be a command');
  assert.match(src, /majin shortcut \[--remove\]/, 'and it must be in the help text');
});

/* ---------------- skrivbordsgenvagen ---------------- */
test('shortcut: --print shows exactly what would run and touches nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-sc-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli/majin.js'), 'shortcut', '--print', '--name', "MAJIN's", '--target', 'C:\\a\\b.exe'], {
    encoding: 'utf8',
    env: { ...process.env, MAJIN_HOME: home, USERPROFILE: home, HOME: home, MAJIN_WORKSPACE: path.join(home, 'ws') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CreateShortcut\('/, 'the snippet is real PowerShell: ' + r.stdout.slice(0, 120));
  assert.match(r.stdout, /TargetPath = 'C:\\a\\b\.exe'/, r.stdout);
  assert.match(r.stdout, /IconLocation/, 'the icon rides along, so the taskbar shows the M');
  assert.match(r.stdout, /MAJIN\.lnk/, 'a name with a quote is refused and falls back, never spliced');
  assert.equal(SC.quotePs("it's"), "it''s", 'and real quoting still doubles what must be doubled');
  const left = fs.readdirSync(home).filter((f) => f.endsWith('.lnk'));
  assert.deepEqual(left, [], 'nothing may be written by --print');
  fs.rmSync(home, { recursive: true, force: true });
});

test('shortcut: names are sanitised, OneDrive desktops are found, non-Windows says so', () => {
  assert.equal(SC.shortcutName('MAJIN'), 'MAJIN');
  assert.equal(SC.shortcutName('bad | name; rm'), 'MAJIN', 'a hostile name falls back instead of reaching the shell');
  assert.equal(SC.shortcutName('Desk-top (2)'), 'Desk-top (2)', 'ordinary names survive');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-sc2-'));
  const od = path.join(home, 'OneDrive', 'Desktop');
  fs.mkdirSync(od, { recursive: true });
  assert.equal(SC.desktopDir({}, home), od, 'OneDrive redirection is the common Windows case');
  const file = SC.shortcutFile({ dir: home, name: 'MAJIN' });
  assert.equal(file, path.join(home, 'MAJIN.lnk'));
  const r = SC.shortcutAction({ action: 'create', dir: home });
  if (process.platform === 'win32') {
    assert.equal(r.ok, true, r.error);
  } else {
    assert.equal(r.code, 'not_windows', 'on other systems it says so and still shows the command');
    assert.match(r.script, /WScript\.Shell/);
    assert.equal(r.ran, false);
    assert.equal(fs.existsSync(file), false, 'and writes nothing');
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('exe build: the icon rides along, and a failed patch may not be reported as a success', () => {
  const build = read('scripts/build-exe.mjs');
  assert.match(build, /majin-win-x64\.exe/, 'the win target is the one a normal user double-clicks');
  assert.match(build, /no binary was produced/, 'a missing binary must fail the build, not print a note');
  const wf = read('.github/workflows/build-exe.yml');
  assert.match(wf, /dist\/majin-win-x64\.exe/, 'and the exe goes onto the release, since artifact storage is gone');
  assert.match(wf, /dist\/setup\/majin-setup\.exe/, 'next to the installer, which pkg cannot veto');
  assert.doesNotMatch(wf, /actions\/upload-artifact/, 'no artifact step to die on any more');
  assert.match(build, /set-icon\.mjs/, 'the win build embeds the M into the exe');
  assert.match(build, /MAJIN_NO_ICON/, 'and that step can be turned off');
});

test('the window always names its own version', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="v-tag"/, 'a version tag exists in the header');
  assert.match(html, /__MAJIN_VERSION__/, 'filled from the served version, never hardcoded');
});
