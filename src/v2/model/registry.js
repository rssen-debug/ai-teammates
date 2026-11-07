/**
 * V2 provider registry/chain (master brief sections 59-61): priority-ordered
 * list of providers with per-provider circuit breaking and attempt caps.
 * Contract kept thin: a circuit opener is LOCAL state, never vendor-wide
 * truth; every decision lands in telemetry (model.call with provider+cls).
 *
 * Failover moves to the next provider ONLY for retry-safe classes
 * (NETWORK_FAILURE, TIMEOUT, MODEL_RATE_LIMIT, MODEL_FAILURE). AUTH_REQUIRED
 * and INVALID_TOOL_OUTPUT fail the chain immediately: retrying the same
 * request against another vendor does not fix either.
 */
import { ModelError } from './provider.js';

const RETRY_SAFE = new Set(['NETWORK_FAILURE', 'TIMEOUT', 'MODEL_RATE_LIMIT', 'MODEL_FAILURE']);

export class ProviderChain {
  constructor(providers, { maxAttemptsPerRequest = 4, failureThreshold = 3, cooldownMs = 15_000, telemetry = null } = {}) {
    if (!Array.isArray(providers) || providers.length === 0) throw new Error('chain needs at least one provider');
    this.providers = providers;
    this.maxAttempts = maxAttemptsPerRequest;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.telemetry = telemetry;
    this.breakers = new Map(providers.map((p) => [p.name, { fails: 0, openedAt: 0 }]));
  }

  isOpen(name) {
    const b = this.breakers.get(name);
    if (!b || b.fails < this.failureThreshold) return false;
    if (Date.now() - b.openedAt >= this.cooldownMs) { b.fails = 0; return false; } // half-open: probe allowed
    return true;
  }

  record(name, cls) {
    const b = this.breakers.get(name);
    this.telemetry?.append('model.call', { provider: name, result: 'error', errorCls: cls });
    b.fails += 1;
    if (b.fails >= this.failureThreshold && !b.openedAt) b.openedAt = Date.now();
  }

  /** chat(messages, opts) — try providers in priority order with caps */
  async chat(messages, opts = {}) {
    const errors = [];
    let tried = 0;
    for (const provider of this.providers) {
      if (tried >= this.maxAttempts) break;
      if (this.isOpen(provider.name)) continue;
      tried += 1;
      try {
        const res = await provider.chat(messages, opts);
        this.telemetry?.append('model.call', {
          provider: provider.name, result: 'ok', elapsedMs: res.elapsedMs,
          usageInput: res.usage?.prompt_tokens, usageOutput: res.usage?.completion_tokens, usageTotal: res.usage?.total_tokens,
        });
        const b = this.breakers.get(provider.name);
        b.fails = 0; b.openedAt = 0;
        return { ...res, provider: provider.name, chainAttempts: tried };
      } catch (err) {
        const cls = err instanceof ModelError ? err.cls : 'UNKNOWN';
        errors.push({ provider: provider.name, cls, message: err.message });
        this.record(provider.name, cls);
        if (!RETRY_SAFE.has(cls)) break; // no point repeating the same dead request
      }
    }
    const e = new ModelError('MODEL_FAILURE', `chain failed after ${tried} attempt(s): ${errors.map((x) => `${x.provider}=${x.cls}`).join(', ')}`, { errors });
    e.chainErrors = errors;
    throw e;
  }

  status() {
    return this.providers.map((p) => ({ name: p.name, breakerOpen: this.isOpen(p.name), fails: this.breakers.get(p.name).fails }));
  }
}
