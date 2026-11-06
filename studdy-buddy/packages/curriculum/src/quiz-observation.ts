import type { ObservedQuestion, QuizOption } from '@studdy/shared';
import { stableKey } from '@studdy/shared';

/**
 * Reads a practice question from the DOM text the extension captured.
 *
 * Hard rule from the spec: never infer correctness from the fact that an answer
 * was selected. `officialCorrectness` is populated only from explicit platform
 * feedback text ("Correct", "Incorrect", "Rätt", "Fel").
 */

export interface QuestionDomSnapshot {
  /** Text of the question container. */
  questionText: string;
  /** Each option's visible label + text. */
  options: { label: string; text: string; checked?: boolean; hasCorrectMarker?: boolean; hasIncorrectMarker?: boolean }[];
  /** Whole feedback region text, if rendered. */
  feedbackText: string | null;
  /** Input type, to distinguish multi-select and short answer. */
  inputType: 'radio' | 'checkbox' | 'text' | 'select' | 'unknown';
  /** Mode already classified by the caller. */
  mode: ObservedQuestion['mode'];
  pageUrl: string;
}

const CORRECT_MARKERS = [/\bcorrect\b/i, /\brätt\b/i, /\bkorrekt\b/i, /\briktigt\b/i];
const INCORRECT_MARKERS = [/\bincorrect\b/i, /\bfel\b/i, /\bforkert\b/i, /\bwrong\b/i];
const TRY_AGAIN_MARKERS = [/try again/i, /försök igen/i];

export interface ParsedQuestion {
  question: ObservedQuestion | null;
  /** Explicit feedback detected, separate from per-option markers. */
  feedback: { visible: boolean; correctness: boolean | null; retryAvailable: boolean; text: string };
  warnings: string[];
}

export function parseObservedQuestion(snapshot: QuestionDomSnapshot): ParsedQuestion {
  const warnings: string[] = [];
  const questionText = snapshot.questionText.replace(/\s+/g, ' ').trim();
  if (!questionText) {
    return {
      question: null,
      feedback: { visible: false, correctness: null, retryAvailable: false, text: '' },
      warnings: ['Ingen frågetext hittades.'],
    };
  }

  const feedbackText = (snapshot.feedbackText ?? '').trim();
  const positive = CORRECT_MARKERS.some((re) => re.test(feedbackText));
  const negative = INCORRECT_MARKERS.some((re) => re.test(feedbackText));
  // Ambiguous feedback is not evidence. Both markers usually means "incorrect,
  // the correct answer was X" -- so we take the negative reading.
  const officialCorrectness = negative ? false : positive ? true : null;
  const retryAvailable = TRY_AGAIN_MARKERS.some((re) => re.test(feedbackText));

  const options: QuizOption[] = snapshot.options.map((o) => ({ label: o.label.trim(), text: o.text.replace(/\s+/g, ' ').trim() }));
  const selected = snapshot.options.filter((o) => o.checked).map((o) => o.label.trim());

  if (options.length === 0 && !feedbackText) {
    warnings.push('Inga svarsalternativ hittades.');
  }

  const questionType = inferType(snapshot.inputType, snapshot.options.length);

  // Per-option markers are only trusted when the platform drew them and the
  // feedback region itself is unambiguous.
  const markedCorrect = snapshot.options.filter((o) => o.hasCorrectMarker).map((o) => o.label.trim());
  const markedWrong = snapshot.options.filter((o) => o.hasIncorrectMarker).map((o) => o.label.trim());
  if (officialCorrectness === null && (markedCorrect.length || markedWrong.length)) {
    warnings.push('Markeringar per svarsalternativ hittades men ingen tydlig feedback-text; räknas inte som bevis.');
  }

  const id = `q:${stableKey(snapshot.pageUrl.split('?')[0], questionText)}`;

  return {
    question: {
      id,
      questionText,
      options,
      questionType,
      officialCorrectness,
      selected,
      feedbackVisible: feedbackText.length > 0,
      mode: snapshot.mode,
      conceptId: null,
    },
    feedback: {
      visible: feedbackText.length > 0,
      correctness: officialCorrectness,
      retryAvailable,
      text: feedbackText.slice(0, 1000),
    },
    warnings,
  };
}

function inferType(inputType: QuestionDomSnapshot['inputType'], optionCount: number): ObservedQuestion['questionType'] {
  switch (inputType) {
    case 'radio':
      return optionCount === 2 ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE';
    case 'checkbox':
      return 'MULTIPLE_ANSWER';
    case 'text':
      return 'SHORT_ANSWER';
    case 'select':
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Detects matching-style questions where options render as two columns.
 * Kept separate because the DOM shape differs enough to need its own heuristic.
 */
export function looksLikeMatchingQuestion(leftTexts: string[], rightTexts: string[]): boolean {
  if (leftTexts.length < 2 || rightTexts.length < 2) return false;
  const sameLength = leftTexts.length === rightTexts.length;
  const noSharedWords = leftTexts.every((l) => !rightTexts.some((r) => r.trim() === l.trim()));
  return sameLength && noSharedWords;
}
