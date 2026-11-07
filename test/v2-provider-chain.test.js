/**
 * V2 provider chain contracts: failover for retry-safe classes only, per-
 * provider circuit breakers with cooldown (half-open probes allowed), attempt
 * cap honored, and every decision lands in telemetry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderChain } from '../src/v2/model/registry.js';
import { ModelError } from '../src/v2/model/provider.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { aggregate } from '../src/v2/telemetry/aggregate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fakeProvider(name, clsOrOk) {
  let calls = 0;
  return {
    name,
    model: 'mock',
    get calls() { return calls; },
    chat: async () => {
      calls += 1;
      if (clsOrOk instanceof Array) {
        const now = clsOrOk[calls - 1] ?? clsOrOk[clsOrOk.length - 1];
        if (now === 'ok') return { text: 'yes', usage: { total_tokens: 5 }, model: 'mock', elapsedMs: 1 };
        throw new ModelError(now, `${name}: ${now}`);
      }
      if (clsOrOk === 'ok') return { text: 'yes', usage: { total_tokens: 5 }, model: 'mock', elapsedMs: 1 };
      throw new ModelError(clsOrOk, `${name}: ${clsOrOk}`);
    },
  };
}

test('chain: network failure on first provider -> second serves (chainAttempts=2)', async () => {
  const p1 = fakeProvider('dead', 'NETWORK_FAILURE');
  const p2 = fakeProvider('alive', 'ok');
  const chain = new ProviderChain([p1, p2]);
  const res = await chain.chat([{ role: 'user', content: 'x' }]);
  assert.equal(res.provider, 'alive');
  assert.equal(res.chainAttempts, 2);
});

test('chain: AUTH_REQUIRED fails fast — never retried against later vendors', async () => {
  const p1 = fakeProvider('authed', 'AUTH_REQUIRED');
  const p2 = fakeProvider('backup', 'ok');
  const chain = new ProviderChain([p1, p2]);
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }]), (e) => e instanceof ModelError);
  assert.equal(p1.calls, 1);
  assert.equal(p2.calls, 0);
});

test('chain: circuit breaker opens at threshold (accumulated across requests), half-open after cooldown', async () => {
  const p = fakeProvider('flaky', ['f1','f2','f3','ok'].map((x) => x === 'ok' ? 'ok' : 'NETWORK_FAILURE'));
  const chain = new ProviderChain([p], { failureThreshold: 3, cooldownMs: 60, maxAttemptsPerRequest: 4 });
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }])); // request 1 -> 1 fail
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }])); // request 2 -> 2 fails
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }])); // request 3 -> 3 fails => open
  assert.equal(chain.status()[0].breakerOpen, true);
  const callsBeforeProbe = p.calls;
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }])); // open breaker: skipped
  assert.equal(p.calls, callsBeforeProbe, 'open breaker blocked the demand');
  await new Promise((r) => setTimeout(r, 65)); // cooldown elapses
  const res = await chain.chat([{ role: 'user', content: 'x' }]);
  assert.equal(res.text, 'yes');
  assert.equal(chain.status()[0].breakerOpen, false);
});

test('chain: maxAttempts cap honored even when more providers exist', async () => {
  const providers = ['a', 'b', 'c', 'd'].map((n) => fakeProvider(n, 'NETWORK_FAILURE'));
  const chain = new ProviderChain(providers, { maxAttemptsPerRequest: 2, failureThreshold: 99 });
  await assert.rejects(() => chain.chat([{ role: 'user', content: 'x' }]), (e) => /2 attempt/.test(e.message));
  assert.equal(providers[2].calls, 0, 'provider c never attempted');
});

test('chain: every decision lands in telemetry (success + failure rows)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-chain-'));
  const tele = new TelemetryLedger(dir);
  const chain = new ProviderChain([fakeProvider('p-down', 'MODEL_RATE_LIMIT'), fakeProvider('p-live', 'ok')], { telemetry: tele });
  await chain.chat([{ role: 'user', content: 'x' }]);
  const rep = aggregate(dir, { lastDays: 1 });
  assert.equal(rep.models.callCount, 2);
  assert.ok(rep.models.byProvider['p-down'] && rep.models.byProvider['p-live']);
});
