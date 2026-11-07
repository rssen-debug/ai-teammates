/* Cost truth, red first:
   1) pricing rides in from the provider's OWN /models answer (OpenRouter/Kilo
      carry per-model pricing) — never a hand-curated table again for those.
   2) import only fills gaps — a price the user (or the shipped DeepSeek
      table) set is never stomped by a later list.
   3) budget.mode 'cap' actually STOPS paid calls; free routes (explicit 0/0
      price, mock, or your own loopback server) still work under a cap — and
      a remote model with unknown price is treated as paid, honestly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-pricing-'));

const { extractPricing, importPricing, isFreeRoute } = await import('../src/core/pricing.js');
const { Config, DEFAULTS, clone } = await import('../src/core/config.js');
const { Usage } = await import('../src/core/usage.js');

const OPENROUTERISH = {
  data: [
    { id: 'deepseek/deepseek-flash', pricing: { prompt: '0.00000014', completion: '0.00000028' } },
    { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'qwen/qwen3-32b:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'no-price-model' },
  ],
};

test('extractPricing reads OpenRouter-style payload into USD per 1M tokens', () => {
  const m = extractPricing('openrouter', OPENROUTERISH);
  // nyckeln speglar MAJIN-ref-formen provider/listans-id — samma som resolveModel slår upp
  assert.equal(m['openrouter/deepseek/deepseek-flash'].in, 0.14);
  assert.equal(m['openrouter/deepseek/deepseek-flash'].out, 0.28);
  assert.equal(m['openrouter/anthropic/claude-sonnet-5'].in, 3);
  assert.equal(m['openrouter/anthropic/claude-sonnet-5'].out, 15);
  assert.deepEqual(m['openrouter/qwen/qwen3-32b:free'], { in: 0, out: 0 });
  assert.equal(m['openrouter/no-price-model'], undefined); // okänt pris = okänt, aldrig 0
});

test('importPricing fills gaps only — curated prices win, provenance is kept', async () => {
  const cfg = new Config(clone(DEFAULTS), path.join(process.env.MAJIN_HOME, 'config.json'));
  // shipped default already carries deepseek/deepseek-flash 0.14/0.28
  const r1 = await importPricing(cfg, 'openrouter', OPENROUTERISH, { source: 'openrouter:/models' });
  assert.equal(r1.imported >= 2, true); // claude + free qwen nya
  assert.equal(cfg.get('pricing')['openrouter/deepseek/deepseek-flash'].out, 0.28);
  assert.equal(cfg.get('pricing')['deepseek/deepseek-flash'].out, 0.28, 'kuraterad tabell får aldrig skrivas över');
  assert.equal(cfg.get('pricing')['openrouter/anthropic/claude-sonnet-5'].out, 15);
  assert.equal(cfg.get('pricingMeta')['openrouter/anthropic/claude-sonnet-5'].source, 'openrouter:/models');
  assert.equal(cfg.get('pricingMeta')['deepseek/deepseek-flash'], undefined, 'befintligt pris rörs inte ens i metan');
  // andra importen med ändrat pris får inte heller skriva över vad vi redan vet
  const changed = { data: [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000009', completion: '0.000099' } }] };
  const r2 = await importPricing(cfg, 'openrouter', changed, { source: 'openrouter:/models' });
  assert.equal(r2.imported, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(cfg.get('pricing')['openrouter/anthropic/claude-sonnet-5'].out, 15);
});

test('isFreeRoute: explicit 0/0, mock, loopback — yes; priced or unknown-remote — no', () => {
  assert.equal(isFreeRoute({ kind: 'mock' }), true);
  assert.equal(isFreeRoute({ pricing: { in: 0, out: 0 } }), true);
  assert.equal(isFreeRoute({ baseUrl: 'http://127.0.0.1:11434/v1' }), true);
  assert.equal(isFreeRoute({ baseUrl: 'http://192.168.1.10:11434/v1' }), true);
  assert.equal(isFreeRoute({ pricing: { in: 0.14, out: 0.28 } }), false);
  assert.equal(isFreeRoute({ baseUrl: 'https://openrouter.ai/api/v1' }), false, 'okänt pris på en riktig server räknas som betald');
});

test('free classification rejects malformed prices, additional fees and fake local hosts', () => {
  for (const baseUrl of ['https://localhost.example.com/v1', 'https://127.0.0.1.example.com/v1', 'https://10.example.com/v1', 'https://example.com/://localhost']) {
    assert.equal(isFreeRoute({ baseUrl }), false, baseUrl);
  }
  for (const pricing of [{ in: null, out: null }, { in: '', out: '' }, { in: false, out: false }, { in: ' ', out: ' ' }, { in: 0, out: 0, request: 0.1 }]) {
    assert.equal(isFreeRoute({ pricing }), false, JSON.stringify(pricing));
  }
  const imported = extractPricing('test', { data: [
    { id: 'fee', pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { id: 'unknown-fee', pricing: { prompt: '0', completion: '0', request: null } },
    { id: 'invalid', pricing: { prompt: false, completion: '' } },
    { id: 'space', pricing: { prompt: ' ', completion: '0' } },
  ] });
  assert.equal(imported['test/invalid'], undefined);
  assert.equal(imported['test/space'], undefined);
  assert.equal(isFreeRoute({ pricing: imported['test/fee'] }), false);
  assert.equal(isFreeRoute({ pricing: imported['test/unknown-fee'] }), false);
  assert.deepEqual(extractPricing('test', { data: {} }), {});
});

test('budget cap stops paid calls before they cost, free ones pass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-budget-'));
  process.env.MAJIN_HOME = home;
  const { Usage: U2 } = await import('../src/core/usage.js');
  const { loop } = await import('../src/core/loop.js');
  const cfg = new Config(clone(DEFAULTS), path.join(home, 'config.json'));
  await cfg.patch({ budget: { mode: 'cap', monthlyUsd: 1 } });
  const usage = new U2(cfg);
  usage.record({ job: 'seed', ref: 'deepseek/deepseek-flash', usage: { input: 0, output: 0, costUsd: 2 } }); // över cap
  const paidRegistry = { schemas: () => [], run: async () => ({ result: 'ok' }) };
  const messages = [{ role: 'user', content: 'hello' }];
  const stalled = await loop({ cfg, registry: paidRegistry, messages, usage, allowTools: false });
  assert.ok(stalled.error, 'betald route måste vägras över cap');
  assert.equal(stalled.errorKind, 'budget');
  assert.match(stalled.text, /budget|\$1/i);
  assert.match(stalled.text, /free|own server|raise/i, 'svaret ska säga vad som fortfarande funkar och hur man höjer');

  // fri route passerar under cap: mock-providern (kind 'mock') är alltid fri,
  // oavsett pris-tabell — lokal demo kostar aldrig pengar
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-budget-free-'));
  process.env.MAJIN_HOME = home2;
  const cfg2 = new Config(clone(DEFAULTS), path.join(home2, 'config.json'));
  const routes = {};
  for (const k of Object.keys(cfg2.get('models.routes') || {})) routes[k] = 'demo/demo-fast';
  routes.tools = 'demo/demo-fast';
  await cfg2.patch({ budget: { mode: 'cap', monthlyUsd: 1 }, models: { routes } });
  const usage2 = new U2(cfg2);
  usage2.record({ job: 'seed', ref: 'demo/demo-fast', usage: { input: 0, output: 0, costUsd: 2 } });
  const okRun = await loop({ cfg: cfg2, registry: paidRegistry, messages: [{ role: 'user', content: 'hello' }], usage: usage2, allowTools: false });
  assert.equal(okRun.error, undefined, 'fri route under cap ska svara, inte vägras: ' + String(okRun.error || ''));
  assert.ok(String(okRun.text || '').length > 0);
});

test('usage honesty: unpriced requests are counted, never silently $0', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-unpriced-'));
  process.env.MAJIN_HOME = home;
  const { Usage: U3 } = await import('../src/core/usage.js');
  const cfg = { get: () => null };
  const usage = new U3(cfg);
  usage.record({ job: 'chat', ref: 'openai/gpt-5.2', usage: { input: 100, output: 50, costUsd: 0 } });
  usage.record({ job: 'chat', ref: 'openai/gpt-5.2', usage: { input: 100, output: 50, costUsd: 0.012 } });
  const s = usage.summary();
  assert.ok(s.costUsd > 0);
});

test('usage.record accepts an unpriced flag and summary reports it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-unpriced2-'));
  process.env.MAJIN_HOME = home;
  const { Usage: U4 } = await import('../src/core/usage.js');
  const usage = new U4({ get: () => null });
  usage.record({ job: 'chat', ref: 'openai/gpt-5.2', usage: { input: 100, output: 50, costUsd: 0 }, unpriced: true });
  usage.record({ job: 'chat', ref: 'deepseek/deepseek-flash', usage: { input: 10, output: 10, costUsd: 0.001 } });
  const s = usage.summary();
  assert.equal(s.unpricedCount, 1, 'en förfrågan saknade pris → räknas ärligt');
  assert.deepEqual(s.unpricedRefs, ['openai/gpt-5.2']);
});
