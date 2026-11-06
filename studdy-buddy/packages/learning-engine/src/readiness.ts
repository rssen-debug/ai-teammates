/**
 * Readiness on a 0-100 scale.
 *
 * The product asks for "tentaberedskap på en skala 0-100". The honest way to give
 * that number is to derive it from recorded evidence and to show the derivation,
 * not to invent a percentage. So:
 *
 *   - every point on the scale maps to something the app can point at
 *   - the result carries its own explanation, the inputs it used, and what it did
 *     NOT have (thin evidence, unread course parts, reviews overdue)
 *   - a brand-new profile scores low and *says why*: nothing has been demonstrated
 *
 * The model is deliberately simple and auditable:
 *
 *   coverage  (0-40)  how much of the course has any evidence at all
 *   mastery   (0-40)  how strong that evidence is, weighted by independence
 *   retention (0-20)  whether it is still there (overdue reviews subtract)
 *
 * Nothing here can be moved by reading a page. Only evidence does that, which is
 * enforced upstream by the learning engine.
 */

import type { CurriculumGraph, CurriculumNode, MasteryEstimate } from '@studdy/shared';

export interface ReadinessConcept {
  conceptId: string;
  label: string;
  probability: number;
  state: string;
  confidence: number;
  independentCorrect: number;
  reviewDueAt: string | null;
  overdue: boolean;
  /** Set when the concept can be tied to a curriculum node. */
  nodeTitle?: string | null;
}

export interface ReadinessInput {
  concepts: ReadinessConcept[];
  graph: CurriculumGraph | null;
  now?: Date;
  /** Concepts the exam is expected to cover, when known. Empty = whole course. */
  trackedConceptIds?: string[];
}

export type ReadinessConfidence = 'ingen' | 'tunn' | 'måttlig' | 'god';

export interface ReadinessScore {
  /** 0-100. Null when there is literally nothing to score, which is honest. */
  score: number | null;
  confidence: ReadinessConfidence;
  /** One sentence a student can read. */
  headline: string;
  /** The three inputs, each with its own 0-100 and its share of the total. */
  parts: {
    coverage: { value: number; weight: 40; detail: string; covered: number; total: number };
    mastery: { value: number; weight: 40; detail: string; demonstrated: number };
    retention: { value: number; weight: 20; detail: string; overdue: number; scheduled: number };
  };
  /** Why the number is not higher. Shown verbatim in the UI. */
  limitations: string[];
  /** What to do next, weakest first. */
  nextSteps: { conceptId: string; label: string; reason: string }[];
  /** Strong and weak concepts, so the student can sanity-check the number. */
  strong: { conceptId: string; label: string; probability: number }[];
  weak: { conceptId: string; label: string; probability: number }[];
}

/** Concept states that count as "the student has worked with this". */
const TOUCHED = new Set(['EXPOSED', 'PRACTICING', 'DEVELOPING', 'DEMONSTRATED', 'MASTERED', 'REVIEW_DUE']);
/** Concept states backed by an answer rather than by reading. */
const SCORED = new Set(['PRACTICING', 'DEVELOPING', 'DEMONSTRATED', 'MASTERED', 'REVIEW_DUE']);

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  const now = input.now ?? new Date();
  const concepts = input.trackedConceptIds?.length
    ? input.concepts.filter((c) => input.trackedConceptIds?.includes(c.conceptId))
    : input.concepts;

  const modules = curriculumUnits(input.graph);
  const totalUnits = modules.length;

  // ---- coverage: how much of the course has any evidence -------------------
  const touched = concepts.filter((c) => TOUCHED.has(c.state));
  const coveredUnits = modules.filter((node) => {
    const title = (node.title ?? '').toLowerCase();
    if (!title) return false;
    return touched.some((c) => title.includes(c.label.toLowerCase()) || c.nodeTitle === node.title);
  }).length;
  // Coverage is measured against the course when we know it, otherwise against
  // the concepts we track. An unread course cannot produce a fake high number.
  const coverageDenominator = totalUnits > 0 ? totalUnits : Math.max(concepts.length, 1);
  const coverageNumerator = totalUnits > 0 ? coveredUnits : touched.length;
  const coverageRatio = clamp01(coverageNumerator / coverageDenominator);

  // ---- mastery: strength of the evidence, independence-weighted ------------
  const scored = concepts.filter((c) => SCORED.has(c.state));
  const masteryNumerator = scored.reduce((sum, c) => {
    // Independent correct answers are what count; confidence shrinks the value
    // of thin evidence so one lucky answer cannot look like mastery.
    const independence = Math.min(1, c.independentCorrect / 3);
    return sum + c.probability * (0.4 + 0.6 * independence) * (0.5 + 0.5 * c.confidence);
  }, 0);
  const masteryDenominator = Math.max(coverageDenominator, 1);
  const masteryRatio = clamp01(masteryNumerator / masteryDenominator);

  // ---- retention: is it still there? --------------------------------------
  const scheduled = concepts.filter((c) => c.reviewDueAt !== null);
  const overdue = scheduled.filter((c) => c.overdue || (c.reviewDueAt !== null && new Date(c.reviewDueAt).getTime() < now.getTime()));
  // Scheduled reviews only exist for things that were demonstrated. Retaining
  // nothing cannot score full marks: an untested student is not "retained".
  const retentionRatio = scored.length === 0 ? 0 : clamp01(1 - overdue.length / Math.max(scored.length, 1));

  const coverageValue = Math.round(coverageRatio * 100);
  const masteryValue = Math.round(masteryRatio * 100);
  const retentionValue = Math.round(retentionRatio * 100);

  const weighted = coverageValue * 0.4 + masteryValue * 0.4 + retentionValue * 0.2;
  const hasAnyEvidence = scored.length > 0 || touched.length > 0;

  const independent = concepts.reduce((sum, c) => sum + c.independentCorrect, 0);
  const confidence: ReadinessConfidence =
    independent >= 15 ? 'god' : independent >= 6 ? 'måttlig' : independent > 0 || scored.length > 0 ? 'tunn' : 'ingen';

  const limitations: string[] = [];
  if (!hasAnyEvidence) {
    limitations.push('Ingen kunskap är registrerad ännu, så siffran säger inget om dig. Den rör sig först när du svarar på frågor.');
  }
  if (scored.length === 0 && touched.length > 0) {
    limitations.push('Du har läst material men inte svarat på några frågor, och läsning räknas inte som kunskap.');
  }
  if (confidence === 'tunn') limitations.push('Underlaget är tunt: få oberoende svar, så siffran är osäker.');
  if (confidence === 'måttlig') limitations.push('Underlaget är måttligt. Fler oberoende svar skulle göra siffran stabilare.');
  if (overdue.length) limitations.push(`${overdue.length} begrepp är dags att repetera och drar ner siffran tills du gör det.`);
  if (totalUnits === 0) limitations.push('Kursstrukturen är inte läst ännu, så täckningen mäts mot begreppen vi följer i stället för mot kursen.');
  if (input.graph && input.graph.nodes.some((n) => n.inaccessible)) {
    limitations.push('Delar av kursen kunde inte läsas och räknas därför inte alls.');
  }

  const sorted = [...concepts].sort((a, b) => a.probability - b.probability);
  const weak = sorted.filter((c) => c.state !== 'NOT_SEEN').slice(0, 5);
  const strong = [...concepts]
    .filter((c) => c.probability >= 0.7 && c.independentCorrect >= 2)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);

  const nextSteps = sorted
    .filter((c) => c.state !== 'MASTERED')
    .slice(0, 3)
    .map((c) => ({
      conceptId: c.conceptId,
      label: c.label,
      reason:
        c.overdue
          ? 'Dags att repetera – det sitter inte längre.'
          : c.independentCorrect === 0
            ? 'Inga oberoende rätta svar ännu.'
            : `${c.independentCorrect} oberoende rätt – öva på svårare varianter.`,
    }));

  const score = hasAnyEvidence ? Math.round(clamp01(weighted / 100) * 100) : null;

  return {
    score,
    confidence,
    headline: headlineFor(score, confidence, scored.length),
    parts: {
      coverage: {
        value: coverageValue,
        weight: 40,
        detail: totalUnits > 0 ? `${coveredUnits} av ${totalUnits} delar i kursen har spår av arbete.` : `${touched.length} begrepp har spår av arbete.`,
        covered: totalUnits > 0 ? coveredUnits : touched.length,
        total: coverageDenominator,
      },
      mastery: {
        value: masteryValue,
        weight: 40,
        detail: `${scored.length} begrepp har svar bakom sig, viktade efter oberoende och säkerhet.`,
        demonstrated: scored.length,
      },
      retention: {
        value: retentionValue,
        weight: 20,
        detail: scheduled.length ? `${overdue.length} av ${scheduled.length} schemalagda repetitioner är försenade.` : 'Inga repetitioner schemalagda ännu.',
        overdue: overdue.length,
        scheduled: scheduled.length,
      },
    },
    limitations,
    nextSteps,
    strong: strong.map((c) => ({ conceptId: c.conceptId, label: c.label, probability: c.probability })),
    weak: weak.map((c) => ({ conceptId: c.conceptId, label: c.label, probability: c.probability })),
  };
}

function headlineFor(score: number | null, confidence: ReadinessConfidence, scoredCount: number): string {
  if (score === null) return 'Ingen beredskap kan mätas ännu – inget är registrerat.';
  if (confidence === 'ingen') return 'Underlaget räcker inte för att säga något om din beredskap.';
  if (score < 25) return `Tidigt läge (${score}/100). Mycket av kursen är ännu inte tränad.`;
  if (score < 50) return `Grunden börjar sitta (${score}/100). Fortsätt med de svagaste begreppen.`;
  if (score < 75) return `Du är på god väg (${score}/100) med ${scoredCount} begrepp som har svar bakom sig.`;
  return `Stark grund (${score}/100), men siffran är en uppskattning – inte en garanti på tentan.`;
}

/** Course units to measure coverage against: modules, chapters and lessons. */
export function curriculumUnits(graph: CurriculumGraph | null): CurriculumNode[] {
  if (!graph) return [];
  return graph.nodes.filter((n) => n.kind === 'MODULE' || n.kind === 'CHAPTER' || n.kind === 'LESSON');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Convenience for the progress panel: turn a mastery list into readiness input. */
export function readinessFromEstimates(input: {
  concepts: { conceptId: string; label: string; probability: number; state: string; confidence: number; independentCorrect: number; reviewDueAt: string | null; overdue: boolean }[];
  graph: CurriculumGraph | null;
  now?: Date;
}): ReadinessScore {
  return computeReadiness({ concepts: input.concepts, graph: input.graph, now: input.now });
}

export type { MasteryEstimate };
