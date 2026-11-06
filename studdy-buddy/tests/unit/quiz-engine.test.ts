import { describe, it, expect } from 'vitest';
import {
  QUESTIONS,
  evaluateAnswer,
  selectQuestions,
  nextQuestion,
  targetDifficulty,
  normaliseAnswer,
  remediationPlan,
  sameConceptQuestion,
} from '@studdy/quiz-engine';

describe('question bank integrity', () => {
  it('every question has a unique id and an explanation and hint', () => {
    const ids = new Set<string>();
    for (const q of QUESTIONS) {
      expect(ids.has(q.id)).toBe(false);
      ids.add(q.id);
      expect(q.explanation.length).toBeGreaterThan(5);
      expect(q.hint.length).toBeGreaterThan(5);
      expect(q.onWrong.length).toBeGreaterThan(5);
    }
  });

  it('every choice question has exactly one correct option', () => {
    for (const q of QUESTIONS.filter((x) => x.options && x.kind !== 'TRUE_FALSE_REASONING')) {
      const correct = (q.options ?? []).filter((o) => o.correct);
      expect(correct.length, `question ${q.id}`).toBe(1);
    }
  });

  it('every free-text question declares accepted answers', () => {
    for (const q of QUESTIONS.filter((x) => ['SHORT_ANSWER', 'BINARY', 'SUBNETTING'].includes(x.kind))) {
      expect((q.accepted ?? []).length, `question ${q.id}`).toBeGreaterThan(0);
    }
  });

  it('every EXPLAIN_BACK question has a rubric', () => {
    for (const q of QUESTIONS.filter((x) => x.kind === 'EXPLAIN_BACK')) {
      expect((q.rubric ?? []).length).toBeGreaterThan(1);
    }
  });
});

describe('answer evaluation', () => {
  it('accepts the correct multiple-choice option', () => {
    const result = evaluateAnswer({ questionId: 'arp-1', selectedOptionIds: ['a'] });
    expect(result?.correct).toBe(true);
    expect(result?.independent).toBe(true);
  });

  it('explains the specific misconception behind a wrong option', () => {
    const result = evaluateAnswer({ questionId: 'arp-1', selectedOptionIds: ['b'] });
    expect(result?.correct).toBe(false);
    expect(result?.misconception).toMatch(/DNS/i);
  });

  it('accepts alternative binary formats', () => {
    expect(evaluateAnswer({ questionId: 'bin-1', freeText: '00001101' })?.correct).toBe(true);
    expect(evaluateAnswer({ questionId: 'bin-1', freeText: '1101' })?.correct).toBe(true);
    expect(evaluateAnswer({ questionId: 'bin-1', freeText: '1110' })?.correct).toBe(false);
  });

  it('normalises whitespace and case for CLI answers', () => {
    expect(normaliseAnswer('  IP  Route  0.0.0.0 0.0.0.0 192.168.1.1 ')).toBe('ip route 0.0.0.0 0.0.0.0 192.168.1.1');
    expect(evaluateAnswer({ questionId: 'route-2', freeText: 'IP ROUTE 0.0.0.0 0.0.0.0 192.168.1.1' })?.correct).toBe(true);
  });

  it('marks a hint-assisted correct answer as not independent', () => {
    const result = evaluateAnswer({ questionId: 'arp-1', selectedOptionIds: ['a'], hintsUsed: 2 });
    expect(result?.correct).toBe(true);
    expect(result?.independent).toBe(false);
  });

  it('passes EXPLAIN_BACK with two of three rubric points and flags lower grading confidence', () => {
    const pass = evaluateAnswer({ questionId: 'explain-1', rubricHits: 2 });
    expect(pass?.correct).toBe(true);
    expect(pass?.gradingConfidence).toBeLessThan(1);

    const fail = evaluateAnswer({ questionId: 'explain-1', rubricHits: 1 });
    expect(fail?.correct).toBe(false);
  });

  it('returns null for an unknown question instead of guessing', () => {
    expect(evaluateAnswer({ questionId: 'nope', selectedOptionIds: ['a'] })).toBeNull();
  });

  it('builds a remediation plan with misconception and hint', () => {
    const evaluation = evaluateAnswer({ questionId: 'arp-1', selectedOptionIds: ['b'] });
    const plan = remediationPlan(evaluation!, sameConceptQuestion('arp', 'arp-1')?.id ?? null);
    expect(plan.steps[0]).toMatch(/missuppfattning/i);
    expect(plan.steps.some((s) => s.startsWith('Tips:'))).toBe(true);
  });
});

describe('adaptive selection', () => {
  it('targets a difficulty near the student level', () => {
    expect(targetDifficulty(0.1)).toBe('BEGINNER');
    expect(targetDifficulty(0.6)).toBe('INTERMEDIATE');
    expect(targetDifficulty(0.95)).toBe('ADVANCED');
    expect(targetDifficulty(undefined)).toBe('FOUNDATION');
  });

  it('prefers the weakest practised concept', () => {
    const picked = selectQuestions({
      mastery: { arp: 0.9, subnetting: 0.2, dns: 0.75 },
      dueForReview: [],
      asked: ['subnet-1'],
      seed: 'test',
      limit: 1,
    });
    expect(picked[0]?.question.conceptId).toBe('subnetting');
    expect(picked[0]?.reason).toContain('svagt');
  });

  it('prioritises reviews that are due', () => {
    const picked = selectQuestions({
      mastery: { arp: 0.55, dns: 0.5 },
      dueForReview: ['dns'],
      seed: 'test',
      limit: 1,
    });
    expect(picked[0]?.question.conceptId).toBe('dns');
    expect(picked[0]?.reason).toContain('repetera');
  });

  it('boosts the concept the student is currently reading', () => {
    const withContext = selectQuestions({
      mastery: { vlan: 0.5, arp: 0.5, dns: 0.5 },
      dueForReview: [],
      currentConceptId: 'vlan',
      seed: 'ctx',
      limit: 1,
    });
    expect(withContext[0]?.question.conceptId).toBe('vlan');
  });

  it('never repeats a question already asked in the session', () => {
    const asked = QUESTIONS.slice(0, 5).map((q) => q.id);
    const picked = selectQuestions({ mastery: {}, dueForReview: [], asked, seed: 'x', limit: 3 });
    expect(picked.every((p) => !asked.includes(p.question.id))).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const input = { mastery: { arp: 0.4, dns: 0.4 }, dueForReview: [], seed: 'stable', limit: 3 };
    expect(selectQuestions(input).map((s) => s.question.id)).toEqual(selectQuestions(input).map((s) => s.question.id));
  });

  it('rotates to a different concept than the previous question', () => {
    const next = nextQuestion({
      mastery: { arp: 0.1 },
      dueForReview: [],
      lastConceptId: 'arp',
      seed: 'rotate',
    });
    expect(next?.question.conceptId).not.toBe('arp');
  });

  it('asks one question at a time by default', () => {
    const picked = selectQuestions({ mastery: {}, dueForReview: [] });
    expect(picked).toHaveLength(1);
  });
});
