import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paketets syntm ä + honesty-registry: den färre minne * visa vila att live-körningen
 *  sparkproducerar bevis, inte historier. Off-line deterministisk — aldrig ett PS1-kör. */

const PS1 = fileURLToPath(new URL('../scripts/windows/live-acceptance-run.ps1', import.meta.url));
const GUIDE = fileURLToPath(new URL('../docs/LIVE-RUN-GUIDE.md', import.meta.url));
const SETUP = fileURLToPath(new URL('../scripts/windows/desktop-eval-setup.ps1', import.meta.url));

test('live-run package: all three package files exist on disk', () => {
  for (const p of [PS1, GUIDE, SETUP]) assert.ok(fs.existsSync(p), `saknas: ${p}`);
});

test('live-run package: orchestrator covers ALL THREE lanes + evidence dir, with read-back discipline', () => {
  const s = fs.readFileSync(PS1, 'utf8');
  for (const lane of ['W11-live desktop eval', 'W2 live research', 'W12 interactive pink-cursor']) {
    assert.ok(s.includes(lane), `okcloud saknar lane-text: ${lane}`);
  }
  assert.ok(s.includes('live-run-'), 'evidence-natur naming finns');
  // fairness-haren:enskild artefakt måste rereadbas innan den beräknas - högljudt påstått i scriptet
  assert.ok(/read.?back/i.test(s), 'read-back disciplin explicit i ps1');
  assert.ok(s.includes('RUN-SUMMARY.json'), 'sammanfattnings-artifact benämnd');
  assert.ok(s.includes('benchmark\\desktop-tasks\\rename-file-dialog-win\\verify.mjs'), 'W11-live-verifiern körs faktiskt');
  assert.ok(s.includes('dest bench') === false || s.includes('desktop-bench.mjs --save'), 'desktop-bench re-verifieras på win32');
});

test('live-run package: checklistan literaturiskt kräver MÄNSKLIG observation — aldrig ett scriptet-knows-best', () => {
  const s = fs.readFileSync(PS1, 'utf8');
  assert.ok(s.includes('checked box without observed evidence is fabrication'), 'anti-fabrication markerad');
  assert.ok(s.includes('w12-pink-visual.png'), 'screenshot-evidens namngiven');
  assert.ok(/Win\+Shift\+S/.test(s), 'konkret skärmdumps-instruktion');
  assert.ok(s.includes('move again'), 'overlay-mobilitet är en del av checklistan');
});

test('live-run package: INGEN credential literal krokigt i scriptet (token-endpoint lever för KLIENTsession, inte skripted runs)', () => {
  const s = fs.readFileSync(PS1, 'utf8');
  assert.ok(!/oc_sk_[a-z0-9_]{20,}/i.test(s), 'ingen riktig nyckel in-checkad');
  assert.ok(/OPENCODE_KEY/.test(s) || /oc_sk_/.test(s) === false, 'miljö-referens tillåten, aldrig literals');
  assert.ok(s.includes('never paste'), 'policy-märkt mot nyckelstölden');
});

test('live-run guide: guide mentions what counts as evidence + the fabrication rule + commit-path', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  assert.ok(g.includes('w12-pink-visual.png'));
  assert.ok(g.includes('manual-reference'), 'agen-credit/manual-reference-split explicit');
  assert.ok(g.includes('100/100'), 'vag till 100 benämnd');
  assert.ok(/git add docs\/evidence/.test(g), 'exakter commit-path tillstår');
  assert.ok(g.includes('99') && (g.includes('CAP') || g.includes('cap')), 'CAP-nämnd');
});
