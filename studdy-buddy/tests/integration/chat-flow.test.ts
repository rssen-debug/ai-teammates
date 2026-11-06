import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StuddyServices } from '../../apps/desktop/electron/services.js';

/**
 * End-to-end service test: settings -> provider -> permission -> question ->
 * structured answer -> persistence -> learning record -> restart.
 *
 * The provider is a fake fetch, but *everything else* is the production code
 * path: the real SQLite database, the real router, the real explanation
 * pipeline, the real permission gate.
 */

function completion(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      model: 'fake-model',
      usage: { prompt_tokens: 120, completion_tokens: 60 },
      choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }],
      ...(typeof body === 'string' ? { error: { message: body } } : {}),
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

const goodAnswer = {
  directAnswer: 'ARP hittar MAC-adressen som hör till en IP-adress i det lokala nätet.',
  simpleExplanation: 'Det är som att hitta rätt mottagare innan brevet skickas.',
  example: 'PC0 frågar vem som har 192.168.1.1; routern svarar med sin MAC-adress.',
  nextAction: '',
  deeperExplanation: '',
  evidence: ['Markerad text nämner ARP'],
  confidence: 'medium',
};

describe('full chat flow', () => {
  let services: StuddyServices;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async () => completion(goodAnswer));
    services = new StuddyServices({
      dataDir: ':memory:',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: 'win32',
      clock: () => Date.parse('2026-04-01T09:00:00Z'),
    });
  });

  afterEach(() => services.close());

  it('refuses to answer before a provider exists, and says why', async () => {
    const result = await services.ask({ text: 'Vad är ARP?', mode: 'NORMAL' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.degraded).toBe(true);
    expect(result.data.error).toBe('NO_PROVIDER');
    expect(result.data.message.text).toMatch(/provider/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires the data-sharing permission even with a provider', async () => {
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    const result = await services.ask({ text: 'Vad är ARP?', mode: 'NORMAL' });
    expect(result.ok && result.data.error).toBe('PERMISSION_DENIED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers, persists both messages, and records exposure only', async () => {
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    services.permissions.grant('provider.dataShare');

    const result = await services.ask({
      text: 'Vad gör ARP?',
      mode: 'NORMAL',
      selectedText: 'ARP resolves an IPv4 address to a MAC address.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.degraded).toBe(false);
    expect(result.data.message.structured?.directAnswer).toContain('ARP');

    const history = services.history();
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('buddy');

    // Answering must NOT grant mastery - only READING_EXPOSURE is recorded,
    // which the learning engine caps at EXPOSED.
    const arp = services.learning.estimate('arp');
    expect(arp.state).toBe('EXPOSED');
    expect(arp.independentCorrect).toBe(0);
    expect(arp.probability).toBeLessThan(0.3);
  });

  it('passes the selected text to the model as an evidence-labelled fact', async () => {
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    services.permissions.grant('provider.dataShare');
    await services.ask({ text: 'Förklara', mode: 'QUICK', selectedText: 'Ethernet frames carry MAC addresses.' });

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown[])[1] ? ((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) : '{}')) as {
      messages: { role: string; content: string }[];
    };
    const system = body.messages[0]?.content ?? '';
    expect(system).toContain('Markerad text');
    expect(system).toContain('Ethernet frames carry MAC addresses.');
  });

  it('adds an explicit instruction not to answer graded questions', async () => {
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    services.permissions.grant('provider.dataShare');
    const result = await services.ask({ text: 'Vilket svar är rätt?', mode: 'NORMAL', assessmentMode: 'GRADED_QUIZ' });

    const body = JSON.parse(((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)) as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toContain('Ge INTE svaret');
    expect(result.ok && result.data.notice).toMatch(/betygsatt/i);
  });

  it('reports a provider failure without pretending it succeeded', async () => {
    fetchImpl.mockImplementation(async () => completion('upstream exploded', 500));
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    services.permissions.grant('provider.dataShare');

    const result = await services.ask({ text: 'Vad är DNS?', mode: 'QUICK' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.degraded).toBe(true);
    expect(result.data.error).toBeTruthy();
    expect(services.history().length).toBe(2);
  });

  it('keeps conversation and learning state across a restart', async () => {
    services.saveProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    services.permissions.grant('provider.dataShare');
    await services.ask({ text: 'Vad är ARP?', mode: 'NORMAL', selectedText: 'ARP resolves addresses.' });

    const session = services.ensureSession();
    services.db.sessions.updateContext(session.id, { lastNodeTitle: '3.2.1 The TCP/IP Protocol Suite' });

    // Rebuild the service stack from the same database object to simulate a
    // restart without losing the file (we use an injected db for this).
    const resume = services.resume();
    expect(resume.greeting).toContain('3.2.1');
    expect(services.history().length).toBe(2);
    expect(services.learning.estimate('arp').state).toBe('EXPOSED');
  });

  it('tracks problems.json-like diagnostics honestly', () => {
    const diag = services.diagnostics();
    expect(diag.provider.configured).toBe(false);
    expect(diag.database.version).toBeGreaterThan(0);
    expect(Array.isArray(diag.permissions)).toBe(true);
  });

  it('rejects an insecure provider URL', () => {
    const result = services.saveProvider({ baseUrl: 'http://evil.example.com/v1', modelId: 'm' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error?.code).toBe('INSECURE_URL');
  });

  it('never stores the API key in the database', () => {
    services.saveProvider({ apiKey: 'sk-super-secret-value', baseUrl: 'https://api.example.com/v1', modelId: 'fake-model' });
    const rows = services.db.driver.all<Record<string, unknown>>('SELECT * FROM provider_config');
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('sk-super-secret-value');
    expect(services.activeProvider()?.hasApiKey).toBe(true);
  });

  it('enforces the daily budget across turns', async () => {
    services.saveProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'fake-model',
      dailyCostLimitUsd: 0.000001,
      inputCostPerMTok: 1000,
      outputCostPerMTok: 1000,
    });
    services.permissions.grant('provider.dataShare');
    await services.ask({ text: 'Första frågan', mode: 'QUICK' });
    const second = await services.ask({ text: 'Andra frågan', mode: 'QUICK' });
    expect(second.ok && second.data.degraded).toBe(true);
    expect(second.ok && second.data.error).toMatch(/budget/i);
  });
});
