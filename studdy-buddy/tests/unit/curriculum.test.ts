import { describe, it, expect } from 'vitest';
import {
  discoverCurriculum,
  locateCurrentNode,
  ancestorTitles,
  classifyLabel,
  numericPath,
  classifyAssessment,
  assistancePolicy,
  parseObservedQuestion,
} from '@studdy/curriculum';
import { makeSnapshot } from '../fixtures/netacad-snapshots.js';

describe('curriculum discovery', () => {
  it('reports the real module count instead of a hardcoded 17', () => {
    const nine = discoverCurriculum(makeSnapshot({ moduleCount: 9 }));
    expect(nine.graph.nodes.filter((n) => n.kind === 'MODULE')).toHaveLength(9);

    const seventeen = discoverCurriculum(makeSnapshot({ moduleCount: 17 }));
    expect(seventeen.graph.nodes.filter((n) => n.kind === 'MODULE')).toHaveLength(17);
  });

  it('builds a proper hierarchy from numeric paths', () => {
    const { graph } = discoverCurriculum(makeSnapshot({ moduleCount: 2, sectionsPerModule: 2 }));
    const module1 = graph.nodes.find((n) => n.title.startsWith('Module 1:'));
    const module2 = graph.nodes.find((n) => n.title.startsWith('Module 2:'));
    expect(module1).toBeDefined();
    expect(module2).toBeDefined();

    // Numeric paths decide parenting: "1.1" belongs to module 1, "2.1" to module 2,
    // regardless of the order they appear in the sidebar.
    const section11 = graph.nodes.find((n) => n.title.startsWith('1.1 Section'));
    const section21 = graph.nodes.find((n) => n.title.startsWith('2.1 Section'));
    expect(section11?.parentId).toBe(module1?.id);
    expect(section21?.parentId).toBe(module2?.id);

    // And a lesson sits under its section, not under the module.
    const lesson111 = graph.nodes.find((n) => n.title.startsWith('1.1.1 Lesson'));
    expect(lesson111?.parentId).toBe(section11?.id);
  });

  it('classifies quizzes and labs distinctly from lessons', () => {
    const { graph } = discoverCurriculum(makeSnapshot({ moduleCount: 1, sectionsPerModule: 1 }));
    expect(graph.nodes.some((n) => n.kind === 'QUIZ')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'LAB')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'LESSON')).toBe(true);
  });

  it('keeps completion null when the platform did not report it', () => {
    const { graph } = discoverCurriculum(makeSnapshot({ moduleCount: 3, sectionsPerModule: 1 }));
    const m1 = graph.nodes.find((n) => n.title.startsWith('Module 1:'));
    const m3 = graph.nodes.find((n) => n.title.startsWith('Module 3:'));
    // Fixture: modules 1-2 are reported complete by "the platform", module 3 is not.
    expect(m1?.platformCompleted).toBe(true);
    expect(m3?.platformCompleted).toBeNull();
  });

  it('warns instead of inventing content when the body is an unreadable iframe', () => {
    const result = discoverCurriculum(makeSnapshot({ moduleCount: 4, iframe: true }));
    expect(result.partial).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/iframe/i);
    // Structurally visible nav is still discovered.
    expect(result.graph.nodes.filter((n) => n.kind === 'MODULE')).toHaveLength(4);
  });

  it('produces ids that are stable across repeated discovery', () => {
    const a = discoverCurriculum(makeSnapshot({ moduleCount: 5 }));
    const b = discoverCurriculum(makeSnapshot({ moduleCount: 5 }));
    expect(a.graph.courseId).toBe(b.graph.courseId);
    expect(a.graph.nodes.map((n) => n.id)).toEqual(b.graph.nodes.map((n) => n.id));
  });

  it('does not collide two modules with identical titles in different chapters', () => {
    const snap = makeSnapshot({ moduleCount: 2, sectionsPerModule: 1 });
    // Give two sections the same title text but different numeric paths.
    snap.navLinks = [
      { text: 'Module 1: A', href: '/m1', depth: 1 },
      { text: '1.1 Overview', href: '/m1/1-1', depth: 2 },
      { text: 'Module 2: B', href: '/m2', depth: 1 },
      { text: '2.1 Overview', href: '/m2/2-1', depth: 2 },
    ];
    const { graph } = discoverCurriculum(snap);
    const overviews = graph.nodes.filter((n) => n.title.includes('Overview'));
    expect(overviews).toHaveLength(2);
    expect(new Set(overviews.map((n) => n.id)).size).toBe(2);
  });

  it('finds the deepest current node from page headings', () => {
    const { graph } = discoverCurriculum(makeSnapshot({ moduleCount: 4, sectionsPerModule: 3 }));
    const node = locateCurrentNode(graph, makeSnapshot({ moduleCount: 4, sectionsPerModule: 3 }));
    expect(node).not.toBeNull();
    expect(node?.title).toMatch(/3\.2/);
  });

  it('returns ancestor titles outermost-first', () => {
    const { graph } = discoverCurriculum(makeSnapshot({ moduleCount: 3, sectionsPerModule: 2 }));
    const lesson = graph.nodes.find((n) => n.title.startsWith('2.1.1'));
    expect(lesson).toBeDefined();
    const titles = ancestorTitles(graph, lesson?.id ?? '');
    expect(titles[0]).toMatch(/Module 1:/);
    expect(titles[titles.length - 1]).toMatch(/2\.1/);
  });

  it('labels a plain lesson correctly and extracts its numeric path', () => {
    expect(classifyLabel('5.3.2 Configure VLANs')).toBe('SECTION');
    expect(classifyLabel('Module 4 Quiz')).toBe('QUIZ');
    expect(classifyLabel('Lab: Packet Tracer basics')).toBe('LAB');
    expect(numericPath('12.4.1 Something')).toBe('12.4.1');
    expect(numericPath('No number')).toBeNull();
  });
});

describe('assessment classification', () => {
  const base = { url: 'https://netacad.com/x', pageText: 'read this', buttonText: [] as string[], timerVisible: false, limitedAttempts: false };

  it('treats a timed, limited-attempt page as graded', () => {
    expect(classifyAssessment({ ...base, timerVisible: true, limitedAttempts: true }).mode).toBe('GRADED_QUIZ');
  });

  it('recognises formal exams conservatively', () => {
    expect(classifyAssessment({ ...base, pageText: 'Final Exam' }).mode).toBe('FORMAL_EXAM');
  });

  it('treats practice pages as practice', () => {
    expect(classifyAssessment({ ...base, pageText: 'Practice activity: build a network' }).mode).toBe('PRACTICE');
  });

  it('defaults to self study when there are no assessment signals', () => {
    expect(classifyAssessment({ ...base, pageText: 'Chapter 2 explains Ethernet.' }).mode).toBe('SELF_STUDY');
  });

  it('blocks answer-giving during graded work but still allows concept help', () => {
    const policy = assistancePolicy('GRADED_QUIZ');
    expect(policy.maySuggestAnswer).toBe(false);
    expect(policy.mayExplainConcept).toBe(true);
    expect(policy.notice).toMatch(/betygsatt/i);
    expect(assistancePolicy('SELF_STUDY').maySuggestAnswer).toBe(true);
  });
});

describe('quiz observation', () => {
  const base = {
    questionText: 'Which OSI layer uses MAC addresses?',
    options: [
      { label: 'A', text: 'Layer 2' },
      { label: 'B', text: 'Layer 3' },
    ],
    inputType: 'radio' as const,
    mode: 'PRACTICE' as const,
    pageUrl: 'https://netacad.com/quiz/1',
  };

  it('does NOT treat a selected answer as correct on its own', () => {
    const parsed = parseObservedQuestion({
      ...base,
      options: [
        { label: 'A', text: 'Layer 2', checked: true },
        { label: 'B', text: 'Layer 3' },
      ],
      feedbackText: null,
    });
    expect(parsed.question?.selected).toEqual(['A']);
    expect(parsed.question?.officialCorrectness).toBeNull();
  });

  it('reads explicit correct feedback', () => {
    const parsed = parseObservedQuestion({ ...base, feedbackText: 'Correct! Layer 2 uses MAC addresses.' });
    expect(parsed.question?.officialCorrectness).toBe(true);
    expect(parsed.feedback.visible).toBe(true);
  });

  it('reads explicit incorrect feedback', () => {
    const parsed = parseObservedQuestion({ ...base, feedbackText: 'Incorrect. The correct answer is Layer 2.' });
    expect(parsed.question?.officialCorrectness).toBe(false);
  });

  it('detects retry availability', () => {
    const parsed = parseObservedQuestion({ ...base, feedbackText: 'Incorrect. Try again.' });
    expect(parsed.feedback.retryAvailable).toBe(true);
  });

  it('ignores per-option markers without a clear feedback verdict', () => {
    const parsed = parseObservedQuestion({
      ...base,
      options: [
        { label: 'A', text: 'Layer 2', hasCorrectMarker: true },
        { label: 'B', text: 'Layer 3' },
      ],
      feedbackText: null,
    });
    expect(parsed.question?.officialCorrectness).toBeNull();
    expect(parsed.warnings.join(' ')).toMatch(/räknas inte som bevis/);
  });

  it('generates a stable question id for the same page and text', () => {
    const a = parseObservedQuestion({ ...base, feedbackText: null });
    const b = parseObservedQuestion({ ...base, feedbackText: null });
    expect(a.question?.id).toBe(b.question?.id);
  });

  it('handles an empty page without inventing a question', () => {
    const parsed = parseObservedQuestion({ ...base, questionText: '   ', feedbackText: null });
    expect(parsed.question).toBeNull();
  });
});
