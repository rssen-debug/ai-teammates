/**
 * MAJIN — release gate (§12 RELEASE_READY, executable).
 * Runs the LOCAL, deterministic half of the release contract and exits 1 on
 * any failure. Online checks (release assets exist + sha256 match) run only
 * with --online and need MAJIN_GH_TOKEN or GITHUB_TOKEN set. The gate never
 * manufactures readiness: it verifies and reports.
 *
 * Checks (local, always):
 *   1. version literals consistent across the five release files
 *   2. acceptance-matrix integrity (all five totals agree — matrix-check)
 *   3. DEV_CONTINUATION checkpoint exists, valid JSON, carries lastVerifiedMain
 *   4. no *.sha256-/key-bearing stray files in the repo tree (secret hygiene)
 * Checks (--online, optional):
 *   5. latest release for the package version has 4 assets
 *   6. both .exe assets hash-match their published .sha256
 *
 * Usage: node scripts/release-gate.mjs [--online] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { checkMatrixFile } from './matrix-check.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ONLINE = args.includes('--online');
const ASJSON = args.includes('--json');

const results = [];
const fail = (name, detail) => results.push({ check: name, ok: false, detail });
const pass = (name, detail = '') => results.push({ check: name, ok: true, detail });

/* 1 — version literals across the five release files */
function checkVersionLiterals() {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  /* W11 postmortem (2026-10-20): a wave once shipped a lock with ZERO packages
     (corrupt) — npm ci died in CI. The lock must carry real structure, not
     just two version strings. */
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const lockPkgCount = Object.keys(lock.packages || {}).length;
  const spots = [
    ['package.json', JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version],
    ['package-lock.json root', lock.version],
    ['package-lock.json packages[""]', lock.packages[''].version],
    ['package-lock.json structure', lockPkgCount > 10 ? v : `(CORRUPT: only ${lockPkgCount} package entries — must be the full graph)`],
  ];
  /* containment rule (how the wave-bump actually writes): every release
     file must carry the CURRENT version string. First-match extraction was
     rejected: version.js also contains display-name examples (0.1.1) and
     publish.ps1 carries usage examples (0.5.4) that are NOT the version. */
  for (const extra of ['src/core/version.js', 'installer/majin.iss', 'scripts/publish.ps1']) {
    const f = path.join(ROOT, extra);
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, 'utf8');
      spots.push([extra, t.includes(v) ? v : `(missing ${v})`]);
    }
  }
  const bad = spots.filter(([, sv]) => sv !== v);
  bad.length
    ? fail('version-literals', `mismatch vs ${v}: ${bad.map(([n, sv]) => `${n}=${sv}`).join(', ')}`)
    : pass('version-literals', `${spots.length} files carry ${v}`);
  return v;
}

/* 2 — matrix integrity */
function checkMatrix() {
  const r = checkMatrixFile(path.join(ROOT, 'docs', 'COMPLETION_MATRIX.md'));
  r.ok ? pass('matrix-integrity', `all five totals = ${r.totals.header}/${r.totals.maxHeader}`)
       : fail('matrix-integrity', r.problems.join(' | '));
  return r;
}

/* 3 — checkpoint presence */
function checkCheckpoint() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'DEV_CONTINUATION.json'), 'utf8'));
    if (!d.lastVerifiedMain) throw new Error('lastVerifiedMain missing');
    let lineage = '';
    try {
      execSync(`git merge-base --is-ancestor ${d.lastVerifiedMain} HEAD`, { cwd: ROOT, stdio: 'pipe' });
      lineage = ' (ancestor of HEAD ✓)';
    } catch { lineage = ' (WARNING: lastVerifiedMain is NOT an ancestor of HEAD — checkpoint may be stale)'; }
    pass('checkpoint', `lastVerifiedMain=${d.lastVerifiedMain}${lineage}`);
  } catch (e) { fail('checkpoint', e.message); }
}

/* 4 — secret hygiene: no private key material committed */
function checkSecrets() {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|json|md|yml|ps1|iss|txt)$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p);
      if (rel === 'scripts/release-gate.mjs') continue; // gate source carries the patterns themselves
      const t = fs.readFileSync(p, 'utf8');
      const hits = (t.match(/oc_sk_[0-9a-f]{8,}|ghp_[A-Za-z0-9]{25,}|sk-ant-api[0-9A-Za-z_-]{10,}/gi) || [])
        .filter((h) => !/dummy|fake|not.real|example|test/i.test(h));
      if (hits.length) offenders.push(rel);
    }
  };
  walk(ROOT);
  offenders.length ? fail('secret-hygiene', `committed key material: ${offenders.join(', ')}`) : pass('secret-hygiene', 'no key material in tracked tree');
}

/* 5+6 — online release verification */
async function checkOnline(version) {
  const token = process.env.MAJIN_GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) { fail('release-online', 'no MAJIN_GH_TOKEN/GITHUB_TOKEN for --online'); return; }
  const api = async (u) => {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    return r;
  };
  try {
    const rel = await (await api(`https://api.github.com/repos/rssen-debug/MAJINCLI/releases/tags/v${version}`)).json();
    const assets = rel.assets || [];
    assets.length === 4 ? pass('release-assets', `v${version}: 4 assets`) : fail('release-assets', `v${version}: ${assets.length} assets (expected 4)`);
    const exes = assets.filter((a) => a.name.endsWith('.exe') && !a.name.endsWith('.sha256'));
    for (const exe of exes) {
      const sha = assets.find((a) => a.name === exe.name + '.sha256');
      if (!sha) { fail('release-sha256', `missing ${exe.name}.sha256`); continue; }
      const shaTxt = await (await api(sha.browser_download_url)).text();
      const want = (shaTxt.match(/[0-9a-f]{64}/) || [])[0];
      const buf = Buffer.from(await (await api(exe.browser_download_url)).arrayBuffer());
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      want === got ? pass(`sha256 ${exe.name}`, `${buf.length} B`) : fail(`sha256 ${exe.name}`, `MISMATCH want=${want} got=${got}`);
    }
  } catch (e) { fail('release-online', e.message); }
}

const version = checkVersionLiterals();
const matrix = checkMatrix();
checkCheckpoint();
checkSecrets();
if (ONLINE) await checkOnline(version);

const failed = results.filter((r) => !r.ok);
if (ASJSON) {
  console.log(JSON.stringify({ version, matrixTotals: matrix.totals, failed: failed.length, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${failed.length ? `RELEASE GATE: BLOCKED (${failed.length} failing check${failed.length > 1 ? 's' : ''})` : 'RELEASE GATE: local checks GREEN'}`);
}
process.exit(failed.length ? 1 : 0);
