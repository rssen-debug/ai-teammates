/* MAJIN — GENESIS ZERO Del 6A: per-task usage accounting + STRICT budget
   enforcement. One guard (budgetGate) called before and after every measured
   step; unknown price never reads as $0; caps stop MEASURED spend, not vibes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-budget-'));

const { budgetGate, loop } = await import('../src/core/loop.js');
const { priceKnownForRoute } = await import('../src/core/pricing.js');
const { Usage } = await import('../src/core/usage.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { setScript, lastCalls, resetCalls } = await import('../src/core/provider/mock.js');

const overBudgetUsage = () => ({ overBudget: () => true });
const okUsage = () => ({ overBudget: () => false });
const cfgOf = (budget) => ({ get: (k) => (k === 'budget.mode' ? budget.mode : k === 'budget.monthlyUsd' ? budget.monthlyUsd : k === 'budget.perTaskUsd' ? budget.perTaskUsd : undefined) });

test('gate monthly: over-budget PAID routes stop before a call — free and unknown-pass-under-nothing never slip through', () => {
  const c = cfgOf({ mode: 'cap', monthlyUsd: 5, perTaskUsd: 0 });
  const priced = budgetGate({ cfg: c, usageCtx: overBudgetUsage(), route: { kind: 'openai', model: 'm1', pricing: { in: 1, out: 1 } } });
  assert.ok(priced && priced.kind === 'monthly');
  assert.match(priced.text, /paid models stop here/);
  const unknown = budgetGate({ cfg: c, usageCtx: overBudgetUsage(), route: { kind: 'openai', model: 'mystery-7b' } });
  assert.ok(unknown && unknown.kind === 'monthly');
  assert.match(unknown.text, /no known price — under a cap, unknown never spends/);
  const free = budgetGate({ cfg: c, usageCtx: overBudgetUsage(), route: { kind: 'openai', pricing: { in: 0, out: 0 } } });
  assert.equal(free, null, 'a $0-priced route keeps working past a monthly cap');
  const under = budgetGate({ cfg: c, usageCtx: okUsage(), route: { kind: 'openai', pricing: { in: 1, out: 1 } } });
  assert.equal(under, null, 'under budget proceeds');
  const trackMode = budgetGate({ cfg: cfgOf({ mode: 'track', monthlyUsd: 5, perTaskUsd: 0 }), usageCtx: overBudgetUsage(), route: { kind: 'openai', pricing: { in: 1, out: 1 } } });
  assert.equal(trackMode, null, 'track mode records but never blocks');
});

test('gate per-task: only REAL measured cost trips it — and only past the cap', () => {
  const c = cfgOf({ mode: 'cap', monthlyUsd: 0, perTaskUsd: 0.25 });
  const under = budgetGate({ cfg: c, usageCtx: null, route: { kind: 'openai', pricing: { in: 1, out: 1 } }, tally: { input: 10, output: 5, costUsd: 0.10 } });
  assert.equal(under, null);
  const over = budgetGate({ cfg: c, usageCtx: null, route: { kind: 'openai', pricing: { in: 1, out: 1 } }, tally: { input: 10, output: 5, costUsd: 2.77 } });
  assert.ok(over && over.kind === 'task');
  assert.match(over.text, /task's budget of \$0\.25 is spent \(\$2\.7700 measured so far\)/, 'names cap AND measured number');
  const freeTally = budgetGate({ cfg: c, usageCtx: null, route: { kind: 'openai', pricing: { in: 0, out: 0 } }, tally: { input: 10_000_000, output: 10_000_000, costUsd: 0 } });
  assert.equal(freeTally, null, 'ten million free tokens trip nothing — cost, not tokens, is the gate');
  const trackMode = budgetGate({ cfg: cfgOf({ mode: 'track', monthlyUsd: 0, perTaskUsd: 0.25 }), usageCtx: null, route: { kind: 'openai', pricing: { in: 1, out: 1 } }, tally: { costUsd: 9 } });
  assert.equal(trackMode, null);
});

test('live loop: an expensive mock step is measured once, then the per-task cap stops step two — counted calls prove it', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-budget-live-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    budget: { mode: 'cap', monthlyUsd: 999, warnAt: 0.8, perTaskUsd: 0.5 },
    pricing: { 'demo/demo-fast': { in: 1000000000, out: 1000000000 } }, /* deliberately expensive */
  }, { persist: false });
  resetCalls();
  setScript('agent:tasks', [
    { text: 'step one needs a tool', toolCalls: [{ name: 'fs.list', args: { path: '.' } }] },
    { text: 'STEP TWO MUST NEVER BE ASKED FOR.' },
  ]);
  const r = await loop({
    cfg: rt.cfg, registry: rt.registry, job: 'tasks', maxSteps: 8,
    messages: [{ role: 'user', content: 'list the folder, then summarise it.' }],
  });
  const calls = lastCalls().filter((x) => x.key === 'agent:tasks' || x.key === 'tasks').length;
  assert.equal(calls, 1, `per-task cap must stop step two before it costs anything; got ${calls} calls`);
  assert.equal(r.errorKind, 'budget', JSON.stringify({ stopReason: r.stopReason, text: String(r.text).slice(0, 120) }));
  assert.equal(r.stopReason, 'task-budget');
  assert.match(String(r.text), /task's budget of \$0\.5 is spent/);
  assert.ok((r.usage?.costUsd || 0) > 0.5, `measured cost must exceed the cap, got ${r.usage?.costUsd}`);
  assert.equal(r.usage.priceKnown, true, 'a priced route reports KNOWN price');
  await rt.shutdown();
});

test('control: without a per-task cap the SAME workload runs both steps (gate, not wiring)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-budget-ctrl-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    budget: { mode: 'cap', monthlyUsd: 999, warnAt: 0.8, perTaskUsd: 0 }, /* off */
    pricing: { 'demo/demo-fast': { in: 1000000000, out: 1000000000 } },
  }, { persist: false });
  resetCalls();
  setScript('agent:tasks', [
    { text: 'step one needs a tool', toolCalls: [{ name: 'fs.list', args: { path: '.' } }] },
    { text: 'final answer exists' },
  ]);
  const r = await loop({
    cfg: rt.cfg, registry: rt.registry, job: 'tasks', maxSteps: 8,
    messages: [{ role: 'user', content: 'list the folder, then summarise it.' }],
  });
  assert.equal(lastCalls().filter((x) => x.key === 'agent:tasks' || x.key === 'tasks').length, 2);
  assert.ok(!r.errorKind, JSON.stringify(r));
  assert.match(String(r.text), /final answer exists/);
  await rt.shutdown();
});

test('unknown price never reads as known-zero: priced/local/free are KNOWN, priceless cloud is UNKNOWN — and the ledger counts it', () => {
  assert.equal(priceKnownForRoute({ kind: 'openai', model: 'mystery-7b', baseUrl: 'https://api.acme.tld/v1' }), false);
  assert.equal(priceKnownForRoute({ kind: 'openai', pricing: { in: 0.5, out: 0 } }), true);
  assert.equal(priceKnownForRoute({ kind: 'openai', baseUrl: 'http://localhost:11434/v1' }), true, 'local model = provably free');
  assert.equal(priceKnownForRoute({ kind: 'mock' }), true, 'demo = provably free');
  const u = new Usage(null);
  u.record({ job: 'tasks:t1', ref: 'acme/mystery-7b', usage: { input: 5000, output: 900, costUsd: 0 }, ms: 10, unpriced: true });
  const s = u.summary();
  assert.equal(s.unpricedCount ?? 1, 1, 'the ledger must keep an unpriced COUNT, not a fake $0 line');
  const thisMonth = u.data[u.summary().month];
  assert.equal(thisMonth.unpricedCount, 1);
  assert.equal(thisMonth.costUsd, 0, '$0 is the measured number, not the claimed price');
  assert.ok((thisMonth.tokensIn + thisMonth.tokensOut) > 0, 'usage carries tokens even when price is unknown');
});
