/* WAVE 11 (user directive): the reusable concurrent orchestrator MAY tune its
   concurrency UP/DOWN — and MUST clearly log WHY, the new cap, and how capped
   per input whenever it does.
   T1: contraction event carries why + measuredRatio + capBefore/capNow +
       evidence.samples and worst-input per-input data (honest, sorted desc)
   T2: recovery direction exists — after a proven overrun freeze, proven
       within-estimate completions reopen lanes +1 per decision, never > capN,
       and every rise is a logged event too
   T3: a quiet (within-estimate) run logs ZERO adaptations — no spam, and
       un-annotated grids never adapt (legacy preserved)
   T4: decision flood mutes adaptive control — and even THAT is logged
       (adaptive_flood_mute exactly once)
   T5: every logged decision is probative: capNow < capBefore on overruns,
       capNow == capBefore + 1 on recoveries (no silent nudges) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSwarm } from '../src/core/swarm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* estMs annotated grids only — adaptation is measured, never guessed. */
const task = (id, estMs, ms) => ({ id, estMs, deps: [], run: async () => { await sleep(ms); return { ok: true, id }; } });

async function runCapturing(nodes, cap, opts = {}) {
  const events = [];
  const out = await runSwarm({ nodes, cap, onEvent: (e) => { if (e.type === 'topology_adapt') events.push(e); }, ...opts });
  return { out, events };
}

test('T1: contraction logs WHY, the new cap, and per-input evidence', { timeout: 30000 }, async () => {
  const nodes = [...Array(5)].map((_, i) => task(`b${i}`, 25, 120)); /* ~5x overrun */
  const { events } = await runCapturing(nodes, 3);
  assert.ok(events.length >= 1, 'overrun must be logged');
  const ev = events[0];
  assert.equal(ev.reason, 'overrun');
  assert.ok(ev.why.includes('measured overrun'), ev.why);
  assert.ok(ev.measuredRatio >= 2, ev.measuredRatio);
  assert.equal(ev.capBefore, 3);
  assert.ok(ev.capNow < ev.capBefore);
  assert.ok(ev.evidence.samples >= 1);
  assert.ok(Array.isArray(ev.perInput) && ev.perInput.length >= 1);
  assert.ok(ev.perInput[0].id.startsWith('b'), JSON.stringify(ev.perInput));
  assert.ok(ev.perInput[0].ratio >= 3, `worst input ratio honest: ${ev.perInput[0].ratio}`);
  for (let i = 1; i < ev.perInput.length; i++) assert.ok(ev.perInput[i - 1].ratio >= ev.perInput[i].ratio, 'sorted desc');
});

test('T2: within-estimate completions after a freeze reopen lanes +1, logged, never past cap', { timeout: 60000 }, async () => {
  /* Wave design (learned the hard way — goods MUST wait for the freeze,
     otherwise they complete first and mask the overrun ratio):
     bad0..2 overrun and freeze the cap; goods depend on bad2 so they can
     only run AFTER the freeze, where their 2ms-vs-200est completions pull
     the cumulative ratio under 1.25 and recoveries fire. */
  const bad = [...Array(3)].map((_, i) => task(`bad${i}`, 25, 120));
  const good = [...Array(8)].map((_, i) => ({ ...task(`good${i}`, 200, 2), deps: ['bad2'] }));
  const { events, out } = await runCapturing([...bad, ...good], 6);
  assert.equal(out.okCount, 11);
  const overruns = events.filter((e) => e.reason === 'overrun');
  const recoveries = events.filter((e) => e.reason === 'recovery');
  assert.ok(overruns.length >= 1, `must freeze first: ${JSON.stringify(events.map((e) => e.reason))}`);
  assert.ok(recoveries.length >= 1, `must recover after proven within-estimate work: ${JSON.stringify(events.map((e) => e.reason))}`);
  for (const r of recoveries) {
    assert.equal(r.capNow, r.capBefore + 1, 'exactly one lane at a time');
    assert.ok(r.capNow <= 6, 'never past the declared cap');
    assert.ok(r.measuredRatio <= 1.25, 'recovery only on proof');
    assert.ok(r.why.includes('recovery'), r.why);
    assert.ok(r.evidence.samples >= 4, 'cumulative evidence named');
  }
  assert.ok(events.every((e) => typeof e.why === 'string' && e.why.length > 10), 'every decision explains itself');
});

test('T3: quiet runs log nothing; un-annotated grids never adapt', { timeout: 30000 }, async () => {
  const quiet = [...Array(6)].map((_, i) => task(`q${i}`, 500, 8));
  const a = await runCapturing(quiet, 3);
  assert.deepEqual(a.events, []);
  assert.deepEqual(a.out.adaptive.adaptations, []);
  const raw = [...Array(4)].map((_, i) => ({ id: `r${i}`, run: async () => { await sleep(40); return { ok: true }; } }));
  const b = await runCapturing(raw, 4);
  assert.deepEqual(b.events, [], 'un-annotated = no adaptation, ever');
});

test('T4: a decision flood mutes adaptive control — loudly, exactly once', { timeout: 60000 }, async () => {
  /* Same wave design, maxAdaptations: 2 → the third would-be decision must
     become exactly one flood-mute log, and the log ends there. */
  const bad = [...Array(3)].map((_, i) => task(`bad${i}`, 25, 120));
  const good = [...Array(8)].map((_, i) => ({ ...task(`good${i}`, 200, 2), deps: ['bad2'] }));
  const { events, out } = await runCapturing([...bad, ...good], 6, { maxAdaptations: 2 });
  const reasons = events.map((e) => e.reason);
  assert.ok(out.okCount === 11, 'muting never eats task results');
  assert.ok(events.length <= 3, `bounded decision log: ${JSON.stringify(reasons)}`);
  const mutes = events.filter((e) => e.reason === 'adaptive_flood_mute');
  assert.equal(mutes.length, 1, `the mute itself is logged exactly once — silence never hides: ${JSON.stringify(reasons)}`);
  assert.ok(mutes[0].why.includes('flood') && mutes[0].why.includes('muted'), mutes[0].why);
  assert.ok(reasons.indexOf('adaptive_flood_mute') > reasons.indexOf('overrun'), 'mute follows real decisions');
  assert.ok(out.adaptive.adaptations.length <= 3);
});

test('T5: direction discipline — no silent nudges in the whole log', { timeout: 30000 }, async () => {
  const nodes = [...Array(8)].map((_, i) => task(`x${i}`, i % 2 ? 30 : 300, i % 2 ? 120 : 30));
  const { events } = await runCapturing(nodes, 4);
  for (const e of events) {
    if (e.reason === 'overrun') assert.ok(e.capNow < e.capBefore, JSON.stringify(e));
    if (e.reason === 'recovery') assert.equal(e.capNow, e.capBefore + 1, JSON.stringify(e));
    assert.ok(Number.isFinite(e.capNow) && e.capNow >= 1 && e.capNow <= 4);
  }
});
