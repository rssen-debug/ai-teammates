/* MAJIN LIVE DELIVERY — uppdateringskedjan som bevis: status-state i datan,
   plattforms-sortet svarast, opencode-providern, och release-bumpningen.
   Fail-first: status-fältet och de här bitarna finns inte än. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ld-'));

const { checkForUpdate, notice, compareVersions, installSetup } = await import('../src/core/update.js');
const { PRESETS } = await import('../src/core/presets.js');
const { createRuntime } = await import('../src/core/runtime.js');

const freshCfg = async () => {
  /* egen home per anrop — annars gor write() i test 1 att test 2 "minns" fel latest */
  process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ld-cfg-'));
  const { load } = await import('../src/core/config.js');
  return load();
};

test('update-svar bär en ärlig status (up_to_date / available / error / disabled)', async () => {
  const cfg = await freshCfg();
  /* up_to_date: samma version som lagd release */
  const same = await checkForUpdate({
    cfg, version: '0.5.4', force: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.5.4', assets: [], html_url: 'https://example/' }) }),
  });
  assert.equal(same.status, 'up_to_date', `samma version ska uttryckligen säga up_to_date, fick: ${same.status}`);
  /* available: nyare release */
  const newer = await checkForUpdate({
    cfg, version: '0.5.0', force: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.6.0', assets: [{ name: 'MAJIN-Setup.exe', size: 40000000, browser_download_url: 'https://x/installer' }], html_url: 'https://example/' }) }),
  });
  assert.equal(newer.status, 'available');
  /* error: nätverket sprack, men status säger det rent */
  const dead = await checkForUpdate({
    cfg, version: '0.5.4', force: true,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(dead.status, 'error');
  /* disabled: inga anrop över huvud taget + status off */
  const cfg2 = await freshCfg();
  cfg2.patch({ updates: { check: false } }, { persist: false });
  let calls = 0;
  const off = await checkForUpdate({ cfg: cfg2, version: '0.5.4', force: true, fetchImpl: async () => { calls++; return { ok: false, status: 0 }; } });
  assert.equal(calls, 0, 'avstängd check ska göra NOLL nätverksanrop');
  assert.equal(off.status, 'disabled');
});

test('på samma version syns aldrig en uppdaterings-notis (K-fallet)', async () => {
  const cfg = await freshCfg();
  const info = await checkForUpdate({
    cfg, version: '0.5.4', force: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.5.4', assets: [], html_url: 'https://example/' }) }),
  });
  assert.equal(notice(info, '0.5.4'), '', 'samma version = tyst');
  assert.equal(compareVersions('0.5.4', 'v0.5.4'), 0);
});

test('installer-vägen säger ärligt windows_only MED releasesidan som vägledning (linux/mac)', { skip: process.platform === 'win32' && 'non-Windows contract; real installer verified by Windows CI' }, async () => {
  const cfg = await freshCfg();
  const r = await installSetup({ cfg });
  /* i Linux-sandboxen ALLTID windows_only — och svarsfältet måste hjälpa, inte spam-a Downloads */
  assert.equal(r.ok, false);
  assert.equal(r.error, 'windows_only');
  assert.ok(r.releaseUrl && /github\.com.+releases/i.test(r.releaseUrl), `linux/mac-användare ska få release-länken, fick: ${JSON.stringify(r)}`);
});

test('opencode-providern finns, pekar rätt och bär sin obligatoriska session-header', () => {
  const p = PRESETS.opencode;
  assert.ok(p, 'PRESETS.opencode saknas');
  assert.match(p.baseUrl, /opencode\.ai\/zen\/go\/v1/, p.baseUrl);
  assert.equal(p.kind, 'openai');
  assert.ok(p.headers && p.headers['x-opencode-session'], 'x-opencode-session-header måste följa med — gatewayen vägrar annars routing');
  assert.ok(p.models.length >= 3, `minst några free/flash-modeller ska vara listade, fick: ${p.models}`);
  assert.ok(p.models.some((m) => /flash|free/i.test(m)), 'free/flash-modell ska finnas i listan');
  assert.equal(p.apiKey ?? null, null, 'preset får aldrig bära en riktig nyckel');
});

test('/api/provider visar preset-headers i den sparade providern (annars dör samtalen)', async () => {
  process.env.MAJIN_NO_UPDATE_CHECK = '1';
  const rt = await createRuntime({ channels: false, scheduler: false });
  const { createServer } = await import('../src/core/server/index.js');
  const srv = createServer(rt);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const token = rt.cfg.get('server.token');
  const res = await fetch(`http://127.0.0.1:${port}/api/provider?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ preset: 'opencode', apiKey: 'oc_sk_TESTKEY_NOT_REAL' }),
  });
  const j = await res.json();
  assert.equal(j.ok, true, JSON.stringify(j).slice(0, 300));
  const saved = rt.cfg.get('providers.opencode');
  assert.ok(saved, 'providern sparades inte');
  assert.ok(saved.headers && saved.headers['x-opencode-session'], 'headers followde inte med in i config — samtalen skulle 400:a mot gatewayen');
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  await rt.shutdown();
});

test('release-bump: monotont, synkar version.js+package+lock+iss, vägrar dublett', async () => {
  const { planBump } = await import('../scripts/bump-version.mjs');
  /* högre är ok */
  const ok = planBump('0.5.5', { current: '0.5.4', releasedTags: ['v0.5.4', 'v0.5.3'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.version, '0.5.5');
  /* samma tag som en publicerad release = stopp, aldrig skriv över */
  const dup = planBump('0.5.4', { current: '0.5.5', releasedTags: ['v0.5.4'] });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /published|exists|overwrite/i);
  /* bakåt = stopp */
  const back = planBump('0.5.3', { current: '0.5.4', releasedTags: ['v0.5.4'] });
  assert.equal(back.ok, false);
  assert.match(back.error, /higher|newer/i);
  /* skräp = stopp */
  assert.equal(planBump('version-fem', { current: '0.5.4', releasedTags: [] }).ok, false);
});

test('release-bump applicerar alla fyra versions-källor i verkliga filer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-bump-'));
  const { applyBump } = await import('../scripts/bump-version.mjs');
  fs.mkdirSync(path.join(dir, 'installer'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.4', dependencies: { a: '1.0.0' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '0.5.4', lockfileVersion: 3, packages: { '': { name: 'x', version: '0.5.4', dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'core', 'version.js'), "export const VERSION = '0.5.4';\n");
  fs.writeFileSync(path.join(dir, 'installer', 'majin.iss'), "#define MyAppVersion \"0.5.4\"\n[Setup]\n");
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'publish.ps1'), "[string]$Version = '0.5.4',\n");
  const r = applyBump(dir, '0.5.5');
  assert.equal(r.changed.length, 5, JSON.stringify(r.changed));
  assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /"version": "0\.5\.5"/);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.5.5');
  assert.equal(lock.packages[''].version, '0.5.5');
  assert.equal(lock.packages['node_modules/a'].version, '1.0.0', 'dependency-versioner i locken rörs ALDRIG');
  assert.match(fs.readFileSync(path.join(dir, 'src', 'core', 'version.js'), 'utf8'), /VERSION = '0\.5\.5'/);
  assert.match(fs.readFileSync(path.join(dir, 'installer', 'majin.iss'), 'utf8'), /MyAppVersion "0\.5\.5"/);
  assert.match(fs.readFileSync(path.join(dir, 'scripts', 'publish.ps1'), 'utf8'), /\$Version = '0\.5\.5'/);
});
