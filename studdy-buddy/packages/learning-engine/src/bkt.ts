/**
 * Bayesian Knowledge Tracing (BKT) with difficulty weighting.
 *
 * We deliberately start with the classic 4-parameter BKT model because it is
 * interpretable, cheap, and well understood. It is not "the truth" about the
 * student -- it is an estimate with a confidence, and the UI must present it
 * that way.
 *
 * Parameters
 *  - pInit   P(knows it before any evidence)
 *  - pLearn P(learns it on any given opportunity)
 *  - pSlip   P(answers wrong despite knowing)
 *  - pGuess  P(answers right without knowing)
 *
 * Difficulty shifts slip/guess: a hard question has a higher slip probability
 * and a lower guess probability, so a correct answer on a hard item is stronger
 * evidence.
 */

import type { ConceptState, LearningEvidenceInput, MasteryEstimate } from '@studdy/shared';
import { addDays, clamp, daysBetween, nowIso } from '@studdy/shared';

export interface BktParams {
  pInit: number;
  pLearn: number;
  pSlip: number;
  pGuess: number;
}

export const DEFAULT_BKT: BktParams = { pInit: 0.12, pLearn: 0.11, pSlip: 0.1, pGuess: 0.2 };

/** Difficulty (1..5) -> adjusted slip/guess. */
export function adjustedParams(base: BktParams, difficulty: number): BktParams {
  const d = clamp(difficulty, 1, 5);
  // difficulty 1: easy item, high guess, low slip. difficulty 5: hard item.
  const t = (d - 1) / 4;
  const pGuess = clamp(base.pGuess * (1.35 - 0.7 * t), 0.02, 0.6);
  const pSlip = clamp(base.pSlip * (0.55 + 1.1 * t), 0.02, 0.5);
  return { ...base, pGuess, pSlip };
}

/** Standard BKT posterior update for one observation. */
export function bktUpdate(prior: number, correct: boolean, params: BktParams): number {
  const p = clamp(prior, 0.001, 0.999);
  const { pGuess, pSlip, pLearn } = params;
  let posterior: number;
  if (correct) {
    const num = p * (1 - pSlip);
    const den = num + (1 - p) * pGuess;
    posterior = den === 0 ? p : num / den;
  } else {
    const num = p * pSlip;
    const den = num + (1 - p) * (1 - pGuess);
    posterior = den === 0 ? p : num / den;
  }
  // Opportunity to learn regardless of outcome.
  return clamp(posterior + (1 - posterior) * pLearn, 0.001, 0.999);
}

/** Evidence that is heavily hinted should not be treated as independent mastery. */
export function hintDiscount(hintsUsed: number): number {
  if (hintsUsed <= 0) return 1;
  return clamp(1 / (1 + 0.6 * hintsUsed), 0.1, 1);
}

export interface MasteryInputs {
  conceptId: string;
  evidence: LearningEvidenceInput[];
  now?: string;
}

export interface MasteryComputation extends MasteryEstimate {
  /** Human-readable explanation of *why* the estimate looks like this. */
  rationale: string[];
}

/**
 * Recomputes mastery from the full evidence set for a concept.
 * Pure function: same inputs always produce the same estimate, which makes the
 * tests meaningful and lets us replay history after a bug fix.
 */
export function computeMastery(input: MasteryInputs): MasteryComputation {
  const now = input.now ?? nowIso();
  const rationale: string[] = [];
  let p = DEFAULT_BKT.pInit;
  let independentCorrect = 0;
  let scored = 0;
  let lastEvidenceAt: string | null = null;

  // Evidence MUST arrive in chronological order: BKT is a sequential filter, so
  // replaying newest-first would apply the student's latest mistake before their
  // earlier successes and produce a wrong estimate.
  const ordered = input.evidence;
  let errorInLastThree = 0;

  for (const ev of ordered) {
    scored += 1;
    switch (ev.kind) {
      case 'READING_EXPOSURE': {
        // Reading is exposure, not knowledge. It can only lift a floor.
        p = Math.max(p, 0.2);
        rationale.push('Exposure from reading is capped so reading alone cannot produce mastery.');
        break;
      }
      case 'QUIZ_CORRECT': {
        const params = adjustedParams(DEFAULT_BKT, ev.difficulty);
        const gain = bktUpdate(p, true, params);
        const discounted = p + (gain - p) * hintDiscount(ev.hintsUsed);
        p = clamp(discounted, 0.001, 0.999);
        if (ev.hintsUsed === 0) {
          independentCorrect += 1;
          rationale.push(`Independent correct answer at difficulty ${ev.difficulty} raised the estimate.`);
        } else {
          rationale.push(`${ev.hintsUsed} hint(s) were used, so credit for this answer was reduced.`);
        }
        break;
      }
      case 'EXPLAINED_BACK': {
        p = clamp(bktUpdate(p, true, adjustedParams(DEFAULT_BKT, Math.max(3, ev.difficulty))) + 0.03, 0.001, 0.999);
        independentCorrect += 1;
        rationale.push('Explaining the concept back counts as independent evidence.');
        break;
      }
      case 'PRACTICAL_SUCCESS': {
        p = clamp(bktUpdate(p, true, adjustedParams(DEFAULT_BKT, Math.max(3, ev.difficulty))), 0.001, 0.999);
        independentCorrect += 1;
        rationale.push('A successful practical task in Packet Tracer counted as evidence.');
        break;
      }
      case 'QUIZ_INCORRECT':
      case 'HINTED_CORRECT': {
        p = bktUpdate(p, false, adjustedParams(DEFAULT_BKT, ev.difficulty));
        errorInLastThree = Math.min(3, errorInLastThree + 1);
        rationale.push('An incorrect or heavily hinted answer lowered the estimate.');
        break;
      }
      default: {
        break;
      }
    }
    // Only successes clear the "recent mistake" streak.
    if (ev.kind === 'QUIZ_CORRECT' || ev.kind === 'EXPLAINED_BACK' || ev.kind === 'PRACTICAL_SUCCESS') {
      errorInLastThree = 0;
    }
    lastEvidenceAt = now;
  }

  const onlyExposure = ordered.length > 0 && ordered.every((e) => e.kind === 'READING_EXPOSURE');
  // Confidence grows with the number of *scored* observations, capped.
  const confidence = clamp(1 - Math.exp(-scored / 4), 0, 0.95);
  const state = deriveState({ p, onlyExposure, evidenceCount: scored, independentCorrect, confidence, recentErrors: errorInLastThree });
  const reviewDueAt = state === 'NOT_SEEN' ? null : computeReviewDue(state, p, lastEvidenceAt ?? now, independentCorrect);

  if (onlyExposure) rationale.push('Only reading exposure has been observed; no answers have been checked yet.');
  if (state === 'REVIEW_DUE') rationale.push('The scheduled review date has passed.');

  return {
    conceptId: input.conceptId,
    probability: p,
    state,
    evidenceCount: scored,
    independentCorrect,
    lastEvidenceAt,
    reviewDueAt,
    confidence,
    rationale,
  };
}

export function deriveState(args: {
  p: number;
  onlyExposure: boolean;
  evidenceCount: number;
  independentCorrect: number;
  confidence: number;
  recentErrors?: number;
  reviewDue?: boolean;
}): ConceptState {
  if (args.evidenceCount === 0) return 'NOT_SEEN';
  if (args.onlyExposure) return 'EXPOSED';
  if (args.reviewDue) return 'REVIEW_DUE';
  // A fresh mistake demotes mastery: knowledge must stay revisable, so one
  // recent error is enough to pull MASTERED back down to DEMONSTRATED.
  if ((args.recentErrors ?? 0) > 0 && args.p >= 0.5) return 'DEMONSTRATED';
  if (args.p >= 0.9 && args.independentCorrect >= 4 && args.confidence >= 0.7) return 'MASTERED';
  if (args.p >= 0.7 && args.independentCorrect >= 2) return 'DEMONSTRATED';
  if (args.p >= 0.45) return 'DEVELOPING';
  return 'PRACTICING';
}

/**
 * Spaced repetition: the interval a concept stays fresh for. Derived from the
 * same probability so a shaky concept comes back quickly.
 */
export function reviewIntervalDays(probability: number, independentCorrect: number): number {
  const ladder = [0.5, 1, 2, 4, 7, 14, 30];
  const base = Math.floor(clamp(probability, 0, 0.999) * ladder.length);
  const bump = Math.min(2, Math.floor(independentCorrect / 2));
  return ladder[clamp(base + bump, 0, ladder.length - 1)] ?? 1;
}

export function computeReviewDue(state: ConceptState, probability: number, lastEvidenceAt: string, independentCorrect: number): string | null {
  if (state === 'NOT_SEEN') return null;
  const days = reviewIntervalDays(probability, independentCorrect);
  return addDays(lastEvidenceAt, days);
}

export function isReviewDue(reviewDueAt: string | null, now: string = nowIso()): boolean {
  if (!reviewDueAt) return false;
  return new Date(reviewDueAt).getTime() <= new Date(now).getTime();
}

export function stalenessDays(lastEvidenceAt: string | null, now: string = nowIso()): number {
  if (!lastEvidenceAt) return 0;
  return Math.max(0, daysBetween(lastEvidenceAt, now));
}

/** Applies the review-due flag on top of a stored estimate. */
export function withReviewFlag(estimate: MasteryEstimate, now: string = nowIso()): MasteryEstimate {
  if (estimate.state === 'NOT_SEEN' || estimate.state === 'EXPOSED') return estimate;
  if (isReviewDue(estimate.reviewDueAt, now)) return { ...estimate, state: 'REVIEW_DUE' };
  return estimate;
}

/** Display helper only: internal probabilities keep full precision. */
export function roundForDisplay(n: number): number {
  return Math.round(n * 1000) / 1000;
}
