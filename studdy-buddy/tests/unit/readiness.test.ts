import { describe, it, expect } from 'vitest';
import { computeReadiness, curriculumUnits, type ReadinessConcept } from '@studdy/learning-engine';
import type { CurriculumGraph } from '@studdy/shared';

/**
 * The 0-100 scale is the one number a student will actually look at, so it is the
 * one number that must not be able to lie. These tests pin down three things:
 *
 *  1. nothing is reported as measurable when nothing has been measured
 *  2. reading cannot move the number; only answered questions can
 *  3. the number always ships with its derivation and its limits
 */

function concept(over: Partial<ReadinessConcept> & { conceptId: string }): ReadinessConcept {
  return {
    label: over.conceptId,
    probability: 0,
    state: 'NOT_SEEN',
    confidence: 0,
    independentCorrect: 0,
    reviewDueAt: null,
    overdue: false,
    ...over,
  };
}

const GRAPH: CurriculumGraph = {
  courseId: 'course:ccna',
  courseName: 'CCNA ITN',
  sourceUrl: 'https://www.netacad.com/course',
  discoveredAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    { id: 'c', kind: 'COURSE', title: 'CCNA ITN', order: 1, url: null, parentId: null, platformCompleted: null, inaccessible: false },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      kind: 'MODULE' as const,
      title: `Modul ${i + 1}`,
      order: i + 1,
      url: null,
      parentId: 'c',
      platformCompleted: i < 3,
      inaccessible: false,
    })),
    { id: 'q', kind: 'QUIZ', title: 'Quiz 1', order: 11, url: null, parentId: 'c', platformCompleted: null, inaccessible: false },
  ],
};

describe('readiness with no evidence', () => {
  it('reports no score at all instead of a fake zero', () => {
    const result = computeReadiness({ concepts: [concept({ conceptId: 'arp' })], graph: GRAPH });
    expect(result.score).toBeNull();
    expect(result.confidence).toBe('ingen');
    expect(result.headline).toMatch(/Ingen beredskap kan mätas/);
    expect(result.limitations.join(' ')).toMatch(/Ingen kunskap är registrerad/);
  });

  it('says plainly that it cannot be measured, in the empty-course case too', () => {
    const result = computeReadiness({ concepts: [], graph: null });
    expect(result.score).toBeNull();
    expect(result.parts.coverage.total).toBe(1);
  });
});

describe('reading is not knowledge', () => {
  it('does not produce a score from READING_EXPOSURE alone', () => {
    const result = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'EXPOSED', probability: 0.2, confidence: 0.1, independentCorrect: 0 }),
        concept({ conceptId: 'vlan', state: 'EXPOSED', probability: 0.2, confidence: 0.1, independentCorrect: 0 }),
      ],
      graph: GRAPH,
    });
    // Coverage may rise (the student did work with it) but mastery stays at zero
    // and the app says why the number is not meaningful yet.
    expect(result.parts.mastery.value).toBe(0);
    expect(result.parts.mastery.demonstrated).toBe(0);
    expect(result.limitations.join(' ')).toMatch(/läsning räknas inte som kunskap/);
    expect(result.parts.retention.value).toBe(0);
  });

  it('scores strictly higher once the same concepts have real answers', () => {
    const readingOnly = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'EXPOSED', probability: 0.2, confidence: 0.1 }),
        concept({ conceptId: 'vlan', state: 'EXPOSED', probability: 0.2, confidence: 0.1 }),
      ],
      graph: GRAPH,
    });
    const answered = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'DEMONSTRATED', probability: 0.8, confidence: 0.7, independentCorrect: 3 }),
        concept({ conceptId: 'vlan', state: 'DEMONSTRATED', probability: 0.75, confidence: 0.6, independentCorrect: 2 }),
      ],
      graph: GRAPH,
    });
    expect(answered.score! > readingOnly.score!).toBe(true);
    expect(answered.parts.mastery.value).toBeGreaterThan(readingOnly.parts.mastery.value);
  });
});

describe('the scale itself', () => {
  it('stays within 0-100 and weights the three parts as documented', () => {
    const result = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'MASTERED', probability: 0.95, confidence: 0.9, independentCorrect: 5 }),
        concept({ conceptId: 'vlan', state: 'DEVELOPING', probability: 0.5, confidence: 0.4, independentCorrect: 1 }),
      ],
      graph: GRAPH,
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(100);
    expect(result.parts.coverage.weight + result.parts.mastery.weight + result.parts.retention.weight).toBe(100);
  });

  it('cannot reach 100 just by having touched everything', () => {
    const touchedEverything = computeReadiness({
      concepts: GRAPH.nodes.slice(0, 10).map((n) =>
        concept({ conceptId: n.id, label: n.title, state: 'EXPOSED', probability: 0.2, confidence: 0.1 }),
      ),
      graph: GRAPH,
    });
    expect(touchedEverything.score!).toBeLessThan(50);
  });

  it('drops when reviews go overdue, and says so', () => {
    const fresh = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'DEMONSTRATED', probability: 0.8, confidence: 0.7, independentCorrect: 3, reviewDueAt: '2026-06-01T00:00:00.000Z' }),
      ],
      graph: GRAPH,
      now: new Date('2026-05-01T00:00:00.000Z'),
    });
    const overdue = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'DEMONSTRATED', probability: 0.8, confidence: 0.7, independentCorrect: 3, reviewDueAt: '2026-06-01T00:00:00.000Z', overdue: true }),
      ],
      graph: GRAPH,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(overdue.parts.retention.value).toBeLessThan(fresh.parts.retention.value);
    expect(overdue.limitations.join(' ')).toMatch(/dags att repetera/);
  });

  it('never claims certainty from a single answer', () => {
    const oneAnswer = computeReadiness({
      concepts: [concept({ conceptId: 'arp', state: 'PRACTICING', probability: 0.6, confidence: 0.2, independentCorrect: 1 })],
      graph: GRAPH,
    });
    expect(oneAnswer.confidence).toBe('tunn');
    expect(oneAnswer.limitations.join(' ')).toMatch(/Underlaget är tunt/);
  });

  it('reports coverage against the course, not against the concepts it happens to track', () => {
    const result = computeReadiness({
      concepts: [concept({ conceptId: 'arp', state: 'DEMONSTRATED', label: 'Modul 1', probability: 0.8, confidence: 0.7, independentCorrect: 3 })],
      graph: GRAPH,
    });
    expect(result.parts.coverage.total).toBe(curriculumUnits(GRAPH).length);
    expect(result.parts.coverage.detail).toMatch(/delar i kursen/);
  });

  it('flags unreadable course parts as a limitation rather than ignoring them', () => {
    const partial: CurriculumGraph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === 'm5' ? { ...n, inaccessible: true } : n)),
    };
    const result = computeReadiness({
      concepts: [concept({ conceptId: 'arp', state: 'DEMONSTRATED', probability: 0.8, confidence: 0.7, independentCorrect: 3 })],
      graph: partial,
    });
    expect(result.limitations.join(' ')).toMatch(/kunde inte läsas/);
  });
});

describe('what the student sees alongside the number', () => {
  it('always returns the derivation, the limits and concrete next steps', () => {
    const result = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', state: 'MASTERED', probability: 0.9, confidence: 0.8, independentCorrect: 4 }),
        concept({ conceptId: 'subnetting', state: 'PRACTICING', probability: 0.3, confidence: 0.3, independentCorrect: 1 }),
      ],
      graph: GRAPH,
    });
    expect(result.parts.coverage.detail).toBeTruthy();
    expect(result.parts.mastery.detail).toBeTruthy();
    expect(result.parts.retention.detail).toBeTruthy();
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.nextSteps[0]?.conceptId).toBe('subnetting');
    expect(result.strong.map((s) => s.conceptId)).toContain('arp');
  });

  it('never promises a pass', () => {
    const result = computeReadiness({
      concepts: GRAPH.nodes.slice(0, 10).map((n) =>
        concept({ conceptId: n.id, label: n.title, state: 'MASTERED', probability: 0.97, confidence: 0.95, independentCorrect: 8 }),
      ),
      graph: GRAPH,
    });
    expect(result.headline).toMatch(/uppskattning/);
    expect(result.headline.toLowerCase()).not.toMatch(/klarat|garanti att du/);
  });
});
