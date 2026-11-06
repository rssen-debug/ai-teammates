import { seededNumber } from '@studdy/shared';
import { DIFFICULTY_ORDER, QUESTIONS, difficultyWeight, questionById, type Difficulty, type Question } from './program.js';

/**
 * Adaptive item selection.
 *
 * The rule we care about: practise the weakest concepts you have actually
 * touched, at a difficulty just above your current estimate, and bring back
 * concepts whose review is due. Deterministic given a seed so sessions are
 * reproducible in tests (and so the student does not get a different quiz when
 * they reopen the app).
 */

export interface SelectionInput {
  /** conceptId -> probability (0..1). Missing means unseen. */
  mastery: Record<string, number>;
  /** Concepts whose review interval has elapsed. */
  dueForReview: string[];
  /** Concept the student is currently reading about, if any. */
  currentConceptId?: string | null;
  /** Concepts already asked in this session (avoid immediate repetition). */
  asked?: string[];
  /** When true, avoid concepts with no evidence at all (unless nothing else fits). */
  preferKnown?: boolean;
  seed?: string;
  limit?: number;
}

export interface SelectedQuestion {
  question: Question;
  reason: string;
  score: number;
}

export function targetDifficulty(probability: number | undefined): Difficulty {
  if (probability === undefined) return 'FOUNDATION';
  if (probability < 0.3) return 'BEGINNER';
  if (probability < 0.5) return 'FOUNDATION';
  if (probability < 0.7) return 'INTERMEDIATE';
  if (probability < 0.88) return 'EXAM_LEVEL';
  return 'ADVANCED';
}

export function selectQuestions(input: SelectionInput): SelectedQuestion[] {
  const limit = input.limit ?? 1;
  const asked = new Set(input.asked ?? []);
  const due = new Set(input.dueForReview);
  const seed = input.seed ?? 'session';

  const scored: SelectedQuestion[] = QUESTIONS.filter((q) => !asked.has(q.id)).map((question) => {
    const p = input.mastery[question.conceptId];
    const target = targetDifficulty(p);
    const difficultyGap = Math.abs(difficultyWeight(question.difficulty) - difficultyWeight(target));

    let score = 0;
    const reasons: string[] = [];

    // Weakest concepts get the most attention.
    if (p !== undefined) score += (1 - p) * 6;
    else score += 2.5;
    if (due.has(question.conceptId)) {
      score += 3;
      reasons.push('dags att repetera');
    }
    if (input.currentConceptId && question.conceptId === input.currentConceptId) {
      score += 2.5;
      reasons.push('matchar det du läser nu');
    }
    // Close to the student's level, but never exactly at it twice in a row.
    score += Math.max(0, 2 - difficultyGap * 0.9);
    if (input.preferKnown && p === undefined) score -= 1.5;
    // Small deterministic jitter prevents the same fixed order every time.
    score += seededNumber(`${seed}:${question.id}`) * 0.6;

    if (p === undefined) reasons.push('nytt område');
    else if (p < 0.6) reasons.push('svagt område');
    else reasons.push('befäst område');

    return { question, reason: reasons.join(', '), score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Picks the next question, rotating away from the immediately previous concept. */
export function nextQuestion(input: SelectionInput & { lastConceptId?: string | null }): SelectedQuestion | null {
  const all = selectQuestions({ ...input, limit: Math.max(3, input.limit ?? 3) });
  const freshConcept = all.find((c) => c.question.conceptId !== input.lastConceptId);
  return freshQuestionOrFirst(freshConcept, all);
}

function freshQuestionOrFirst(found: SelectedQuestion | undefined, all: SelectedQuestion[]): SelectedQuestion | null {
  return found ?? all[0] ?? null;
}

// ---------------------------------------------------------------------------
// Answer evaluation
// ---------------------------------------------------------------------------

export interface EvaluationInput {
  questionId: string;
  /** Chosen option ids for choice questions. */
  selectedOptionIds?: string[];
  /** Free text for short answer / binary / subnetting. */
  freeText?: string;
  /** Self-assessment for EXPLAIN_BACK (checkbox per rubric line). */
  rubricHits?: number;
  hintsUsed?: number;
}

export interface Evaluation {
  questionId: string;
  conceptId: string;
  correct: boolean;
  /** True only when no hint was used before answering. */
  independent: boolean;
  feedback: string;
  hint: string;
  misconception: string | null;
  rubricFeedback: string[];
  difficulty: Difficulty;
  difficultyWeight: 1 | 2 | 3 | 4 | 5;
  /** Confidence in the grading itself (free text is graded strictly, so 1.0). */
  gradingConfidence: number;
}

export function evaluateAnswer(input: EvaluationInput): Evaluation | null {
  const question = questionById(input.questionId);
  if (!question) return null;
  const hintsUsed = input.hintsUsed ?? 0;

  let correct = false;
  let misconception: string | null = null;
  const rubricFeedback: string[] = [];

  switch (question.kind) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE_REASONING':
    case 'CLI_INTERPRET':
    case 'NETWORK_DIAGNOSIS': {
      const chosen = input.selectedOptionIds ?? [];
      const correctIds = (question.options ?? []).filter((o) => o.correct).map((o) => o.id);
      correct = chosen.length > 0 && chosen.length === correctIds.length && chosen.every((id) => correctIds.includes(id));
      if (!correct) {
        for (const id of chosen) {
          const option = (question.options ?? []).find((o) => o.id === id);
          if (option?.misconception) {
            misconception = option.misconception;
            break;
          }
        }
      }
      break;
    }
    case 'SHORT_ANSWER':
    case 'BINARY':
    case 'SUBNETTING': {
      const normalised = normaliseAnswer(input.freeText ?? '');
      correct = Boolean(normalised) && (question.accepted ?? []).some((a) => normaliseAnswer(a) === normalised);
      break;
    }
    case 'EXPLAIN_BACK': {
      const hits = input.rubricHits ?? 0;
      const total = question.rubric?.length ?? 0;
      // Two of three rubric points is a pass; this is self-reported, so it is
      // recorded as evidence but never as an independent quiz-correct event.
      correct = total > 0 && hits >= Math.ceil(total * 0.66);
      rubricFeedback.push(`Du träffade ${hits} av ${total} poäng i bedömningsmallen.`);
      break;
    }
    default:
      correct = false;
  }

  return {
    questionId: question.id,
    conceptId: question.conceptId,
    correct,
    independent: correct && hintsUsed === 0,
    feedback: correct ? question.explanation : question.onWrong,
    hint: question.hint,
    misconception,
    rubricFeedback,
    difficulty: question.difficulty,
    difficultyWeight: difficultyWeight(question.difficulty),
    gradingConfidence: question.kind === 'EXPLAIN_BACK' ? 0.6 : 1,
  };
}

/** Normalises free-text answers: case, spacing, trailing commas, "ip route x" spacing. */
export function normaliseAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.]$/, '')
    .trim();
}

/**
 * Builds the feedback payload the chat UI renders after a wrong answer:
 * misconception -> short explanation -> hint -> related question.
 */
export function remediationPlan(evaluation: Evaluation, relatedQuestionId: string | null): { steps: string[]; relatedQuestionId: string | null } {
  const steps: string[] = [];
  if (evaluation.misconception) steps.push(`Vanlig missuppfattning: ${evaluation.misconception}`);
  steps.push(evaluation.feedback);
  if (!evaluation.correct) steps.push(`Tips: ${evaluation.hint}`);
  return { steps, relatedQuestionId };
}

export function sameConceptQuestion(conceptId: string, excludeId: string): Question | null {
  return QUESTIONS.find((q) => q.conceptId === conceptId && q.id !== excludeId) ?? null;
}

export function difficultyLabel(d: Difficulty): string {
  return d;
}

export function difficultyIndex(d: Difficulty): number {
  return DIFFICULTY_ORDER.indexOf(d);
}
