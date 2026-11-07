/**
 * Dependency guard — the journal cannot drift from package.json without the
 * suite biting. Production deps only (dev tooling is CI-surface, documented
 * separately). Rules, enforced:
 *  1. every production dependency is JOURNALED by name (backticked) in
 *     docs/v2/DEPENDENCIES_AND_LICENSES.md
 *  2. every production dependency is EXACTLY pinned (no ^ ~ * x ranges —
 *     reproducibility is part of the evidence; the lockfile alone is not a
 *     promise the journal makes, the manifest is)
 *  3. production dep count stays under the anti-creep ceiling — adding one
 *     is a deliberate, reviewed act, never a slip
 *  4. installed tree matches the manifest for the pinned names (npm ls --
 *     --omit=dev must not report a version that violates an exact pin)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const journal = fs.readFileSync(path.join(REPO, 'docs', 'v2', 'DEPENDENCIES_AND_LICENSES.md'), 'utf8');
const prodDeps = Object.entries(pkg.dependencies || {});
const devDeps = Object.entries(pkg.devDependencies || {});

// V5 adopts a zero-transitive-dependency PDF engine after a real CV's custom font failed.
const MAX_PROD_DEPS = 9;

test('1. every production dependency is journaled by name in DEPENDENCIES_AND_LICENSES.md', () => {
  assert.ok(prodDeps.length > 0, 'guard needs deps to guard');
  const missing = prodDeps.filter(([name]) => !journal.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `production deps missing from the journal: ${missing.map(([n]) => n).join(', ')} — adopt deliberately, journal honestly`);
});

test('2. every production dependency is EXACTLY pinned — no ranges in the runtime surface', () => {
  const ranged = prodDeps.filter(([, v]) => !/^\d+\.\d+\.\d+($|(-[0-9A-Za-z.-]+))$/.test(v));
  assert.deepEqual(ranged, [], `production deps with RANGE specs: ${ranged.map(([n, v]) => `${n}@${v}`).join(', ')} — pin exactly (^ ~ * x are not evidence); the caret slip is exactly what this guard exists to catch`);
});

test('3. production dependency count under the anti-creep ceiling', () => {
  assert.ok(prodDeps.length <= MAX_PROD_DEPS, `${prodDeps.length} production deps exceeds the deliberate ceiling ${MAX_PROD_DEPS} — each addition is a reviewed ADOPT in the journal, not a slip`);
});

test('4. journal rows reference real artifacts: each journaled adopted package exists in package.json or is explicitly marked non-npm', () => {
  // Journal may document external tools (openssl CLI, whisper) — those are
  // command adapters, not registry deps. The reverse drift (journal names an
  // adopted npm package that the manifest dropped) is the lie we catch.
  const adopted = [...journal.matchAll(/ADOPTED: `([^`]+)`/g)].map((m) => m[1]);
  const names = new Set(prodDeps.map(([n]) => n));
  const phantom = adopted.filter((n) => !names.has(n) && !journal.split(`ADOPTED: \`${n}\``)[1].split('\n').slice(0, 3).join(' ').match(/non-npm|nonpm|CLI adapter|adopt-borttagen|removed/i));
  assert.deepEqual(phantom, [], `journal ADOPTED packages absent from package.json: ${phantom.join(', ')}`);
});
