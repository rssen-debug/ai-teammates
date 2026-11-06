import type { AssessmentMode } from '@studdy/shared';

/**
 * Assessment-mode classification.
 *
 * This gate protects the student: inside a graded quiz or formal exam Buddy
 * must not hand over answers. We classify conservatively -- when signals are
 * ambiguous we pick the *more* restrictive mode, because the cost of wrongly
 * helping cheat is worse than the cost of being unhelpfully careful.
 */

export interface AssessmentSignals {
  url: string;
  /** Visible text of the page/section, lowercased by the caller is fine too. */
  pageText: string;
  /** Words on any submit/launch button near the content. */
  buttonText: string[];
  /** True when a countdown/timer is visible. */
  timerVisible: boolean;
  /** True when the page states attempts are limited. */
  limitedAttempts: boolean;
}

const FORMAL = [/final exam/i, /\bproctored\b/i, /\bexam\b.*\b(locked|secure)\b/i, /\bslutprov\b/i, /\btentamen\b/i];
const GRADED = [/\bgraded\b/i, /\bquiz\b/i, /\bassessment\b/i, /\bcheck your understanding\b/i, /\bprov\b/i];
const PRACTICE = [/\bpractice\b/i, /\bactivity\b/i, /\bexercis/i, /\bövning\b/i, /\bträna\b/i];

export function classifyAssessment(signals: AssessmentSignals): { mode: AssessmentMode; reasons: string[] } {
  const reasons: string[] = [];
  const haystack = `${signals.url} ${signals.pageText} ${signals.buttonText.join(' ')}`.toLowerCase();

  if (FORMAL.some((re) => re.test(haystack))) {
    reasons.push('Sidan innehåller signaler för formellt prov.');
    return { mode: 'FORMAL_EXAM', reasons };
  }

  // A visible timer plus limited attempts is the strongest graded signal.
  if (signals.timerVisible && signals.limitedAttempts) {
    reasons.push('Timer och begränsat antal försök är synliga: behandlas som betygsatt quiz.');
    return { mode: 'GRADED_QUIZ', reasons };
  }

  if (GRADED.some((re) => re.test(haystack)) && !PRACTICE.some((re) => re.test(haystack))) {
    reasons.push('Sidan beskrivs som quiz/assessment utan praktikmarkering.');
    return { mode: 'GRADED_QUIZ', reasons };
  }

  if (signals.limitedAttempts) {
    reasons.push('Begränsat antal försök är synligt.');
    return { mode: 'GRADED_QUIZ', reasons };
  }

  if (PRACTICE.some((re) => re.test(haystack))) {
    reasons.push('Sidan beskrivs som övning/praktik.');
    return { mode: 'PRACTICE', reasons };
  }

  if (signals.pageText.trim().length > 0) {
    reasons.push('Inga bedömningssignaler hittades: behandlas som självstudier.');
    return { mode: 'SELF_STUDY', reasons };
  }

  reasons.push('Otillräcklig information för att avgöra sammanhang.');
  return { mode: 'UNKNOWN', reasons };
}

/**
 * The single policy decision the rest of the app consults.
 * Returns whether Buddy may explain the underlying concept, and whether it may
 * discuss the specific question at all.
 */
export function assistancePolicy(mode: AssessmentMode): {
  mayExplainConcept: boolean;
  mayDiscussSpecificQuestion: boolean;
  maySuggestAnswer: boolean;
  notice: string | null;
} {
  switch (mode) {
    case 'FORMAL_EXAM':
      return {
        mayExplainConcept: true,
        mayDiscussSpecificQuestion: false,
        maySuggestAnswer: false,
        notice: 'Det här ser ut som ett formellt prov. Jag förklarar gärna begreppen, men jag hjälper dig inte att svara på provfrågorna.',
      };
    case 'GRADED_QUIZ':
      return {
        mayExplainConcept: true,
        mayDiscussSpecificQuestion: false,
        maySuggestAnswer: false,
        notice: 'Det här verkar vara ett betygsatt quiz. Jag förklarar koncepten i stället för att ge svaren.',
      };
    case 'PRACTICE':
    case 'SELF_STUDY':
    case 'UNKNOWN':
    default:
      return { mayExplainConcept: true, mayDiscussSpecificQuestion: true, maySuggestAnswer: true, notice: null };
  }
}
