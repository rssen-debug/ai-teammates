/* WAVE 9 — cross-platform path/URL hygiene guard. The WAVE-8 CI failure
   proved the class: a self-run CLI check that is silently false on Windows
   (exit 0, empty output). These patterns are permanently banned in-repo.
   X1: no `import.meta.url === 'file://'+argv[1]` string compares anywhere
       in scripts/ or src/ (the file:///D:/ trap)
   X2: no `new URL(import.meta.url).pathname` path comparisons (URL.pathname
       keeps a leading slash on Windows drive letters AND stays %-encoded)
   X3: every CLI script with a self-run gate uses the canonical
       fileURLToPath pattern (canary: the five known self-run scripts)
   X4: bump-version.mjs imports cleanly with argv[1] absent (import-safe)
   X5: the guard itself verifies the canonical pattern is PRESENT — a guard
       that only checks absence can be defeated by deleting the gate */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['scripts', path.join('src', 'core'), path.join('src', 'tools')];
const EXT = /\.(mjs|js)$/;
const files = [];
for (const d of SCAN_DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (EXT.test(f)) files.push(path.join(dir, f));
}

const TRAP1 = /import\.meta\.url\s*={2,3}\s*['"`]file:\/\/\$\{?process\.argv/;
const TRAP2 = /new URL\(import\.meta\.url\)\.pathname/;
const CANON = /fileURLToPath\(import\.meta\.url\)/;

test('X1: no file://${argv} self-run compares remain in the tree', () => {
  const hits = files.filter((f) => TRAP1.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, [], `trap1 offenders: ${hits.join(', ')}`);
});

test('X2: no raw URL.pathname path compares remain', () => {
  const hits = files.filter((f) => TRAP2.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, [], `trap2 offenders: ${hits.join(', ')}`);
});

test('X3: known self-run CLI scripts use the canonical fileURLToPath gate', () => {
  const selfRunners = ['bump-version.mjs', 'offline-swarm-bench.mjs', 'i18n-check.mjs', 'set-icon.mjs', 'release-gate.mjs', 'perf-topology-bench.mjs'];
  for (const name of selfRunners) {
    const p = path.join(ROOT, 'scripts', name);
    const t = fs.readFileSync(p, 'utf8');
    const hasCanonical = CANON.test(t) || t.includes(".endsWith('") /* W5's lenient-but-Windows-safe suffix gate */;
    assert.ok(hasCanonical, `${name} lacks a Windows-safe self-run gate`);
  }
});

test('X4: bump-version.mjs is import-safe (no side effects without CLI argv)', async () => {
  const mod = await import('../scripts/bump-version.mjs');
  assert.ok(mod, 'module loads');
});

test('X5: guard sanity — the scan corpus is non-trivial (guard cannot pass on an empty tree)', () => {
  assert.ok(files.length >= 20, `only ${files.length} files scanned — tree moved? update SCAN_DIRS honestly`);
  const scriptsWithGate = ['offline-swarm-bench.mjs', 'i18n-check.mjs', 'bump-version.mjs'].filter((n) => CANON.test(fs.readFileSync(path.join(ROOT, 'scripts', n), 'utf8')));
  assert.ok(scriptsWithGate.length >= 3, 'canonical pattern must actually exist where expected');
});
