/**
 * MAJIN V4 — model discovery.
 *
 * The Windows installation is the single source of truth. V4 reads the SAME
 * config file V1 uses (`$MAJIN_CONFIG` or `<MAJIN_HOME>/config.json`) and
 * exposes only safe metadata: provider labels, model ids and whether a
 * credential is present. Credential values never cross this boundary.
 *
 * Honesty rules:
 *  - "configured" means a key exists; it is NOT proof of a working inference.
 *  - Every listed model therefore carries `liveVerified: false` unless a real
 *    call has succeeded in this process (recorded by the model client).
 *  - A static list is never presented as discovered availability.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandEnvValue } from './config.js';
import { discoverModels as discoverProviderModels } from '../core/provider/catalog.js';
import { listModelsUrl } from '../core/presets.js';
import { t } from './ui/strings.js';

export const CATALOG_TTL_MS = Number(process.env.MAJIN_V4_MODEL_CACHE_TTL_MS || 6 * 60 * 60 * 1000);

/**
 * Live catalog cache. The fetching itself is V1's proven implementation
 * (`src/core/provider/catalog.js`): per-provider auth headers, pagination,
 * origin pinning and honest errors. V4 only adds caching and status labels —
 * no second discovery implementation.
 */
function cacheFile({ home }) {
  return path.join(home, 'v4', 'model-cache.json');
}

export function readCatalogCache({ home } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile({ home }), 'utf8'));
    if (raw?.v !== 1 || typeof raw.providers !== 'object') return { providers: {} };
    return raw;
  } catch {
    return { providers: {} };
  }
}

function writeCatalogCache({ home }, cache) {
  const file = cacheFile({ home });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), ...cache }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** True when a cached listing is still inside its TTL. */
export function cacheEntryFresh(entry, now = Date.now()) {
  if (!entry?.at || !entry.ok) return false;
  return now - Date.parse(entry.at) < CATALOG_TTL_MS;
}

/** Provider objects from the V1 config, with keys resolved. Never serialised. */
function providersFromConfig({ home, env }) {
  const cfg = readConfig(configFilePath({ home, env }));
  const out = [];
  for (const [name, p] of Object.entries(cfg?.providers || {})) {
    if (!p || typeof p !== 'object' || !p.baseUrl) continue;
    const apiKey = expandEnvValue(p.apiKey, env);
    out.push({
      name,
      label: typeof p.label === 'string' ? p.label : name,
      kind: ['openai', 'anthropic', 'responses', 'mock', 'gemini'].includes(p.kind) ? p.kind : 'openai',
      baseUrl: String(p.baseUrl).replace(/\/+$/, ''),
      apiKey,
      headers: p.headers || null,
      hasKey: Boolean(apiKey),
    });
  }
  return out;
}

/**
 * Refresh one provider's model list using V1's catalog code.
 * Returns a cache entry. Errors are data, never thrown to the UI as a crash.
 */
export async function refreshProviderCatalog({ home, env = process.env, providerName, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const provider = providersFromConfig({ home, env }).find((p) => p.name === providerName);
  if (!provider) return { ok: false, error: 'unknown provider', models: [] };
  if (!provider.hasKey) return { ok: false, error: 'no api key configured', models: [] };
  const at = new Date().toISOString();
  let result;
  try {
    result = await discoverProviderModels(
      { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey, headers: provider.headers, models: [] },
      { fetchImpl: withTimeout(fetchImpl, timeoutMs) },
    );
  } catch (err) {
    result = { ok: false, error: String(err?.message || err), models: [] };
  }
  const cache = readCatalogCache({ home });
  const previous = cache.providers?.[providerName];
  const usage = providerOffering(provider.baseUrl) === 'opencode-go'
    ? await fetchGoUsage(provider, { fetchImpl, timeoutMs }) : null;
  const entry = {
    at: result.ok ? at : previous?.at || null,
    attemptedAt: at,
    ok: Boolean(result.ok),
    models: result.ok ? [...new Set(result.models || [])] : previous?.models || [],
    metadata: result.ok ? (result.catalog || []).map((m) => ({ id: m.id, name: m.name, context: m.context, tools: m.tools === true ? true : null, vision: m.vision === true ? true : null, input: m.input, output: m.output })) : previous?.metadata || [],
    source: (() => { try { const url = new URL(listModelsUrl(provider)); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return null; } })(),
    ...(usage ? { usage } : previous?.usage ? { usage: previous.usage } : {}),
    // Never surface exception strings: a provider can echo credentials in errors.
    ...(result.ok ? {} : { error: /timed out/i.test(result.error || '') ? 'Catalog timed out.' : 'Catalog request failed. Check provider access.' }),
  };
  writeCatalogCache({ home }, { providers: { ...cache.providers, [providerName]: entry } });
  return entry;
}

/** Read-only workspace usage. It is NOT evidence of an included model or that
 * Console Extra Usage is disabled. Persist only the documented window shape,
 * never account identifiers or arbitrary provider response properties.
 */
export async function fetchGoUsage(provider, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (providerOffering(provider.baseUrl) !== 'opencode-go' || !provider.apiKey) return null;
  const source = 'https://opencode.ai/inference/go/v1/usage';
  try {
    const response = await withTimeout(fetchImpl, timeoutMs)(source, { headers: { ...(provider.headers || {}), accept: 'application/json', authorization: `Bearer ${provider.apiKey}` }, redirect: 'error' });
    if (!response.ok) return null;
    const body = await response.json(), windows = {};
    for (const name of ['rolling', 'weekly', 'monthly']) {
      const row = body?.usage?.[name];
      if (!row || !['ok', 'rate-limited'].includes(row.status) || typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100 || typeof row.resetsAt !== 'string' || !Number.isFinite(Date.parse(row.resetsAt))) return null;
      windows[name] = { status: row.status, percent: row.percent, resetsAt: new Date(row.resetsAt).toISOString() };
    }
    return { source, at: new Date().toISOString(), windows, accountEntitlementVerified: false, extraUsageEnabled: null };
  } catch { return null; }
}

/** Wrap fetch so a hung provider cannot hold /api/models forever. */
function withTimeout(fetchImpl, timeoutMs) {
  return async (url, opts = {}) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        fetchImpl(url, { ...opts, signal: AbortSignal.any([controller.signal, opts.signal].filter(Boolean)) }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Catalog timed out')); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
}

/** Refresh every wired provider in parallel and persist the cache. */
export async function refreshAllCatalogs({ home, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const providers = providersFromConfig({ home, env }).filter((p) => p.hasKey);
  const entries = await Promise.all(providers.map(async (p) => [
    p.name,
    await refreshProviderCatalog({ home, env, providerName: p.name, fetchImpl }),
  ]));
  return Object.fromEntries(entries);
}

const liveResults = new Map(); // "provider/model" -> { ok, at, errorClass }

export function recordLiveResult(modelId, result) {
  liveResults.set(modelId, { at: new Date().toISOString(), ...result });
}

export function liveResultFor(modelId) {
  return liveResults.get(modelId) || null;
}

export function configFilePath({ home, env = process.env }) {
  return env.MAJIN_CONFIG || path.join(home, 'config.json');
}

function readConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/** Endpoint identity, never a guess from a friendly provider/model label. */
export function providerOffering(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.origin === 'https://opencode.ai') {
      if (/^\/(?:zen\/go\/v1|inference\/go\/(?:v1|openai\/v1|anthropic\/v1|google\/v1beta))(?:\/|$)/.test(url.pathname)) return 'opencode-go';
      if (/^\/zen\/v1(?:\/|$)/.test(url.pathname)) return 'opencode-zen';
    }
  } catch { /* unknown */ }
  return 'other';
}

/**
 * Build the catalogue. Never throws on a broken config: an unreadable file
 * yields `source: 'none'` and the demo lane, which the UI states plainly.
 */
export function discoverModels({ home, env = process.env } = {}) {
  const file = configFilePath({ home, env });
  const cfg = readConfig(file);
  const cache = readCatalogCache({ home });
  const result = {
    source: cfg ? 'v1-config' : 'none',
    configPath: file,
    configReadable: Boolean(cfg),
    providers: [],
    models: [],
    current: null,
    liveVerifiedCount: 0,
  };

  const envRoute = env.MAJIN_V4_MODEL || null;
  if (envRoute) {
    result.models.push({
      id: `env/${envRoute}`,
      provider: 'env',
      providerLabel: t('model.envLabel'),
      model: envRoute,
      label: envRoute,
      configured: true,
      status: 'configured',
      statusLabel: 'Konfigurerad (ej live-verifierad)',
      liveVerified: false,
    });
    result.providers.push({ name: 'env', label: t('model.envLabel'), kind: 'openai', hasKey: true, host: null, models: [envRoute] });
    result.current = `env/${envRoute}`;
  }

  const providers = cfg?.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') continue;
    const declaredModels = Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string' && m.trim()) : [];
    const cached = cache.providers?.[name];
    const discoveredModels = Array.isArray(cached?.models) ? cached.models : [];
    const models = [...new Set([...declaredModels, ...discoveredModels])];
    const apiKey = expandEnvValue(p.apiKey, env);
    const hasKey = Boolean(apiKey);
    if (!hasKey && !models.length) continue; // nothing to offer
    const entry = {
      name,
      label: typeof p.label === 'string' ? p.label : name,
      kind: ['openai', 'anthropic', 'responses', 'mock'].includes(p.kind) ? p.kind : 'openai',
      host: hostOf(p.baseUrl) || null,
      hasKey,
      models: [...models],
      catalogAt: cacheEntryFresh(cached) ? cached.at : null,
      offering: providerOffering(p.baseUrl),
      catalogStale: Boolean(cached?.at) && !cacheEntryFresh(cached),
      usage: cached?.usage ? { ...cached.usage, stale: Date.now() - Date.parse(cached.usage.at) > 60000 } : null,
    };
    result.providers.push(entry);
    for (const model of models) {
      const id = `${name}/${model}`;
      const live = liveResults.get(id);
      const fromCatalog = discoveredModels.includes(model) && !declaredModels.includes(model);
      const metadata = cached?.metadata?.find((m) => m.id === model);
      const status = !hasKey
        ? 'missing-key'
        : live
          ? (live.ok ? 'verified' : 'unavailable')
          : fromCatalog
            ? 'discovered'
            : 'configured';
      result.models.push({
        id,
        provider: name,
        providerLabel: entry.label,
        model,
        label: `${entry.label} · ${model}`,
        configured: hasKey,
        status,
        statusLabel: {
          'missing-key': t('model.status.missingKey'),
          configured: t('model.status.configured'),
          discovered: t('model.status.discovered'),
          verified: t('model.status.verified'),
          unavailable: t('model.status.unavailable'),
        }[status],
        discoveredVia: fromCatalog ? 'catalog' : (declaredModels.includes(model) ? 'config' : null),
        liveVerified: status === 'verified',
        offering: entry.offering,
        availableThroughGo: entry.offering === 'opencode-go' ? (discoveredModels.includes(model) ? true : null) : false,
        displayName: metadata?.name || model,
        contextWindow: metadata?.context || null,
        capabilities: { tools: metadata?.tools ?? null, vision: metadata?.vision ?? null },
        // Listing access and token prices do not establish the owner's plan.
        billing: { status: 'unknown', label: 'Cost unknown — verify with provider', subscriptionIncluded: null, additionalUsageCost: null, verifiedAt: null },
        pricing: metadata ? { inputPerMillion: metadata.input ?? null, outputPerMillion: metadata.output ?? null, source: cached.source || null, verifiedAt: cached.at || null, stale: !cacheEntryFresh(cached), note: entry.offering === 'opencode-go' ? 'Provider token prices may measure subscription allowance; account entitlement is unverified.' : 'Provider catalogue prices; account entitlement is unverified.' } : null,
        catalogStale: entry.catalogStale,
        ...(live?.errorClass ? { errorClass: live.errorClass } : {}),
      });
    }
  }

  if (!result.current && cfg?.models?.routes?.chat) {
    const ref = String(cfg.models.routes.chat);
    if (result.models.some((m) => m.id === ref)) result.current = ref;
  }
  if (!result.current && result.models.length) {
    const firstUsable = result.models.find((m) => m.configured);
    result.current = firstUsable ? firstUsable.id : result.models[0].id;
  }
  result.liveVerifiedCount = result.models.filter((m) => m.liveVerified).length;
  result.catalog = {
    at: Object.values(cache.providers || {}).map((e) => e?.at).filter(Boolean).sort().pop() || null,
    ttlMs: CATALOG_TTL_MS,
    providers: Object.fromEntries(Object.entries(cache.providers || {}).map(([k, v]) => [k, { ok: Boolean(v?.ok), at: v?.at || null, stale: !cacheEntryFresh(v), count: v?.models?.length || 0, ...(v?.error ? { error: v.error } : {}) }])),
  };
  return result;
}

/** Return a safe diagnostic code for why the selected route cannot be resolved. */
export function routeUnavailableReason({ home, env = process.env, modelId, base }) {
  if (!modelId) return 'no-model';
  if (modelId.startsWith('env/')) {
    if (!base || base.kind === 'demo') return 'env-route-unavailable';
    if (`env/${base.model}` !== modelId) return 'env-route-mismatch';
    return 'route-unresolved';
  }
  const cfg = readConfig(configFilePath({ home, env }));
  if (!cfg) return 'config-missing';
  const slash = modelId.indexOf('/');
  if (slash < 1 || slash === modelId.length - 1) return 'invalid-model-id';
  const providerName = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  const provider = cfg.providers?.[providerName];
  if (!provider) return 'provider-missing';
  if (!provider.baseUrl) return 'endpoint-missing';
  const declared = Array.isArray(provider.models) ? provider.models : [];
  const cached = readCatalogCache({ home }).providers?.[providerName];
  const discovered = cacheEntryFresh(cached) ? cached.models : [];
  if (!declared.includes(model) && !discovered.includes(model)) return 'model-not-listed';
  if (!expandEnvValue(provider.apiKey, env)) return 'api-key-missing';
  return 'route-unresolved';
}

/**
 * Resolve a model id to a complete route, or null when it is not authorised.
 * Only ids present in the discovered catalogue (or the explicit env route)
 * are accepted, so the phone cannot point MAJIN at an arbitrary endpoint.
 */
export function resolveRouteForModel({ home, env = process.env, modelId, base }) {
  if (!modelId) return null;
  if (modelId.startsWith('env/')) {
    if (!base || base.kind === 'demo') return null;
    if (`env/${base.model}` !== modelId) return null;
    return base;
  }
  const cfg = readConfig(configFilePath({ home, env }));
  if (!cfg) return null;
  const slash = modelId.indexOf('/');
  if (slash < 1) return null;
  const providerName = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  const provider = cfg.providers?.[providerName];
  if (!provider || !provider.baseUrl) return null;
  const declared = Array.isArray(provider.models) ? provider.models : [];
  // A model id is authorised when it is either declared in the V1 config or
  // came back from that provider's own live catalog (cached, TTL-bounded).
  // The provider and its endpoint are still fixed by the config.
  const cached = readCatalogCache({ home }).providers?.[providerName];
  const discovered = cacheEntryFresh(cached) ? cached.models : [];
  if (!declared.includes(model) && !discovered.includes(model)) return null;
  const apiKey = expandEnvValue(provider.apiKey, env);
  if (!apiKey) return null;
  const kind = ['anthropic', 'responses', 'mock'].includes(provider.kind) ? provider.kind : 'openai';
  const raw = String(provider.baseUrl).replace(/\/+$/, '');
  return {
    kind,
    providerName,
    label: provider.label || providerName,
    baseUrl: raw,
    endpoint: kind === 'anthropic'
      ? (raw.endsWith('/messages') ? raw : `${raw}/messages`)
      : (raw.endsWith('/chat/completions') ? raw : `${raw}/chat/completions`),
    apiKey,
    model,
    extraHeaders: provider.headers || null,
    maxTokens: base?.maxTokens || 2048,
    temperature: base?.temperature ?? 0.4,
  };
}
