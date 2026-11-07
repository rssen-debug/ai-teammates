/**
 * Model registry refresh — live truth over static lists.
 * PROVIDER_PROFILES carries V1's live-proven CATALOG (what the gateway once
 * listed). The refresh asks the gateway TODAY, caches the answer with a
 * content hash + key fingerprint, and reports DRIFT vs the static list
 * (added/removed) rather than pretending the profiles are omniscient.
 *
 * Honesty rules (enforced, not documented):
 *  - no key → KEY_MISSING, zero traffic (same discipline as resolveProfile)
 *  - gateway error → GATEWAY_ERROR with the real HTTP status
 *  - payload we cannot shape → PAYLOAD_INVALID (never fabricate a list)
 *  - cache read on absent file → CACHE_EMPTY (a state, not an error)
 *  - staleness is computed against an injected clock: STALE over 24h, FRESH
 *    under — the flag is real age, never "cached = current" fiction
 *  - the key itself never enters the cache: sha256 fingerprint only
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ModelError } from './provider.js';

const REGISTRY_FORMAT = 'majin-v2-model-registry';
const REGISTRY_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 24 * 3600 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

function keyFingerprint(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8); }

/** parse an OpenAI-style /models payload; throws PAYLOAD_INVALID on anything we cannot shape */
function parseModelsPayload(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new ModelError('PAYLOAD_INVALID', `registry payload is not JSON: ${e.message}`); }
  const arr = Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : null;
  if (!arr) throw new ModelError('PAYLOAD_INVALID', 'registry payload has no models array (neither OpenAI .data nor a bare list) — refusing to guess');
  const ids = arr.map((m) => (typeof m === 'string' ? m : m?.id)).filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) throw new ModelError('PAYLOAD_INVALID', 'models array carries no string ids — refusing an empty truth');
  return [...new Set(ids)].sort();
}

export async function refreshRegistry(cachePath, { profile, key, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  if (!profile?.baseUrl) throw new ModelError('PAYLOAD_INVALID', 'refresh requires a provider profile');
  if (!key) throw new ModelError('KEY_MISSING', `registry refresh needs ${profile.keyEnv || 'the provider key'} — refusing unauthenticated registry traffic (no key, no guess)`);
  const url = profile.baseUrl.replace(/\/$/, '') + '/models';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, ...(profile.extraHeaders || {}) },
      signal: ac.signal,
    });
  } catch (e) {
    throw new ModelError('GATEWAY_ERROR', `registry fetch failed: ${e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e.cause?.code || e.message)}`);
  } finally { clearTimeout(t); }
  const text = await res.text();
  if (!res.ok) throw new ModelError('GATEWAY_ERROR', `registry answered HTTP ${res.status} — nothing cached, drift unknown (honest partial)`, { status: res.status });
  const models = parseModelsPayload(text);
  const doc = {
    format: REGISTRY_FORMAT, version: REGISTRY_VERSION,
    fetchedAt: now().toISOString(), source: url,
    keyFingerprint: keyFingerprint(key), bytes: text.length,
    contentHash: crypto.createHash('sha256').update(text).digest('hex'),
    models,
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(doc, null, 2) + '\n');
  return Object.freeze({ ok: true, count: models.length, drift: drift(profile, models), doc });
}


/** drift(profile, liveIds): honest comparandum — what changed vs the static catalog */
export function drift(profile, liveIds) {
  const staticList = profile?.chatCompletionsModels || [];
  const live = new Set(liveIds);
  const stat = new Set(staticList);
  return Object.freeze({
    added: liveIds.filter((m) => !stat.has(m)),
    removed: staticList.filter((m) => !live.has(m)),
    unchangedCount: staticList.filter((m) => live.has(m)).length,
  });
}

export function readRegistry(cachePath, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS, profile = null } = {}) {
  if (!fs.existsSync(cachePath)) {
    return Object.freeze({ state: 'CACHE_EMPTY', detail: 'no cached registry — run --models-refresh (never presented as knowledge)' });
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) {
    return Object.freeze({ state: 'CACHE_INVALID', detail: `cache unparseable: ${e.message} — refusing to trust it` });
  }
  if (doc.format !== REGISTRY_FORMAT || doc.version !== REGISTRY_VERSION || !Array.isArray(doc.models)) {
    return Object.freeze({ state: 'CACHE_INVALID', detail: 'cache format/version unknown — refusing to trust it' });
  }
  const ageMs = now - Date.parse(doc.fetchedAt);
  const state = Number.isFinite(ageMs) && ageMs <= staleAfterMs ? 'FRESH' : 'STALE';
  return Object.freeze({
    state, ageMs: Number.isFinite(ageMs) ? ageMs : null, fetchedAt: doc.fetchedAt,
    source: doc.source, keyFingerprint: doc.keyFingerprint, contentHash: doc.contentHash,
    models: doc.models, count: doc.models.length,
    drift: profile ? drift(profile, doc.models) : null,
    detail: state === 'STALE' ? `registry is ${Math.round(ageMs / 3600000)}h old — older than the 24h honesty window; refresh before trusting` : 'within the 24h honesty window',
  });
}
