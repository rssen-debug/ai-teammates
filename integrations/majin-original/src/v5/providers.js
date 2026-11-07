/**
 * MAJIN V5 — Provider & Model Manager (Section 7).
 *
 * Flow: select provider -> connect -> select available model -> start.
 *
 * Reuses V1's `src/core/provider/catalog.js` and `src/core/provider/chat.js`.
 *
 * Enforces:
 *  - OpenCode Go is first-class (`opencode-go`) with `User-Agent: majin-v5/5.0.0`
 *    and `x-opencode-session` headers.
 *  - Provider and exact model ID survive restarts (`provider-state.json`, 0600).
 *  - Never invents models: uses live catalog discovery or explicit manual model ID fallback.
 *  - Strictly separates `savedConfig: true` from `connectionVerified: true`.
 *  - Classifies errors into `AUTH_INVALID`, `NETWORK_FAILURE`, `QUOTA_EXCEEDED`,
 *    `MODEL_NOT_FOUND`, and `TIMEOUT`.
 *  - Adapts execution to model capabilities (`tools`, `vision`, `streaming`, `contextWindow`).
 *  - Cross-provider fallback obeys owner settings (`allowPaidFallback`, `allowDataSharingFallback`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoverModels as discoverProviderCatalog } from '../core/provider/catalog.js';
import { complete as completeV1 } from '../core/provider/chat.js';
import { chatUrl, goDialect } from '../core/presets.js';

export const PROVIDER_STATE_SCHEMA = 'majin.v5.provider-state/v1';

export const PROVIDER_PRESETS = Object.freeze({
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: false,
    headers: { 'User-Agent': 'majin-v5/5.0.0' },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: false,
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsCatalog: true,
    paid: true,
    trainsOnData: true,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (Local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    supportsCatalog: true,
    paid: false,
    trainsOnData: false,
  },
});

/** Classify provider HTTP / network errors into actionable categories. */
export function classifyProviderError(err, status = null) {
  const msg = String(err?.message || err || '');
  const code = Number(status || err?.status || err?.statusCode || 0);
  if (['invalid_stream_data', 'provider_stream_error'].includes(err?.code)) {
    return { code: 'PROVIDER_STREAM_ERROR', retryable: false, message: 'The provider stream failed or contained invalid data. Incomplete tool calls were discarded; retry the goal when the provider is available.' };
  }

  if (err?.name === 'AbortError' || /abort|timed?\s*out/i.test(msg)) {
    return { code: 'TIMEOUT', retryable: true, message: 'Provider request timed out or was aborted.' };
  }
  if (code === 403 && !/invalid.*key|unauthorized|authentication/i.test(msg)) {
    return { code: 'ACCESS_DENIED', retryable: false, message: 'The provider denied access. Check model availability and workspace privacy/region policy; do not replace a valid key blindly.' };
  }
  if (code === 401 || /invalid.*key|unauthorized|authentication/i.test(msg)) {
    return { code: 'AUTH_INVALID', retryable: false, message: 'API key was rejected by provider (401/403).' };
  }
  if (code === 429 || /quota|rate.?limit|insufficient_quota|allowance/i.test(msg)) {
    return { code: 'QUOTA_EXCEEDED', retryable: true, message: 'Provider quota or rate limit reached (429).' };
  }
  if (code === 404 || /model.*not.*found|does not exist|unknown model/i.test(msg)) {
    return { code: 'MODEL_NOT_FOUND', retryable: false, message: 'Requested model ID was not found on this provider (404).' };
  }
  if (code >= 500 || /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(msg)) {
    return { code: 'NETWORK_FAILURE', retryable: true, message: 'Network or upstream server failure reaching provider.' };
  }
  return { code: 'PROVIDER_ERROR', retryable: false, message: 'Provider request failed.' };
}

/** Mask an API key so secrets are never leaked in responses or logs. */
export function maskSecret(key) {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 6) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-2)}`;
}

export class ProviderManager {
  constructor({ dataDir, fetchImpl = globalThis.fetch, completeImpl = null }) {
    if (!dataDir) throw new Error('ProviderManager requires dataDir');
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'provider-state.json');
    this.secretsFile = path.join(dataDir, 'provider-secrets.json');
    this.fetchImpl = fetchImpl;
    this.completeImpl = completeImpl;
    const hadStateFile = fs.existsSync(this.stateFile);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#loadState();
    this.secrets = this.#loadSecrets();
    if (!hadStateFile) {
      this.#seedFromLegacyMajinIfPresent();
    }
  }

  #seedFromLegacyMajinIfPresent() {
    if (path.basename(this.dataDir) !== 'v5') return;
    const majinRoot = path.dirname(this.dataDir);
    // 1. Check V4 provider.json (read-only, never modify V4 files)
    const v4ProviderFile = path.join(majinRoot, 'v4', 'provider.json');
    if (fs.existsSync(v4ProviderFile)) {
      try {
        const v4 = JSON.parse(fs.readFileSync(v4ProviderFile, 'utf8'));
        const provId = String(v4.provider || v4.activeProvider || 'opencode-go').toLowerCase();
        const modelId = v4.model || v4.activeModelId || null;
        if (provId) {
          this.state.activeProvider = provId;
          this.state.activeModelId = modelId;
          this.state.savedConfig = true;
          this.state.migratedFrom = 'v4';
          this.state.providers[provId] = {
            id: provId,
            label: PROVIDER_PRESETS[provId]?.label || provId,
            kind: v4.kind || PROVIDER_PRESETS[provId]?.kind || 'openai',
            baseUrl: v4.baseUrl || PROVIDER_PRESETS[provId]?.baseUrl || 'https://opencode.ai/zen/go/v1',
            savedConfig: true,
            connectionVerified: false,
            activeModelId: modelId,
            discoveredModels: [],
            modelCapabilities: {},
            lastError: null,
          };
          if (v4.apiKey) {
            this.secrets[provId] = v4.apiKey;
            this.#saveSecrets();
          }
          this.#saveState();
          return;
        }
      } catch { /* ignore corrupt legacy file */ }
    }
    // 2. Check V1 config.json (read-only, never modify V1 files)
    const v1ConfigFile = path.join(majinRoot, 'config.json');
    if (fs.existsSync(v1ConfigFile)) {
      try {
        const v1 = JSON.parse(fs.readFileSync(v1ConfigFile, 'utf8'));
        const route = String(v1?.models?.routes?.chat || '');
        const [rawProv, ...modelParts] = route.split('/');
        const provId = (rawProv || '').trim().toLowerCase();
        const modelId = modelParts.join('/').trim() || null;
        if (provId) {
          const v1Prov = v1?.providers?.[provId] || {};
          this.state.activeProvider = provId;
          this.state.activeModelId = modelId;
          this.state.savedConfig = true;
          this.state.migratedFrom = 'v1';
          this.state.providers[provId] = {
            id: provId,
            label: PROVIDER_PRESETS[provId]?.label || provId,
            kind: v1Prov.kind || PROVIDER_PRESETS[provId]?.kind || 'openai',
            baseUrl: v1Prov.baseUrl || PROVIDER_PRESETS[provId]?.baseUrl || 'https://opencode.ai/zen/go/v1',
            savedConfig: true,
            connectionVerified: false,
            activeModelId: modelId,
            discoveredModels: [],
            modelCapabilities: {},
            lastError: null,
          };
          if (v1Prov.apiKey) {
            this.secrets[provId] = v1Prov.apiKey;
            this.#saveSecrets();
          }
          this.#saveState();
        }
      } catch { /* ignore */ }
    }
  }

  #loadState() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (raw?.schema === PROVIDER_STATE_SCHEMA) return raw;
      } catch { /* fall through */ }
    }
    return {
      schema: PROVIDER_STATE_SCHEMA,
      updatedAt: new Date().toISOString(),
      activeProvider: 'opencode-go',
      activeModelId: null,
      manualModelFallback: false,
      savedConfig: false,
      connectionVerified: false,
      lastVerifiedAt: null,
      lastVerifiedModelId: null,
      fallbackPolicy: {
        allowPaidFallback: false,
        allowDataSharingFallback: false,
        fallbackProvider: null,
        fallbackModelId: null,
      },
      providers: {},
    };
  }

  #loadSecrets() {
    if (fs.existsSync(this.secretsFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) || {};
      } catch {
        return {};
      }
    }
    return {};
  }

  #saveState() {
    this.state.updatedAt = new Date().toISOString();
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  #saveSecrets() {
    const tmp = `${this.secretsFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.secretsFile);
  }

  /**
   * Step 1 & 2: Configure/connect a provider and optionally fetch its live catalog.
   * Explicitly separates `savedConfig: true` from `connectionVerified`.
   */
  async configureProvider({
    providerId = 'opencode-go',
    apiKey = null,
    baseUrl = null,
    kind = null,
    label = null,
    discover = false,
    timeoutMs = 8000,
  } = {}) {
    const id = String(providerId || '').trim().toLowerCase();
    if (!id) throw new Error('providerId is required');
    const preset = PROVIDER_PRESETS[id] || {
      id,
      label: label || id,
      kind: kind || 'openai',
      baseUrl: baseUrl || 'http://127.0.0.1:11434/v1',
      supportsCatalog: true,
      paid: false,
      trainsOnData: false,
    };

    if (apiKey !== null && apiKey !== undefined) {
      this.secrets[id] = String(apiKey).trim();
      this.#saveSecrets();
    }

    const prev = this.state.providers[id] || {};
    this.state.providers[id] = {
      id,
      label: label || preset.label || id,
      kind: kind || preset.kind || 'openai',
      baseUrl: String(baseUrl || prev.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
      hasKey: Boolean(this.secrets[id] || id === 'ollama'),
      maskedKey: maskSecret(this.secrets[id]),
      paid: Boolean(preset.paid),
      trainsOnData: Boolean(preset.trainsOnData),
      savedConfig: true,
      connectionVerified: false, // Reset until verified by live catalog or model call!
      lastVerifiedAt: null,
      discoveredModels: Array.isArray(prev.discoveredModels) ? prev.discoveredModels : [],
      modelCapabilities: prev.modelCapabilities || {},
      lastError: null,
    };
    if (this.state.activeProvider !== id) this.state.activeModelId = prev.activeModelId || null;
    this.state.activeProvider = id;
    this.state.savedConfig = true;
    // Saving config NEVER marks connectionVerified = true!
    this.state.connectionVerified = false;
    this.#saveState();

    if (discover) {
      return this.discoverCatalog(id, { timeoutMs });
    }
    return this.getPublicState();
  }

  /** Fetch live model catalog from provider without inventing any static models. */
  async discoverCatalog(providerId = this.state.activeProvider, { timeoutMs = 8000 } = {}) {
    const id = String(providerId || this.state.activeProvider);
    const p = this.state.providers[id];
    if (!p) {
      return { ok: false, error: { code: 'PROVIDER_NOT_CONFIGURED', message: `Provider ${id} is not configured.` } };
    }
    const apiKey = this.secrets[id] || '';
    if (!apiKey && id !== 'ollama') {
      p.connectionVerified = false;
      p.lastError = { code: 'AUTH_INVALID', message: 'API key is missing.' };
      this.#saveState();
      return { ok: false, error: p.lastError, models: [] };
    }

    try {
      const headers = id === 'opencode-go' ? { 'User-Agent': 'majin-v5/5.0.0' } : {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await discoverProviderCatalog(
          {
            kind: p.kind,
            baseUrl: p.baseUrl,
            apiKey,
            headers,
            models: [], // Never inject fake static models!
          },
          {
            fetchImpl: (url, opts = {}) =>
              this.fetchImpl(url, { ...opts, signal: controller.signal }),
          },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const classified = classifyProviderError(new Error(res.error || 'Catalog failed'), res.status);
        p.connectionVerified = false;
        p.lastError = classified;
        this.#saveState();
        return { ok: false, error: classified, models: [] };
      }

      p.discoveredModels = [...new Set(res.models || [])];
      p.modelCapabilities = {};
      for (const item of res.catalog || []) {
        if (!item?.id) continue;
        const raw = res.payload?.data?.find(row => (typeof row === 'string' ? row : row.id || row.model) === item.id);
        const declaredTools = raw?.tools ?? raw?.capabilities?.tools;
        const hasToolMetadata = typeof declaredTools === 'boolean' || Array.isArray(raw?.supported_parameters) || Array.isArray(raw?.features);
        p.modelCapabilities[item.id] = {
          tools: typeof declaredTools === 'boolean' ? declaredTools : hasToolMetadata ? item.tools !== false : true,
          vision: Boolean(item.vision),
          streaming: item.streaming !== false,
          contextWindow: Number(item.context) || 128_000,
        };
      }
      if (id === 'opencode-go' && this.state.activeProvider === id && !this.state.activeModelId) {
        const preferred = p.discoveredModels.find(model => model === 'deepseek-v4-pro') ||
          p.discoveredModels.find(model => /^deepseek-/i.test(model));
        if (preferred) this.selectModel({ providerId: id, modelId: preferred });
      }
      p.connectionVerified = true;
      p.lastVerifiedAt = new Date().toISOString();
      p.lastError = null;
      if (this.state.activeProvider === id) {
        this.state.connectionVerified = true;
        this.state.lastVerifiedAt = p.lastVerifiedAt;
      }
      this.#saveState();
      return {
        ok: true,
        providerId: id,
        models: p.discoveredModels,
        capabilities: p.modelCapabilities,
        connectionVerified: true,
      };
    } catch (err) {
      const classified = classifyProviderError(err);
      p.connectionVerified = false;
      p.lastError = classified;
      this.#saveState();
      return { ok: false, error: classified, models: [] };
    }
  }

  /**
   * Step 3: Select an available discovered model OR an explicit manual model ID fallback.
   * Never marks `connectionVerified: true` merely from selecting a model!
   */
  selectModel({
    providerId = this.state.activeProvider,
    modelId,
    allowManualFallback = false,
    capabilities = null,
  } = {}) {
    const id = String(providerId || this.state.activeProvider || '').trim();
    const model = String(modelId || '').trim();
    if (!id || !model) {
      const err = new Error('Both providerId and modelId are required');
      err.code = 'INVALID_MODEL_SELECTION';
      throw err;
    }

    if (!this.state.providers[id]) {
      const preset = PROVIDER_PRESETS[id] || { id, label: id, kind: 'openai', baseUrl: 'https://opencode.ai/inference/go/v1' };
      this.state.providers[id] = {
        id,
        label: preset.label,
        kind: preset.kind,
        baseUrl: preset.baseUrl,
        hasKey: Boolean(this.secrets[id]),
        maskedKey: maskSecret(this.secrets[id]),
        paid: Boolean(preset.paid),
        trainsOnData: Boolean(preset.trainsOnData),
        savedConfig: true,
        connectionVerified: false,
        discoveredModels: [],
        modelCapabilities: {},
        lastError: null,
      };
    }

    const p = this.state.providers[id];
    const inCatalog = p.discoveredModels.includes(model);
    if (!inCatalog && !allowManualFallback) {
      const err = new Error(`Model "${model}" is not in discovered catalog for ${id}. Pass allowManualFallback=true for manual model ID.`);
      err.code = 'MODEL_NOT_IN_CATALOG';
      throw err;
    }

    this.state.activeProvider = id;
    this.state.activeModelId = model;
    p.activeModelId = model;
    this.state.manualModelFallback = !inCatalog;
    this.state.savedConfig = true;
    // Selecting a model is saved configuration, NOT proof of verified inference on this model!
    if (this.state.lastVerifiedModelId !== `${id}/${model}`) {
      this.state.connectionVerified = false;
    }

    if (capabilities && typeof capabilities === 'object') {
      p.modelCapabilities[model] = {
        tools: capabilities.tools !== false,
        vision: Boolean(capabilities.vision),
        streaming: capabilities.streaming !== false,
        contextWindow: Number(capabilities.contextWindow) || 128_000,
      };
    } else if (!p.modelCapabilities[model]) {
      p.modelCapabilities[model] = {
        tools: true,
        vision: /vision|gpt-4o|claude-3|gemini|grok-4|glm-4v|qwen.*vl/i.test(model),
        streaming: true,
        contextWindow: 128_000,
      };
    }

    this.#saveState();
    return this.getPublicState();
  }

  /** Configure fallback policy respecting owner cost and data-sharing settings. */
  setFallbackPolicy({
    allowPaidFallback = false,
    allowDataSharingFallback = false,
    fallbackProvider = null,
    fallbackModelId = null,
  } = {}) {
    this.state.fallbackPolicy = {
      allowPaidFallback: Boolean(allowPaidFallback),
      allowDataSharingFallback: Boolean(allowDataSharingFallback),
      fallbackProvider: fallbackProvider ? String(fallbackProvider) : null,
      fallbackModelId: fallbackModelId ? String(fallbackModelId) : null,
    };
    this.#saveState();
    return this.state.fallbackPolicy;
  }

  /** Get capabilities for the active or specified model. */
  getCapabilities(providerId = this.state.activeProvider, modelId = this.state.activeModelId) {
    const p = this.state.providers[providerId];
    const caps = p?.modelCapabilities?.[modelId];
    return caps || {
      tools: true,
      vision: false,
      streaming: true,
      contextWindow: 128_000,
    };
  }

  /**
   * Execute a model call using the exact selected model ID, adapting payload to
   * model capabilities, enforcing timeout/abort, and applying controlled retries.
   */
  async complete({
    messages = [],
    tools = [],
    sessionId = 'majin-v5-session',
    signal = null,
    timeoutMs = 20_000,
    maxRetries = 1,
    onEvent = null,
  } = {}) {
    const providerId = this.state.activeProvider;
    const modelId = this.state.activeModelId;
    if (!providerId || !modelId) {
      return {
        ok: false,
        error: { code: 'MODEL_NOT_SELECTED', message: 'Select a provider and model before starting.' },
      };
    }

    let primaryEventSeen = false;
    const primaryOnEvent = onEvent ? (event) => {
      primaryEventSeen = true;
      onEvent(event);
    } : null;
    const primaryRes = await this.#invokeProvider({
      providerId,
      modelId,
      messages,
      tools,
      sessionId,
      signal,
      timeoutMs,
      maxRetries,
      onEvent: primaryOnEvent,
    });

    if (primaryRes.ok) {
      return primaryRes;
    }

    // Check if fallback provider is configured and permitted by owner's cost & data-sharing rules
    const fb = this.state.fallbackPolicy || {};
    if (fb.fallbackProvider && fb.fallbackModelId && fb.fallbackProvider !== providerId) {
      const fbProvider = this.state.providers[fb.fallbackProvider] || PROVIDER_PRESETS[fb.fallbackProvider];
      if (fbProvider) {
        if (fbProvider.paid && !fb.allowPaidFallback) {
          return {
            ...primaryRes,
            fallbackBlockedReason: 'FALLBACK_BLOCKED_BY_COST_POLICY',
          };
        }
        if (fbProvider.trainsOnData && !fb.allowDataSharingFallback) {
          return {
            ...primaryRes,
            fallbackBlockedReason: 'FALLBACK_BLOCKED_BY_DATA_SHARING_POLICY',
          };
        }
        if (primaryEventSeen && onEvent) {
          try { onEvent({ type: 'retry', attempt: null, fallback: true }); } catch { /* ignore */ }
        }
        const fbRes = await this.#invokeProvider({
          providerId: fb.fallbackProvider,
          modelId: fb.fallbackModelId,
          messages,
          tools,
          sessionId,
          signal,
          timeoutMs,
          maxRetries: 0,
          onEvent,
        });
        return {
          ...fbRes,
          usedFallback: true,
          primaryError: primaryRes.error,
        };
      }
    }

    return primaryRes;
  }

  async #invokeProvider({
    providerId,
    modelId,
    messages,
    tools,
    sessionId,
    signal,
    timeoutMs,
    maxRetries,
    onEvent = null,
  }) {
    const p = this.state.providers[providerId] || PROVIDER_PRESETS[providerId];
    if (!p) {
      return { ok: false, error: { code: 'PROVIDER_NOT_FOUND', message: `Unknown provider: ${providerId}` } };
    }
    const apiKey = this.secrets[providerId] || '';
    if (!apiKey && providerId !== 'ollama' && !this.completeImpl) {
      return { ok: false, error: { code: 'AUTH_INVALID', message: `No API key configured for ${providerId}` } };
    }

    const caps = this.getCapabilities(providerId, modelId);

    // Adapt request to model's actual capabilities
    if (tools.length && caps.tools === false) {
      return { ok: false, error: { code: 'MODEL_TOOLS_UNAVAILABLE',
        message: `The saved capabilities for ${providerId}/${modelId} disable tools. Refresh the model catalog or select a tool-capable model; no tool-enabled request was sent.` } };
    }
    const adaptedTools = tools;
    const adaptedMessages = caps.vision
      ? messages
      : messages.map((m) => {
          if (!Array.isArray(m.content)) return m;
          return {
            ...m,
            content: m.content
              .filter((part) => part.type !== 'image_url' && part.type !== 'image')
              .map((part) => (typeof part === 'string' ? part : part.text || ''))
              .join('\n'),
          };
        });

    const headers = {
      ...(providerId === 'opencode-go'
        ? {
            'User-Agent': 'majin-v5/5.0.0',
            'x-opencode-session': String(sessionId || 'majin-v5-default'),
          }
        : {}),
    };

    // Streaming is strictly opt-in by an event consumer and only requested
    // when the selected model advertises it. The event callback is still
    // passed on the non-streaming path because the shared transports emit a
    // single final-content event there; callers that do not opt in see no
    // behavioral change.
    const streamingEnabled = Boolean(onEvent && caps.streaming);
    let streamEventSeen = false;
    const emitProviderEvent = onEvent ? (event) => {
      streamEventSeen = true;
      try { onEvent(event); } catch { /* visibility callbacks must not break inference */ }
    } : undefined;

    let attempt = 0;
    while (true) {
      attempt += 1;
      if (signal?.aborted) {
        return { ok: false, error: { code: 'ABORTED', message: 'Request aborted by user.' } };
      }

      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const callFn = this.completeImpl || completeV1;
        const dialect = providerId === 'opencode-go' ? goDialect(modelId) : p.kind || 'openai';
        const response = await callFn({
          route: { providerName: providerId, kind: dialect, baseUrl: p.baseUrl,
            endpoint: chatUrl({ baseUrl: p.baseUrl, kind: dialect }), model: modelId,
            apiKey, extraHeaders: headers },
          provider: {
            name: providerId,
            kind: p.kind || 'openai',
            baseUrl: p.baseUrl,
            apiKey,
            headers,
          },
          model: modelId,
          messages: adaptedMessages,
          tools: adaptedTools,
          stream: streamingEnabled,
          ...(emitProviderEvent ? { onEvent: emitProviderEvent } : {}),
          retries: 0,
          signal: controller.signal,
        });

        // Mark connection verified ONLY after a real call succeeds!
        const verifiedAt = new Date().toISOString();
        if (this.state.providers[providerId]) {
          this.state.providers[providerId].connectionVerified = true;
          this.state.providers[providerId].lastVerifiedAt = verifiedAt;
          this.state.providers[providerId].lastError = null;
        }
        if (this.state.activeProvider === providerId && this.state.activeModelId === modelId) {
          this.state.connectionVerified = true;
          this.state.lastVerifiedAt = verifiedAt;
          this.state.lastVerifiedModelId = `${providerId}/${modelId}`;
        }
        this.#saveState();

        return {
          ok: true,
          providerId,
          modelId,
          capabilitiesUsed: {
            toolsSent: adaptedTools.length,
            visionEnabled: caps.vision,
            streamingRequested: Boolean(onEvent),
            streamingEnabled,
            streamingCapable: Boolean(caps.streaming),
          },
          headersSent: headers,
          response,
          attempts: attempt,
        };
      } catch (err) {
        const classified = classifyProviderError(err);
        if (this.state.providers[providerId]) {
          this.state.providers[providerId].connectionVerified = false;
          this.state.providers[providerId].lastError = classified;
          this.#saveState();
        }
        if (classified.retryable && attempt <= maxRetries && !signal?.aborted) {
          if (streamEventSeen && onEvent) {
            // The consumer may already have displayed partial output. Tell it
            // to discard that partial stream before the retry starts.
            try { onEvent({ type: 'retry', attempt: attempt + 1 }); } catch { /* ignore */ }
          }
          streamEventSeen = false;
          await new Promise((r) => setTimeout(r, 150 * attempt));
          continue;
        }
        return {
          ok: false,
          providerId,
          modelId,
          error: classified,
          attempts: attempt,
        };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  /** Safe public projection with secrets stripped/masked. */
  getPublicState() {
    const providers = {};
    for (const [id, p] of Object.entries(this.state.providers)) {
      providers[id] = {
        id: p.id,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl,
        hasKey: p.hasKey,
        maskedKey: p.maskedKey,
        paid: p.paid,
        trainsOnData: p.trainsOnData,
        savedConfig: Boolean(p.savedConfig),
        connectionVerified: Boolean(p.connectionVerified),
        lastVerifiedAt: p.lastVerifiedAt || null,
        discoveredModels: p.discoveredModels || [],
        modelCapabilities: p.modelCapabilities || {},
        lastError: p.lastError || null,
      };
    }
    return {
      schema: PROVIDER_STATE_SCHEMA,
      activeProvider: this.state.activeProvider,
      activeModelId: this.state.activeModelId,
      canonicalSelection: this.state.activeModelId
        ? `${this.state.activeProvider}/${this.state.activeModelId}`
        : null,
      manualModelFallback: Boolean(this.state.manualModelFallback),
      savedConfig: Boolean(this.state.savedConfig),
      connectionVerified: Boolean(this.state.connectionVerified),
      lastVerifiedAt: this.state.lastVerifiedAt,
      lastVerifiedModelId: this.state.lastVerifiedModelId,
      fallbackPolicy: this.state.fallbackPolicy,
      presets: Object.values(PROVIDER_PRESETS).map((pr) => ({
        id: pr.id,
        label: pr.label,
        kind: pr.kind,
        baseUrl: pr.baseUrl,
      })),
      providers,
    };
  }
}
