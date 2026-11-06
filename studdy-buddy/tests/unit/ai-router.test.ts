import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, type Database } from '@studdy/database';
import { AiRouter, ExplanationEngine, parseStructured, validateResponse, enforceLength, MODE_POLICIES, redactSensitive, MemoryKeychain, estimateCost } from '@studdy/ai-router';
import type { ProviderConfig } from '@studdy/shared';
import { providerConfigSchema } from '@studdy/shared';

const provider: ProviderConfig = {
  ...providerConfigSchema.parse({
    id: 'p1',
    name: 'Test provider',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'test-model',
    maxTokensPerRequest: 1000,
    dailyCostLimitUsd: 1,
  }),
  hasApiKey: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function completion(text: string, usage = { prompt_tokens: 100, completion_tokens: 50 }): Response {
  return jsonResponse({ model: 'test-model', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage });
}

describe('ExplanationEngine + AiRouter', () => {
  let db: Database;
  let router: AiRouter;
  let engine: ExplanationEngine;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => db.close());

  function makeRouter(fetchImpl: typeof fetch, keychain = new MemoryKeychain()) {
    keychain.set(`provider:${provider.id}`, 'sk-test-key');
    router = new AiRouter({ db, keychain, fetchImpl, clock: () => Date.parse('2026-03-01T10:00:00Z') });
    engine = new ExplanationEngine(router);
    return router;
  }

  it('returns a validated structured answer and records usage', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({
      directAnswer: 'ARP hittar MAC-adressen som hör till en IP-adress i det lokala nätet.',
      simpleExplanation: 'Det är som att hitta rätt mottagare innan man skickar brevet.',
      example: 'PC0 frågar vem som har 192.168.1.1 och routern svarar med sin MAC.',
      evidence: [],
      confidence: 'medium',
    }))) as unknown as typeof fetch;
    makeRouter(fetchImpl);

    const result = await engine.explain(provider, {
      question: 'Vad är ARP?',
      mode: 'NORMAL',
      language: 'sv-SE',
      contextFacts: ['Studenten läser kapitel om Layer 2'],
      knowledgeFacts: ['ARP: okänt'],
    });

    expect(result.degraded).toBe(false);
    expect(result.structured.directAnswer).toContain('ARP');
    expect(result.attempts).toBe(1);
    // Usage is bucketed by the router's clock, so read it back the same way.
    expect(router.usageToday().requests).toBe(1);
    expect(router.usageToday().inputTokens).toBe(100);
  });

  it('does not call the provider twice for identical cached requests', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ directAnswer: 'Svar.', evidence: [], confidence: 'low' })));
    makeRouter(fetchImpl as unknown as typeof fetch);
    const req = { question: 'Vad är en switch?', mode: 'QUICK' as const, language: 'sv-SE' as const, contextFacts: [], knowledgeFacts: [] };
    await engine.explain(provider, req);
    await engine.explain(provider, req);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('blocks requests when the daily budget is exhausted', async () => {
    const fetchImpl = vi.fn(async () => completion('{}')) as unknown as typeof fetch;
    makeRouter(fetchImpl);
    db.usage.add({ inputTokens: 10, outputTokens: 10, costUsd: 2, clock: () => Date.parse('2026-03-01T10:00:00Z') });
    const result = await engine.explain(provider, {
      question: 'Vad är DNS?',
      mode: 'NORMAL',
      language: 'sv-SE',
      contextFacts: [],
      knowledgeFacts: [],
    });
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/budget/i);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it('surfaces auth failures instead of silently degrading', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, 401),
    ) as unknown as typeof fetch;
    makeRouter(fetchImpl);
    const result = await engine.explain(provider, {
      question: 'x',
      mode: 'QUICK',
      language: 'en-US',
      contextFacts: [],
      knowledgeFacts: [],
    });
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/401|api key/i);
  });

  it('retries once when the model returns too-verbose JSON, then trims locally', async () => {
    const long = JSON.stringify({
      directAnswer: 'One. Two. Three. Four. Five. Six. Seven. Eight.',
      simpleExplanation: '',
      example: '',
      evidence: [],
      confidence: 'low',
    });
    const fetchImpl = vi.fn(async () => completion(long)) as unknown as typeof fetch;
    makeRouter(fetchImpl);
    const result = await engine.explain(provider, {
      question: 'x',
      mode: 'QUICK',
      language: 'en-US',
      contextFacts: [],
      knowledgeFacts: [],
    });
    expect(result.attempts).toBe(2);
    expect(result.trimmed).toBe(true);
    const sentences = result.structured.directAnswer.split('.').filter((s) => s.trim());
    expect(sentences.length).toBeLessThanOrEqual(MODE_POLICIES.QUICK.maxSentences);
  });

  it('never sends the API key to the renderer, only through the Authorization header', async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      Object.assign(seen, init?.headers ?? {});
      return completion(JSON.stringify({ directAnswer: 'OK', evidence: [], confidence: 'low' }));
    }) as unknown as typeof fetch;
    makeRouter(fetchImpl);
    await engine.explain(provider, { question: 'x', mode: 'QUICK', language: 'en-US', contextFacts: [], knowledgeFacts: [] });
    expect(seen.authorization).toBe('Bearer sk-test-key');
  });

  it('does not claim vision support without a configured vision model', async () => {
    makeRouter(vi.fn() as unknown as typeof fetch);
    await expect(
      router.complete(provider, { messages: [{ role: 'user', content: 'x' }], task: 'vision' }),
    ).rejects.toThrow(/vision-modell/i);
  });

  it('reports provider health honestly on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, 500)) as unknown as typeof fetch;
    makeRouter(fetchImpl);
    const health = await router.health(provider);
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/500/);
  });

  it('computes cost from configured per-MTok prices', () => {
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, provider);
    expect(cost).toBeCloseTo(0.14 + 0.14, 5);
  });
});

describe('structured response validation', () => {
  it('rejects filler openers', () => {
    const result = validateResponse(
      { directAnswer: 'Great question! ARP maps IP to MAC.', evidence: [], confidence: 'low' },
      'NORMAL',
    );
    expect(result.issues.map((i) => i.code)).toContain('FILLER_OPENER');
  });

  it('flags unsupported high confidence', () => {
    const result = validateResponse({ directAnswer: 'X.', evidence: [], confidence: 'high' }, 'QUICK');
    expect(result.issues.map((i) => i.code)).toContain('UNSUPPORTED_CONFIDENCE');
  });

  it('requires an example in TEACH mode', () => {
    const result = validateResponse({ directAnswer: 'X.', example: '', evidence: [], confidence: 'medium' }, 'TEACH');
    expect(result.issues.map((i) => i.code)).toContain('MISSING_EXAMPLE');
  });

  it('parses JSON wrapped in markdown fences', () => {
    const parsed = parseStructured('```json\n{"directAnswer":"Hej","evidence":[],"confidence":"low"}\n```');
    expect(parsed.value?.directAnswer).toBe('Hej');
  });

  it('parses JSON surrounded by prose', () => {
    const parsed = parseStructured('Sure! {"directAnswer":"Hej","evidence":[],"confidence":"low"} hope that helps');
    expect(parsed.value?.directAnswer).toBe('Hej');
  });

  it('returns null for non-JSON', () => {
    expect(parseStructured('just words').value).toBeNull();
  });

  it('enforceLength keeps full text in deeperExplanation', () => {
    const { display, trimmed } = enforceLength(
      { directAnswer: 'A. B. C. D.', evidence: [], confidence: 'low' },
      'QUICK',
    );
    expect(trimmed).toBe(true);
    expect(display.directAnswer).toBe('A. B.');
    expect(display.deeperExplanation).toContain('C. D.');
  });
});

describe('secret redaction', () => {
  it('redacts api keys and bearer tokens', () => {
    expect(redactSensitive('key sk-abcdefghijklmnop1234')).not.toContain('abcdefghijklmnop1234');
    expect(redactSensitive('Authorization: Bearer abcdefghijkl')).toContain('REDACTED');
    expect(redactSensitive('api_key = "supersecret123"')).toContain('REDACTED');
  });
});
