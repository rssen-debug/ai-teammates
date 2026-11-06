import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StuddyServices } from '../../apps/desktop/electron/services.js';
import { extractConcepts, stem, tokenize } from '@studdy/learning-engine';
import { toHistoryMessages, MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, buildSystemPrompt } from '@studdy/ai-router';
import type { SourcePage } from '@studdy/shared';

/**
 * These tests answer three product questions with executable proof:
 *
 *  1. Does it work for a subject other than networking? (Canvas biology here.)
 *  2. Does the model actually receive memory: transcript + observed page +
 *     recorded progress?
 *  3. Does the app's own record stay honest - exposure is not mastery?
 */

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function services(dataDir: string, fetchImpl?: typeof fetch): StuddyServices {
  return new StuddyServices({ dataDir, fetchImpl, platform: 'win32' });
}

/** A fetched-shaped fake provider that records exactly what was sent. */
function recordingProvider(reply = JSON.stringify({ directAnswer: 'Svar.', evidence: [], confidence: 'low' })) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const CANVAS_PAGE: SourcePage = {
  url: 'https://canvas.instructure.com/courses/42/pages/meiosis',
  title: 'Meiosis – Biologi 1',
  courseName: 'Biologi 1',
  siteName: 'Canvas',
  headingPath: ['Biologi 1', 'Cellbiologi', 'Meiosis'],
  currentNodeId: null,
  platformCompletedVisible: null,
  detectedAt: new Date().toISOString(),
};

const CANVAS_SNAPSHOT = {
  url: 'https://canvas.instructure.com/courses/42/pages/meiosis',
  title: 'Meiosis – Biologi 1',
  courseName: 'Biologi 1',
  headings: [
    { level: 1, text: 'Biologi 1' },
    { level: 2, text: 'Cellbiologi' },
    { level: 3, text: 'Meiosis' },
  ],
  navLinks: [
    { text: 'Modul 1: Cellen', href: null, depth: 1, completed: true },
    { text: 'Modul 2: Mitos', href: null, depth: 1, completed: true },
    { text: 'Modul 3: Meiosis', href: null, depth: 1, completed: null },
    { text: 'Modul 4: Genetik', href: null, depth: 1, completed: null },
    { text: 'Quiz: Cellbiologi', href: null, depth: 1, completed: null },
  ],
  contentInIframe: false,
  capturedAt: new Date().toISOString(),
};

describe('generic topic extraction', () => {
  it('extracts topics from arbitrary text without any subject-specific list', () => {
    const concepts = extractConcepts('Meiosis Mitos Kromosomer Meiosis cellandning Diffusion osmos');
    const ids = concepts.map((c) => c.id);
    expect(ids.every((id) => id.startsWith('dyn:'))).toBe(true);
    // Most repeated topic comes first.
    expect(concepts[0]?.label.toLowerCase()).toBe('meiosis');
  });

  it('is deterministic and stable across calls', () => {
    const a = extractConcepts('Subnetting och CIDR med subnet mask');
    const b = extractConcepts('Subnetting och CIDR med subnet mask');
    expect(a).toEqual(b);
  });

  it('groups simple plural and definite forms via the stemmer', () => {
    expect(stem('kromosomerna')).toContain('kromosom');
    const concepts = extractConcepts('kromosom kromosomer kromosomerna', 5);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]?.weight).toBe(3);
  });

  it('drops stopwords and numbers from both Swedish and English', () => {
    const tokens = tokenize('det är och the and for 123 4 5 cellule');
    expect(tokens).not.toContain('det');
    expect(tokens).not.toContain('the');
    expect(tokens.some((t) => /^\d+$/.test(t))).toBe(false);
    expect(tokens).toContain('cellule');
  });
});

describe('a non-networking course works end to end', () => {
  it('discovers a Canvas course, registers its topics, and grounds the next answer in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-any-'));
    const provider = recordingProvider();
    const svc = services(dir, provider.impl);
    try {
      svc.saveProvider({
        id: 'p',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-flash',
        apiKey: 'sk-test-key',
        visionModelId: null,
        fallbackModelId: null,
        reasoning: 'auto',
        maxTokensPerRequest: 512,
        dailyCostLimitUsd: 5,
        inputCostPerMTok: 0.14,
        outputCostPerMTok: 0.28,
      });
      svc.permissions.grant('provider.dataShare');
      svc.permissions.grant('browser.read');

      const observed = svc.observePage(CANVAS_SNAPSHOT, CANVAS_PAGE);
      expect(observed.graph.nodes.length).toBeGreaterThan(0);
      // Module count is whatever the page showed. The nav has four "Modul N"
      // items; the heading "Cellbiologi" is also classified as a MODULE, and we
      // assert that too instead of hiding it - the count is a page fact.
      const moduleTitles = observed.graph.nodes.filter((n) => n.kind === 'MODULE').map((n) => n.title);
      expect(moduleTitles).toContain('Modul 1: Cellen');
      expect(moduleTitles).toContain('Modul 4: Genetik');
      expect(moduleTitles).toContain('Cellbiologi');
      expect(observed.graph.nodes.filter((n) => n.kind === 'QUIZ').map((n) => n.title)).toContain('Quiz: Cellbiologi');
      expect(observed.newTopics).toBeGreaterThan(0);

      // The topic list must contain biology vocabulary, not networking.
      const snapshot = svc.progress();
      const labels = (snapshot.concepts as { conceptId: string; label: string }[])
        .filter((c) => c.conceptId.startsWith('dyn:'))
        .map((c) => c.label.toLowerCase());
      expect(labels.some((l) => l.includes('meiosis'))).toBe(true);

      const result = await svc.ask({ text: 'Vad är skillnaden mellan mitos och meiosis?', mode: 'NORMAL' });
      expect(result.ok).toBe(true);

      const body = provider.calls.at(-1)?.body ?? '';
      // The prompt carries the observed page and course, not a Cisco template.
      expect(body).toContain('canvas.instructure.com');
      expect(body).toContain('Biologi 1');
      expect(body).not.toContain('Cisco networking course');
      expect(body).not.toContain('DVA120');
    } finally {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the platform completion flag honest: 2 completed of 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-any-'));
    const svc = services(dir);
    try {
      svc.observePage(CANVAS_SNAPSHOT, CANVAS_PAGE);
      const graph = svc.currentObservation().graph;
      expect(graph).not.toBeNull();
      const withFlag = graph?.nodes.filter((n) => n.platformCompleted !== null) ?? [];
      expect(withFlag.filter((n) => n.platformCompleted === true)).toHaveLength(2);
      // Completion never becomes mastery.
      expect(svc.progress().totals.mastered).toBe(0);
    } finally {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the model receives real memory', () => {
  it('sends previous turns so a follow-up question has context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-any-'));
    const provider = recordingProvider();
    const svc = services(dir, provider.impl);
    try {
      svc.saveProvider({
        id: 'p',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-flash',
        apiKey: 'sk-test-key',
        visionModelId: null,
        fallbackModelId: null,
        reasoning: 'auto',
        maxTokensPerRequest: 512,
        dailyCostLimitUsd: 5,
        inputCostPerMTok: 0.14,
        outputCostPerMTok: 0.28,
      });
      svc.permissions.grant('provider.dataShare');

      await svc.ask({ text: 'Vad är en kromosom?', mode: 'QUICK' });
      await svc.ask({ text: 'Och vad menas med homologa kromosomer?', mode: 'QUICK' });

      const firstBody = provider.calls[0]?.body ?? '';
      const secondBody = provider.calls[1]?.body ?? '';

      // First call: the question is sent exactly once, and there is no answer
      // turn yet because nothing has been answered before.
      expect(countOccurrences(firstBody, '"role":"user","content":"Vad är en kromosom?"')).toBe(1);
      expect(firstBody).not.toContain('"role":"assistant"');

      // Second call: the previous question AND the previous answer are present,
      // so the follow-up ("och ...") is interpretable.
      expect(secondBody).toContain('Vad är en kromosom?');
      expect(secondBody).toContain('"role":"assistant","content":"Svar."');
      expect(secondBody).toContain('Och vad menas med homologa kromosomer?');
      // And the new question is still only sent once.
      expect(countOccurrences(secondBody, '"content":"Och vad menas med homologa kromosomer?"')).toBe(1);
    } finally {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends the recorded progress, and says plainly when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-any-'));
    const provider = recordingProvider();
    const svc = services(dir, provider.impl);
    try {
      svc.saveProvider({
        id: 'p',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-flash',
        apiKey: 'sk-test-key',
        visionModelId: null,
        fallbackModelId: null,
        reasoning: 'auto',
        maxTokensPerRequest: 512,
        dailyCostLimitUsd: 5,
        inputCostPerMTok: 0.14,
        outputCostPerMTok: 0.28,
      });
      svc.permissions.grant('provider.dataShare');

      await svc.ask({ text: 'Första frågan', mode: 'QUICK' });
      expect(provider.calls[0]?.body ?? '').toMatch(/Ingen kunskap är registrerad ännu/);

      // Now real evidence exists.
      svc.recordEvidence({ conceptId: 'subnetting', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
      await svc.ask({ text: 'Andra frågan', mode: 'QUICK' });
      const body = provider.calls.at(-1)?.body ?? '';
      expect(body).toContain('Subnetting');
      expect(body).toMatch(/oberoende rätt/);
    } finally {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory budgets', () => {
  it('drops the oldest turns instead of sending the whole transcript', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `t${i}`,
    }));
    const messages = toHistoryMessages(history);
    const conversation = messages.filter((m) => m.role !== 'system');
    expect(conversation.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS);
    // The newest turn survives, the oldest does not.
    expect(JSON.stringify(messages)).toContain('t29');
    expect(JSON.stringify(messages)).not.toContain('"t0"');
  });

  it('marks truncated memory explicitly so the model does not pretend to remember', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, text: 'x'.repeat(500) + i }));
    const messages = toHistoryMessages(history);
    const marker = messages.find((m) => m.role === 'system');
    expect(marker?.content).toMatch(/dropped for length/);
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThan(MAX_HISTORY_CHARS + 400);
  });

  it('returns no messages at all for an empty history', () => {
    expect(toHistoryMessages(undefined)).toEqual([]);
    expect(toHistoryMessages([])).toEqual([]);
  });
});

describe('prompt construction is subject-agnostic', () => {
  it('uses the observed subject and position instead of a hardcoded course', () => {
    const prompt = buildSystemPrompt({
      mode: 'NORMAL',
      language: 'sv-SE',
      contextBlock: '- Canvas-sida',
      knowledgeBlock: '- Meiosis: svag',
      study: { subjectLine: 'Biologi 1', positionLine: 'Biologi 1 > Cellbiologi > Meiosis' },
    });
    expect(prompt).toContain('Biologi 1');
    expect(prompt).toContain('Cellbiologi > Meiosis');
    expect(prompt).not.toMatch(/DVA120|Packet Tracer|CCNA/);
  });

  it('tells the model to ask rather than assume when nothing is known', () => {
    const prompt = buildSystemPrompt({ mode: 'NORMAL', language: 'sv-SE', contextBlock: '', knowledgeBlock: '' });
    expect(prompt).toMatch(/not yet established/);
    expect(prompt).toMatch(/do not assume prior knowledge/);
  });
});
