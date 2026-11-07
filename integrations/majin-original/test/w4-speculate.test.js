/**
 * WAVE 4 (§6) — speculative execution lab.
 * Disabled by default; pure functions only; real timers with margins;
 * every claim (win/loss/waste/savings) asserted from the audit trail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpecLab, speculate } from '../src/core/speculate.js';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgOn = (over = {}) => ({ get: (k) => ({ 'speculation.enabled': true, ...over }[k]) });
const cfgOff = () => ({ get: () => undefined });

test('w4: correct speculation wins and savings are MEASURED against the confirm path', async () => {
  const lab = new SpecLab(cfgOn());
  const r = await lab.maybeSpeculate({
    speculations: [{ name: 'fast-guess', run: async () => { await settle(30); return 42; } }],
    confirm: async () => { await settle(150); return 42; },
  });
  assert.equal(r.value, 42);
  assert.equal(r.from, 'fast-guess');
  assert.ok(r.savedMsEstimate >= 80, `measured savings ${r.savedMsEstimate}ms ≈ confirm(150) - winner(30)`);
  assert.equal(lab.stats().wins, 1);
  assert.equal(lab.stats().runs, 1);
});

test('w4: wrong speculation is discarded, aborted, and its waste is accounted', async () => {
  const lab = new SpecLab(cfgOn());
  let sawAbort = false;
  const r = await lab.maybeSpeculate({
    speculations: [{
      name: 'slow-guess',
      run: async (signal) => { while (!signal.aborted) { await settle(5); sawAbort = sawAbort || signal.aborted; } return 'late'; },
    }],
    confirm: async () => { await settle(30); return 'authority'; },
  });
  assert.equal(r.value, 'authority');
  assert.equal(r.from, 'confirm');
  assert.ok(sawAbort, 'loser observed the AbortSignal for real');
  assert.equal(r.discarded.length, 1);
  assert.ok(r.wastedMs >= 10, `burn counted (${r.wastedMs}ms), not hidden`);
  assert.equal(lab.stats().losses, 1);
  assert.ok(lab.stats().wastedMs > 0);
});

test('w4: per-speculation timeout caps a runaway lane; confirm stays authoritative', async () => {
  const lab = new SpecLab(cfgOn({ 'speculation.timeoutMs': 60 }));
  const r = await lab.maybeSpeculate({
    speculations: [{ name: 'runaway', run: async () => { await settle(5000); return 'never'; } }],
    confirm: async () => { await settle(120); return 'safe'; },
  });
  assert.equal(r.value, 'safe');
  assert.equal(r.from, 'confirm');
  assert.ok(r.wallMs < 2000, `timeout actually capped the lane (wall ${r.wallMs}ms, not 5000)`);
  assert.equal(r.discarded[0].name, 'runaway');
});

test('w4: loser that IGNORES the abort cannot hang the result (grace-window accounting)', async () => {
  const lab = new SpecLab(cfgOn());
  const r = await lab.maybeSpeculate({
    speculations: [{ name: 'deaf', run: async () => { await settle(5000); return 'deaf'; } }],
    confirm: async () => { await settle(20); return 'done'; },
  });
  assert.equal(r.value, 'done');
  assert.ok(r.wallMs < 2000, 'return did not wait for the deaf loser');
  assert.equal(r.discarded[0].pendingAfterAbort, true, 'flagged honestly as still-pending');
  assert.ok(r.wastedMs > 0, 'elapsed-at-abort still counted as burn');
});

test('w4: waste budget self-limits — over budget, the gate closes (gated:true)', async () => {
  /* budget 200. Call 1: confirm(20) wins, deaf spec settles at 150 within the
     grace window → waste = 150 (< 200 → call 2 still allowed). Call 2: same
     shape, spec burns 200 → cumulative 350 ≥ 200 → call 3 must be gated. */
  const lab = new SpecLab(cfgOn({ 'speculation.wasteMsMax': 200 }));
  const burn = (ms, name) => ({ name, run: async () => { await settle(ms); return name; } });
  const confirmFast = async () => { await settle(20); return 'c'; };
  const r1 = await lab.maybeSpeculate({ speculations: [burn(150, 'b1')], confirm: confirmFast });
  assert.equal(r1.from, 'confirm');
  assert.equal(lab.stats().runs, 1);
  assert.ok(lab.stats().wastedMs >= 130 && lab.stats().wastedMs < 200, `burn 1 on the books (~150): ${lab.stats().wastedMs}`);
  const r2 = await lab.maybeSpeculate({ speculations: [burn(200, 'b2')], confirm: confirmFast });
  assert.equal(r2.from, 'confirm');
  assert.equal(lab.stats().runs, 2);
  assert.ok(lab.stats().wastedMs >= 330, `cumulative waste crossed the budget: ${lab.stats().wastedMs}`);
  const r3 = await lab.maybeSpeculate({ speculations: [burn(150, 'b3')], confirm: confirmFast });
  assert.equal(r3.gated, true, 'closed gate bypasses speculation entirely');
  assert.equal(r3.value, 'c');
  assert.equal(lab.stats().runs, 2, 'no third run once budget blew');
});

test('w4: disabled by default — zero speculation, zero accounting noise', async () => {
  const lab = new SpecLab(cfgOff());
  let specRan = 0;
  const r = await lab.maybeSpeculate({
    speculations: [{ name: 'would-be', run: async () => { specRan += 1; return 'sp'; } }],
    confirm: async () => 'plain',
  });
  assert.equal(r.value, 'plain');
  assert.equal(r.gated, true);
  assert.equal(specRan, 0, 'speculation never starts when disabled');
  assert.deepEqual(lab.stats().runs, 0);
  assert.equal(lab.stats().enabled, false);
  /* raw speculate() with no speculations is an honest confirm-only wrapper */
  const bare = await speculate({ speculations: [], confirm: async () => 'bare' });
  assert.equal(bare.from, 'confirm');
  assert.equal(bare.value, 'bare');
});
