#!/usr/bin/env node
/* MAJIN — versionsbumpning for LIVE DELIVERY.
   En version, fyra stallen som ska hallet synk, noll omskrivna publicerade taggar:
     package.json · package-lock.json (root, aldrig dependency-versioner!) ·
     src/core/version.js · installer/majin.iss
   Bruset efter (commit+tag+push) star i DECISIONS.md / README: build-exe.yml
   tar vid taggen och bygger+publicerar release med SHA-256 automatiskt. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], toString: () => `${+m[1]}.${+m[2]}.${+m[3]}` };
}

function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] > b[k] ? 1 : -1;
  return 0;
}

/** Validates the plan before a byte is written. All or nothing. */
export function planBump(target, { current, releasedTags = [] } = {}) {
  const t = parseSemver(target);
  if (!t) return { ok: false, error: `"${target}" is not a version like 1.2.3` };
  const c = parseSemver(current);
  if (!c) return { ok: false, error: `current version "${current}" could not be read` };
  const tag = `v${t.major}.${t.minor}.${t.patch}`;
  if (releasedTags.includes(tag)) {
    return { ok: false, error: `${tag} is already PUBLISHED — never overwrite a release; choose a newer number` };
  }
  if (cmp(t, c) <= 0) return { ok: false, error: `a new release must be HIGHER than ${current} (monotonic, never sideways)` };
  return { ok: true, version: `${t.major}.${t.minor}.${t.patch}`, tag };
}

/** Writes all four version files under `root`. Returns what changed. */
export function applyBump(root, version) {
  const changed = [];
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  changed.push('package.json');

  const lockFile = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    /* bara rotversionen — dependency-versionerna i locken ar kontraktet och rors aldrig */
    if ('version' in lock) lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
    changed.push('package-lock.json (root only)');
  }

  const verFile = path.join(root, 'src', 'core', 'version.js');
  const ver = fs.readFileSync(verFile, 'utf8');
  const next = ver.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${version}';`);
  if (next === ver) throw new Error('src/core/version.js: VERSION-literalen hittades inte — filen har vandrat form, kolla boken');
  fs.writeFileSync(verFile, next);
  changed.push('src/core/version.js');

  const psFile = path.join(root, 'scripts', 'publish.ps1');
  const ps = fs.readFileSync(psFile, 'utf8');
  const nextPs = ps.replace(/\[string\]\$Version = '[^']+'/, `[string]$Version = '${version}'`);
  if (nextPs !== ps) fs.writeFileSync(psFile, nextPs);
  changed.push('scripts/publish.ps1');

  const issFile = path.join(root, 'installer', 'majin.iss');
  const iss = fs.readFileSync(issFile, 'utf8');
  const nextIss = iss.replace(/#define MyAppVersion "[^"]+"/, `#define MyAppVersion "${version}"`);
  if (nextIss === iss) throw new Error('installer/majin.iss: MyAppVersion hittades inte');
  fs.writeFileSync(issFile, nextIss);
  changed.push('installer/majin.iss');

  return { changed };
}

/* Koll: driv snabbtest mot exakt det som andrats — version.test.js sammanfaller fyra kallorna. */
async function latestReleasedTags({ repo = 'rssen-debug/MAJINCLI', fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: { 'user-agent': 'majin-bump' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const list = await r.json();
    return list.map((x) => String(x.tag_name || '')).filter(Boolean);
  } catch { return []; }
}

/* fileURLToPath + resolve — never 'file://'+argv[1] or URL.pathname compares:
   both lie on Windows (file:///D:/… vs D:\…) and the failure mode is a SILENT
   no-op (WAVE 8 lesson, CI-caught). This is the repo-canonical pattern. */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const target = process.argv[2];
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tags = await latestReleasedTags({});
  const plan = planBump(target, { current: pkg.version, releasedTags: tags });
  if (!plan.ok) {
    console.error('bump refused: ' + plan.error);
    process.exit(1);
  }
  const out = applyBump(root, plan.version);
  console.log(`bumped → ${plan.version} (${plan.tag})`);
  for (const c of out.changed) console.log('  changed ' + c);
  console.log('next: npm test, commit version bump, push to main — build-exe.yml builds the release with SHA-256 + assets automatically.');
}
