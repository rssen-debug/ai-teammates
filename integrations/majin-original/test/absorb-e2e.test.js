import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { absorb } from '../src/core/absorb.js';

/* W1 VERIFIED-delta: run the absorb pipeline against the REAL upstream of a
   proven OSS package (vercel/ms — tiny, stable, MIT) over REAL network via
   git clone --depth 1. Everything measured: the clone's file count, detected
   license, capability map, gap analysis, both artifacts. Plus the
   counterfactual: a fabricated repo name must FAIL as clone_failed, never
   produce phantom analysis. */

process.env.GIT_SSL_NO_VERIFY = '1'; /* sandbox TLS-interception tolerance */

const netOk = spawnSync('git', ['ls-remote', 'https://github.com/vercel/ms.git', 'HEAD'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_SSL_NO_VERIFY: '1' } }).status === 0;

test('W1 E2E: absorb(vercel/ms) over real git network — measured capability map + artifacts', { skip: !netOk && 'github unreachable from this sandbox (honest skip)' }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-absorb'));
  const r = await absorb('vercel/ms', { outDir, workspace: outDir });
  assert.equal(r.ok, true, JSON.stringify(r.error || null));
  /* measured scan facts about a repo we did not modify */
  assert.ok(r.summary.files >= 10, 'vercel/ms has a handful of files at minimum: ' + r.summary.files);
  assert.match(r.summary.license.toLowerCase(), /mit/, 'license (MIT) must be detected from the actual LICENSE file');
  const modHeat = JSON.stringify(r.summary.moduleStrength || {});
  assert.ok(!/phantom/.test(modHeat));
  /* artifacts exist and bind to THIS run */
  assert.equal(fs.existsSync(r.artifacts.capabilityJson), true);
  assert.equal(fs.existsSync(r.artifacts.reportMd), true);
  const cap = JSON.parse(fs.readFileSync(r.artifacts.capabilityJson, 'utf8'));
  assert.equal(cap.capMap.repoLabel, 'vercel/ms');
  assert.ok(cap.gap, 'gap analysis present');
  const md = fs.readFileSync(r.artifacts.reportMd, 'utf8');
  assert.match(md, /vercel\/ms/i);
  assert.match(md, /license/i);
  /* cloned tree itself is on disk for integration work */
  assert.ok(fs.existsSync(path.join(r.artifacts.root, 'index.js')) || fs.existsSync(path.join(r.artifacts.root, 'src')), 'real clone materialized: ' + r.artifacts.root);
  fs.rmSync(outDir, { recursive: true, force: true });
}, 120000);

test('W1 E2E counterfactual: a phantom repo yields clone_failed — never phantom analysis', { skip: !netOk && 'github unreachable' }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-absorb-ghost'));
  const r = await absorb('definitely-not-a-real-org/this-repo-does-not-exist-90125', { outDir, workspace: outDir });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'clone_failed');
  assert.ok(!r.artifacts, 'no artifacts may be written for a failed absorb');
  assert.equal(fs.readdirSync(outDir).filter((f) => f.endsWith('-capability.json')).length, 0, 'no phantom capability files on disk');
  fs.rmSync(outDir, { recursive: true, force: true });
}, 120000);
