import type { ModelCapabilities, ProviderConfig, ProviderUsage } from '@studdy/shared';
import { dayKey, LruCache, RateLimiter, stableKey, nowIso } from '@studdy/shared';
import type { Database } from '@studdy/database';
import {
  OpenAiCompatibleClient,
  ProviderError,
  estimateCost,
  estimateTokens,
  type ChatMessagePayload,
  type ChatRequest,
  type ChatResult,
  type StreamChunk,
} from './provider.js';
import { FileVaultKeychain, MemoryKeychain, type KeychainBackend } from './keychain.js';

export interface BudgetStatus {
  allowed: boolean;
  reason: string | null;
  spentTodayUsd: number;
  limitUsd: number;
  requestsToday: number;
}

export interface RoutedRequest {
  messages: ChatMessagePayload[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** Task class drives model choice and reasoning depth. */
  task: 'explain' | 'troubleshoot' | 'vision' | 'extract' | 'quiz' | 'cheap';
  signal?: AbortSignal;
  cacheable?: boolean;
}

export interface RouterDeps {
  db: Database;
  keychain?: KeychainBackend;
  keychainDataDir?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** Requests per minute cap against the provider. */
  requestsPerMinute?: number;
}

/**
 * The AI router is the single door to any language model.
 *
 * Responsibilities kept here on purpose:
 *  - budget enforcement (daily USD ceiling, token caps)
 *  - response cache keyed on the semantic request
 *  - rate limiting
 *  - reasoning depth selection per task class
 *  - usage accounting
 *
 * The rest of the app asks for an *intent*, never a raw model.
 */
export class AiRouter {
  private readonly clock: () => number;
  private readonly cache = new LruCache<ChatResult>(200, 10 * 60_000);
  private readonly limiter: RateLimiter;
  private readonly keychain: KeychainBackend;
  private readonly capabilityCache = new Map<string, ModelCapabilities>();

  constructor(private readonly deps: RouterDeps) {
    this.clock = deps.clock ?? Date.now;
    this.limiter = new RateLimiter(deps.requestsPerMinute ?? 30, (deps.requestsPerMinute ?? 30) / 60, this.clock);
    this.keychain =
      deps.keychain ?? (deps.keychainDataDir ? new FileVaultKeychain(deps.keychainDataDir) : new MemoryKeychain());
  }

  setApiKey(providerId: string, secret: string): void {
    this.keychain.set(`provider:${providerId}`, secret);
  }

  hasApiKey(providerId: string): boolean {
    return Boolean(this.keychain.get(`provider:${providerId}`));
  }

  deleteApiKey(providerId: string): void {
    this.keychain.delete(`provider:${providerId}`);
  }

  budget(provider: ProviderConfig): BudgetStatus {
    const usage = this.deps.db.usage.today(this.clock);
    const spent = usage.estimatedCostUsd;
    if (spent >= provider.dailyCostLimitUsd) {
      return {
        allowed: false,
        reason: `Dagens budget är slut (${spent.toFixed(3)} USD av ${provider.dailyCostLimitUsd} USD). Höj gränsen i inställningarna om du vill fortsätta.`,
        spentTodayUsd: spent,
        limitUsd: provider.dailyCostLimitUsd,
        requestsToday: usage.requests,
      };
    }
    return { allowed: true, reason: null, spentTodayUsd: spent, limitUsd: provider.dailyCostLimitUsd, requestsToday: usage.requests };
  }

  usageToday(): ProviderUsage {
    return this.deps.db.usage.today(this.clock);
  }

  /** Picks the model id for the task class. Never a hardcoded vendor model. */
  selectModel(provider: ProviderConfig, task: RoutedRequest['task']): string {
    if (task === 'vision') {
      if (!provider.visionModelId) {
        throw new ProviderError(
          'Ingen vision-modell är konfigurerad. Ange ett verifierat vision-modell-id i providerinställningarna.',
          'bad_request',
        );
      }
      return provider.visionModelId;
    }
    if (task === 'cheap' && provider.fallbackModelId) return provider.fallbackModelId;
    return provider.modelId;
  }

  private reasoningFor(provider: ProviderConfig, task: RoutedRequest['task']): 'off' | 'auto' | 'deep' {
    if (provider.reasoning === 'off') return 'off';
    if (task === 'troubleshoot' || task === 'extract') return provider.reasoning === 'deep' ? 'deep' : 'auto';
    return provider.reasoning === 'deep' && task === 'vision' ? 'auto' : provider.reasoning === 'auto' ? 'off' : provider.reasoning;
  }

  private client(provider: ProviderConfig): OpenAiCompatibleClient {
    return new OpenAiCompatibleClient(provider, this.keychain.get(`provider:${provider.id}`), {
      fetchImpl: this.deps.fetchImpl,
    });
  }

  private guard(provider: ProviderConfig): void {
    if (!this.limiter.tryTake()) {
      throw new ProviderError(
        `Lokalt hastighetsgräns nådd. Vänta ${Math.ceil(this.limiter.waitMs() / 1000)} s och försök igen.`,
        'rate_limit',
      );
    }
    const budget = this.budget(provider);
    if (!budget.allowed) throw new ProviderError(budget.reason ?? 'Budget slut', 'rate_limit');
  }

  private recordUsage(provider: ProviderConfig, input: number, output: number): void {
    this.deps.db.usage.add({
      inputTokens: input,
      outputTokens: output,
      costUsd: estimateCost({ inputTokens: input, outputTokens: output }, provider),
      clock: this.clock,
    });
  }

  private cacheKey(provider: ProviderConfig, request: RoutedRequest, model: string): string {
    return stableKey(
      provider.id,
      model,
      String(request.maxTokens ?? ''),
      String(request.jsonMode ?? false),
      request.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n'),
    );
  }

  /**
   * Non-streaming call with cache + budget + fallback.
   * Falls back to `provider.fallbackModelId` only on provider-side failure.
   */
  async complete(provider: ProviderConfig, request: RoutedRequest): Promise<ChatResult> {
    const model = this.selectModel(provider, request.task);
    const cacheable = request.cacheable ?? true;
    const key = this.cacheKey(provider, request, model);
    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }

    this.guard(provider);
    const client = this.client(provider);
    const base: ChatRequest = {
      messages: request.messages,
      model,
      maxTokens: Math.min(request.maxTokens ?? 800, provider.maxTokensPerRequest),
      temperature: request.temperature,
      jsonMode: request.jsonMode,
      reasoning: this.reasoningFor(provider, request.task),
      signal: request.signal,
    };

    try {
      const result = await client.chat(base);
      this.recordUsage(provider, result.usage.inputTokens, result.usage.outputTokens);
      if (cacheable) this.cache.set(key, result);
      return result;
    } catch (err) {
      // Kilo's Auto Efficient is a paid tier. If it returns HTTP 402,
      // retry text-only requests with the documented no-credit Auto Free.
      // Never silently downgrade vision requests or spend credits.
      if (
        err instanceof ProviderError &&
        err.status === 402 &&
        /(^|\.)kilo\.ai$/i.test(new URL(provider.baseUrl).hostname) &&
        request.task !== 'vision' &&
        model !== 'kilo-auto/free'
      ) {
        const free: ChatRequest = { ...base, model: 'kilo-auto/free' };
        const result = await client.chat(free);
        this.recordUsage(provider, result.usage.inputTokens, result.usage.outputTokens);
        this.deps.db.providers.save({ ...provider, modelId: 'kilo-auto/free' });
        return result;
      }
      const canFallback =
        provider.fallbackModelId &&
        model !== provider.fallbackModelId &&
        err instanceof ProviderError &&
        (err.kind === 'server' || err.kind === 'rate_limit' || err.kind === 'unknown');

      if (!canFallback) throw err;

      const fallback: ChatRequest = { ...base, model: provider.fallbackModelId as string };
      const result = await client.chat(fallback);
      this.recordUsage(provider, result.usage.inputTokens, result.usage.outputTokens);
      return result;
    }
  }

  /** Streaming call. Not cached (the point is to show progress). */
  async *stream(provider: ProviderConfig, request: RoutedRequest): AsyncGenerator<StreamChunk> {
    const model = this.selectModel(provider, request.task);
    this.guard(provider);
    const client = this.client(provider);
    let inputTokens = estimateTokens(request.messages);
    let outputChars = 0;

    for await (const chunk of client.stream({
      messages: request.messages,
      model,
      maxTokens: Math.min(request.maxTokens ?? 800, provider.maxTokensPerRequest),
      temperature: request.temperature,
      reasoning: this.reasoningFor(provider, request.task),
      signal: request.signal,
    })) {
      if (chunk.done) {
        const outputTokens = chunk.usage?.outputTokens ?? Math.ceil(outputChars / 4);
        const input = chunk.usage?.inputTokens ?? inputTokens;
        inputTokens = input;
        this.recordUsage(provider, input, outputTokens);
      } else {
        outputChars += chunk.delta.length;
      }
      yield chunk;
    }
  }

  async capabilities(provider: ProviderConfig, force = false): Promise<ModelCapabilities> {
    const cached = this.capabilityCache.get(provider.id);
    if (cached && !force) return cached;
    const stored = this.deps.db.checkpoints.get<ModelCapabilities>(`capabilities:${provider.id}:${provider.modelId}`);
    if (stored && !force) {
      this.capabilityCache.set(provider.id, stored);
      return stored;
    }
    const caps = await this.client(provider).probeCapabilities(this.clock);
    this.capabilityCache.set(provider.id, caps);
    this.deps.db.checkpoints.set(`capabilities:${provider.id}:${provider.modelId}`, caps);
    return caps;
  }

  /** Provider health check used by `studdy doctor` and the settings screen. */
  async health(provider: ProviderConfig): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = this.clock();
    try {
      const res = await this.complete(provider, {
        messages: [
          { role: 'system', content: 'You are a health check. Reply with the single word OK.' },
          { role: 'user', content: 'ping' },
        ],
        maxTokens: 8,
        task: 'cheap',
        cacheable: false,
      });
      return { ok: true, detail: `Modell ${res.model} svarade`, latencyMs: this.clock() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: message, latencyMs: this.clock() - started };
    }
  }

  todayKey(): string {
    return dayKey(this.clock);
  }

  stamp(): string {
    return nowIso(this.clock);
  }
}
