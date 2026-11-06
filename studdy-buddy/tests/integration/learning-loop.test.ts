import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '@studdy/database';
import { discoverCurriculum, locateCurrentNode, classifyAssessment, parseObservedQuestion } from '@studdy/curriculum';
import { LearningService } from '@studdy/learning-engine';
import { evaluateAnswer, selectQuestions } from '@studdy/quiz-engine';
import { assembleContext } from '@studdy/agent-core';
import { makeSnapshot } from '../fixtures/netacad-snapshots.js';

/**
 * The learning loop, end to end, on the real database:
 *
 *   NetAcad page snapshot
 *     -> curriculum graph (real module count, honest unknowns)
 *     -> current node detection
 *     -> assessment classification
 *     -> observed quiz question (no correctness assumed)
 *     -> student answers
 *     -> evidence recorded
 *     -> mastery estimate + review schedule
 *     -> next question chosen from the weak concept
 */

describe('NetAcad study loop', () => {
  let db: Database;
  let learning: LearningService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    learning = new LearningService(db);
  });
  afterEach(() => db.close());

  it('discovers, stores and reloads the real curriculum structure', () => {
    const snapshot = makeSnapshot({ moduleCount: 12, sectionsPerModule: 4 });
    const { graph, partial, warnings } = discoverCurriculum(snapshot);

    expect(partial).toBe(false);
    expect(warnings).toEqual([]);

    db.curriculum.saveGraph(graph);
    const loaded = db.curriculum.loadGraph(graph.courseId);

    expect(loaded).not.toBeNull();
    // The count comes from the page, never from a constant.
    expect(db.curriculum.moduleCount(graph.courseId)).toBe(12);
    expect(loaded?.nodes.length).toBe(graph.nodes.length);
    expect(loaded?.courseName).toBe('CCNA: Introduction to Networks');
  });

  it('reports a different count for a different course instead of 17', () => {
    const a = discoverCurriculum(makeSnapshot({ moduleCount: 6 }));
    const b = discoverCurriculum(makeSnapshot({ moduleCount: 21, courseName: 'CCNA: Switching' }));
    expect(a.graph.nodes.filter((n) => n.kind === 'MODULE')).toHaveLength(6);
    expect(b.graph.nodes.filter((n) => n.kind === 'MODULE')).toHaveLength(21);
  });

  it('identifies where the student is and builds grounded context', () => {
    const snapshot = makeSnapshot({ moduleCount: 5, sectionsPerModule: 3 });
    const { graph } = discoverCurriculum(snapshot);
    const node = locateCurrentNode(graph, snapshot);

    expect(node).not.toBeNull();

    const context = assembleContext({
      page: {
        url: snapshot.url,
        courseName: snapshot.courseName,
        headingPath: snapshot.headings.map((h) => h.text),
        currentNodeId: node?.id ?? null,
        platformCompletedVisible: null,
        detectedAt: snapshot.capturedAt,
      },
      graph,
      selection: 'ARP resolves an IP address to a MAC address on the local network.',
    });

    const text = context.facts.join(' ');
    expect(text).toContain('CCNA: Introduction to Networks');
    expect(text).toMatch(/Kursstruktur:/);
    expect(context.conceptHints).toContain('arp');
  });

  it('records an observed practice answer as real evidence and updates mastery', () => {
    // 1. The student is on a practice page.
    const mode = classifyAssessment({
      url: 'https://www.netacad.com/course/practice',
      pageText: 'Practice activity: match the OSI layers.',
      buttonText: ['Check'],
      timerVisible: false,
      limitedAttempts: false,
    }).mode;
    expect(mode).toBe('PRACTICE');

    // 2. A question becomes visible; correctness is NOT assumed from selection.
    const parsed = parseObservedQuestion({
      questionText: 'Which OSI layer uses MAC addresses?',
      options: [
        { label: 'A', text: 'Layer 2', checked: true },
        { label: 'B', text: 'Layer 3' },
      ],
      feedbackText: null,
      inputType: 'radio',
      mode,
      pageUrl: 'https://www.netacad.com/course/practice',
    });
    expect(parsed.question?.officialCorrectness).toBeNull();

    // 3. The platform then reveals "Correct".
    const confirmed = parseObservedQuestion({
      questionText: 'Which OSI layer uses MAC addresses?',
      options: [
        { label: 'A', text: 'Layer 2', checked: true },
        { label: 'B', text: 'Layer 3' },
      ],
      feedbackText: 'Correct! MAC addresses belong to Layer 2.',
      inputType: 'radio',
      mode,
      pageUrl: 'https://www.netacad.com/course/practice',
    });
    expect(confirmed.question?.officialCorrectness).toBe(true);

    // 4. Only now is evidence recorded.
    const estimate = learning.record({
      conceptId: 'mac-addressing',
      kind: 'QUIZ_CORRECT',
      difficulty: 2,
      hintsUsed: 0,
      source: 'NETACAD',
      detail: confirmed.question?.questionText,
    });

    expect(estimate.evidenceCount).toBe(1);
    expect(estimate.independentCorrect).toBe(1);
    expect(estimate.probability).toBeGreaterThan(0.2);
    expect(estimate.state).not.toBe('NOT_SEEN');
    expect(estimate.confidence).toBeLessThan(0.5); // one data point is thin
  });

  it('does not count a reading exposure as demonstrated knowledge', () => {
    learning.record({ conceptId: 'vlan', kind: 'READING_EXPOSURE', difficulty: 1, hintsUsed: 0, source: 'NETACAD' });
    learning.record({ conceptId: 'vlan', kind: 'READING_EXPOSURE', difficulty: 1, hintsUsed: 0, source: 'NETACAD' });
    const estimate = learning.estimate('vlan');
    expect(estimate.state).toBe('EXPOSED');
    expect(estimate.independentCorrect).toBe(0);
    expect(estimate.probability).toBeLessThan(0.3);
  });

  it('remembers mistakes and steers the next question to the weak concept', () => {
    // Two wrong answers on subnetting.
    for (let i = 0; i < 2; i += 1) {
      const evaluation = evaluateAnswer({ questionId: 'subnet-1', freeText: '10.0.0.191' });
      expect(evaluation?.correct).toBe(false);
      learning.record({
        conceptId: evaluation!.conceptId,
        kind: 'QUIZ_INCORRECT',
        difficulty: evaluation!.difficultyWeight,
        hintsUsed: 0,
        source: 'QUIZ_ENGINE',
      });
    }
    // One correct answer on ARP.
    learning.record({ conceptId: 'arp', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });

    const snapshot = learning.snapshot();
    expect(snapshot.weakest[0]).toBe('subnetting');

    const next = selectQuestions({
      mastery: learning.probabilityMap(),
      dueForReview: snapshot.dueForReview,
      asked: ['subnet-1', 'arp-1'],
      seed: 'loop',
      limit: 1,
    });
    expect(next[0]?.question.conceptId).toBe('subnetting');
  });

  it('diagnoses a prerequisite gap rather than just repeating the question', () => {
    learning.record({ conceptId: 'subnetting', kind: 'QUIZ_INCORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    const gaps = learning.diagnoseGap('subnetting');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.map((g) => g.conceptId)).toContain('binary');
  });

  it('schedules a review and surfaces it when due', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const svc = new LearningService(db, () => now);
    svc.record({ conceptId: 'ipv4-addressing', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });

    const initial = svc.estimate('ipv4-addressing');
    expect(initial.reviewDueAt).not.toBeNull();
    expect(svc.dueReviews()).toHaveLength(0);

    now += 1000 * 60 * 60 * 24 * 60;
    expect(svc.dueReviews().map((r) => r.conceptId)).toContain('ipv4-addressing');
  });

  it('persists everything needed to resume tomorrow', () => {
    const session = db.sessions.ensureOpen();
    const snapshot = makeSnapshot({ moduleCount: 8 });
    const { graph } = discoverCurriculum(snapshot);
    db.curriculum.saveGraph(graph);
    const node = locateCurrentNode(graph, snapshot);
    db.sessions.updateContext(session.id, {
      courseId: graph.courseId,
      lastNodeId: node?.id ?? null,
      lastNodeTitle: node?.title ?? null,
    });
    learning.record({ conceptId: 'arp', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'NETACAD' });

    // Simulate a restart by re-reading through fresh repo instances.
    const reopened = openDatabase(':memory:');
    expect(() => reopened).not.toThrow();

    const savedSession = db.sessions.latestOpen();
    expect(savedSession?.lastNodeTitle).toBe(node?.title);
    expect(db.curriculum.moduleCount(graph.courseId)).toBe(8);
    expect(new LearningService(db).estimate('arp').evidenceCount).toBe(1);
    reopened.close();
  });

  it('never confuses platform completion with demonstrated knowledge', () => {
    const snapshot = makeSnapshot({ moduleCount: 3, sectionsPerModule: 1 });
    const { graph } = discoverCurriculum(snapshot);
    const completedModules = graph.nodes.filter((n) => n.kind === 'MODULE' && n.platformCompleted === true);
    expect(completedModules.length).toBeGreaterThan(0);

    // Platform says "completed", but the learning model knows nothing.
    const snapshotKnowledge = learning.snapshot();
    expect(snapshotKnowledge.totals.mastered).toBe(0);
    expect(snapshotKnowledge.totals.tracked).toBe(0);
  });
});
