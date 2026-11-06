import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '@studdy/database';
import { bktUpdate, DEFAULT_BKT, computeMastery, reviewIntervalDays } from '@studdy/learning-engine';
import { LearningService } from '@studdy/learning-engine';
import { prerequisiteClosure, weakPrerequisites } from '@studdy/learning-engine';

describe('BKT core', () => {
  it('raises probability on a correct answer and lowers it on a wrong one', () => {
    const prior = 0.3;
    const up = bktUpdate(prior, true, DEFAULT_BKT);
    const down = bktUpdate(prior, false, DEFAULT_BKT);
    expect(up).toBeGreaterThan(prior);
    expect(down).toBeLessThan(prior);
    expect(up).toBeLessThanOrEqual(1);
    expect(down).toBeGreaterThan(0);
  });

  it('weights a hard correctness more strongly than an easy one', () => {
    const prior = 0.4;
    const easy = bktUpdate(prior, true, { ...DEFAULT_BKT, pGuess: 0.45 });
    const hard = bktUpdate(prior, true, { ...DEFAULT_BKT, pGuess: 0.05 });
    expect(hard).toBeGreaterThan(easy);
  });

  it('gives longer review intervals to stronger knowledge', () => {
    expect(reviewIntervalDays(0.95, 6)).toBeGreaterThan(reviewIntervalDays(0.45, 1));
  });
});

describe('computeMastery', () => {
  it('does not grant mastery from reading exposure alone', () => {
    const result = computeMastery({
      conceptId: 'arp',
      evidence: [
        { conceptId: 'arp', kind: 'READING_EXPOSURE', difficulty: 1, hintsUsed: 0, source: 'NETACAD' },
        { conceptId: 'arp', kind: 'READING_EXPOSURE', difficulty: 1, hintsUsed: 0, source: 'NETACAD' },
      ],
    });
    expect(result.state).toBe('EXPOSED');
    expect(result.probability).toBeLessThan(0.3);
    expect(result.independentCorrect).toBe(0);
  });

  it('reduces credit when hints were used', () => {
    const independent = computeMastery({
      conceptId: 'subnetting',
      evidence: [{ conceptId: 'subnetting', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' }],
    });
    const hinted = computeMastery({
      conceptId: 'subnetting',
      evidence: [{ conceptId: 'subnetting', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 2, source: 'QUIZ_ENGINE' }],
    });
    expect(independent.probability).toBeGreaterThan(hinted.probability);
    expect(independent.independentCorrect).toBe(1);
    expect(hinted.independentCorrect).toBe(0);
  });

  it('reaches MASTERED only with repeated independent evidence', () => {
    const evidence = Array.from({ length: 6 }, () => ({
      conceptId: 'ipv4-addressing' as const,
      kind: 'QUIZ_CORRECT' as const,
      difficulty: 4 as const,
      hintsUsed: 0,
      source: 'QUIZ_ENGINE' as const,
    }));
    const result = computeMastery({ conceptId: 'ipv4-addressing', evidence });
    expect(result.state).toBe('MASTERED');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('confidence stays low with a single observation', () => {
    const result = computeMastery({
      conceptId: 'dns',
      evidence: [{ conceptId: 'dns', kind: 'QUIZ_CORRECT', difficulty: 2, hintsUsed: 0, source: 'QUIZ_ENGINE' }],
    });
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('concept graph', () => {
  it('finds transitive prerequisites for subnetting', () => {
    const closure = prerequisiteClosure('subnetting');
    expect(closure).toContain('subnet-mask');
    expect(closure).toContain('ipv4-addressing');
    expect(closure).toContain('binary');
  });

  it('diagnoses the weakest prerequisite first', () => {
    const weak = weakPrerequisites('subnetting', { binary: 0.2, 'ipv4-addressing': 0.85, 'subnet-mask': 0.5 });
    expect(weak[0]).toBe('binary');
    expect(weak).toContain('subnet-mask');
    expect(weak).not.toContain('ipv4-addressing');
  });
});

describe('LearningService', () => {
  let db: Database;
  let service: LearningService;
  beforeEach(() => {
    db = openDatabase(':memory:');
    service = new LearningService(db);
  });
  afterEach(() => db.close());

  it('records evidence and updates the stored estimate', () => {
    const before = service.estimate('arp');
    expect(before.state).toBe('NOT_SEEN');

    service.record({ conceptId: 'arp', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const after = service.estimate('arp');
    expect(after.probability).toBeGreaterThan(before.probability);
    expect(after.evidenceCount).toBe(1);
    expect(after.independentCorrect).toBe(1);
  });

  it('reports honest readiness without independent evidence', () => {
    const readiness = service.readiness({ trackedConceptIds: ['arp', 'subnetting'] });
    expect(readiness.evidenceStrength).toBe('none');
    expect(readiness.statements[0]).toMatch(/inga oberoende svar/);
  });

  it('names weak concepts in readiness once evidence exists', () => {
    service.record({ conceptId: 'subnetting', kind: 'QUIZ_INCORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    service.record({ conceptId: 'subnetting', kind: 'QUIZ_INCORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const readiness = service.readiness({ trackedConceptIds: ['subnetting', 'ospf'] });
    expect(readiness.evidenceStrength).toBe('thin');
    expect(readiness.weak).toContain('subnetting');
  });

  it('diagnoses gaps after repeated mistakes', () => {
    service.record({ conceptId: 'subnetting', kind: 'QUIZ_INCORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const gaps = service.diagnoseGap('subnetting');
    expect(gaps.map((g) => g.conceptId)).toContain('binary');
    expect(gaps[0]?.reason).toContain('Binära');
  });

  it('marks mastery as REVIEW_DUE when the interval has passed', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const svc = new LearningService(db, () => now);
    svc.record({ conceptId: 'mac-addressing', kind: 'QUIZ_CORRECT', difficulty: 4, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    svc.record({ conceptId: 'mac-addressing', kind: 'QUIZ_CORRECT', difficulty: 4, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    expect(svc.estimate('mac-addressing').state).not.toBe('REVIEW_DUE');

    now += 1000 * 60 * 60 * 24 * 40; // 40 days later
    const later = svc.estimate('mac-addressing');
    expect(later.state).toBe('REVIEW_DUE');
    expect(svc.dueReviews().map((r) => r.conceptId)).toContain('mac-addressing');
  });

  it('keeping mastery revisable: a later mistake lowers the estimate', () => {
    for (let i = 0; i < 5; i += 1) {
      service.record({ conceptId: 'vlan', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    }
    const high = service.estimate('vlan').probability;
    service.record({ conceptId: 'vlan', kind: 'QUIZ_INCORRECT', difficulty: 4, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const lower = service.estimate('vlan').probability;
    expect(lower).toBeLessThan(high);
  });

  it('persists evidence in the database (survives service restart)', () => {
    service.record({ conceptId: 'dhcp', kind: 'QUIZ_CORRECT', difficulty: 2, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const fresh = new LearningService(db);
    expect(fresh.estimate('dhcp').evidenceCount).toBe(1);
  });

  it('snapshot separates mastered / developing / unseen', () => {
    service.record({ conceptId: 'osi-model', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const snap = service.snapshot();
    expect(snap.totals.tracked).toBe(1);
    expect(snap.totals.notSeen).toBeGreaterThan(5);
  });
});
