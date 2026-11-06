import type { LearningEvidenceInput, MasteryEstimate, ConceptState } from '@studdy/shared';
import { nowIso } from '@studdy/shared';
import type { Database } from '@studdy/database';
import { computeMastery, withReviewFlag, isReviewDue, reviewIntervalDays } from './bkt.js';
import { CONCEPTS, DEPENDENCIES, conceptById, weakPrerequisites } from './concepts.js';
import { deriveCurriculumDependencies, extractConcepts, type ExtractedConcept } from './topics.js';

export interface LearningSnapshot {
  concepts: {
    conceptId: string;
    label: string;
    domain: string;
    probability: number;
    state: ConceptState;
    confidence: number;
    independentCorrect: number;
    reviewDueAt: string | null;
    overdue: boolean;
    rationale: string[];
  }[];
  dueForReview: string[];
  weakest: string[];
  strongest: string[];
  totals: { tracked: number; mastered: number; developing: number; notSeen: number };
}

/**
 * The learning engine is the only place mastery is written. Everything it says
 * is traceable to stored evidence, which is what the product requirement
 * "reading alone does not count as mastery" turns into in code.
 */
export class LearningService {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {
    this.seedConcepts();
  }

  private seedConcepts(): void {
    for (const c of CONCEPTS) this.db.learning.ensureConcept(c.id, c.label, c.domain);
    for (const dep of DEPENDENCIES) this.db.learning.addDependency(dep.conceptId, dep.prerequisiteId);
  }

  record(evidence: LearningEvidenceInput): MasteryEstimate {
    this.db.learning.recordEvidence(evidence);
    return this.recompute(evidence.conceptId);
  }

  recompute(conceptId: string): MasteryEstimate {
    // Repo returns newest-first; BKT needs chronological replay.
    const rows = this.db.learning.evidenceFor(conceptId, 500).slice().reverse();
    const evidence = rows.map((r) => ({
      conceptId: r.concept_id,
      kind: r.kind as LearningEvidenceInput['kind'],
      difficulty: clampDifficulty(r.difficulty),
      hintsUsed: r.hints_used,
      source: r.source as LearningEvidenceInput['source'],
      detail: r.detail ?? undefined,
    }));
    const computed = computeMastery({ conceptId, evidence, now: nowIso(this.clock) });
    const estimate: MasteryEstimate = {
      conceptId,
      probability: computed.probability,
      state: computed.state,
      evidenceCount: computed.evidenceCount,
      independentCorrect: computed.independentCorrect,
      lastEvidenceAt: computed.lastEvidenceAt,
      reviewDueAt: computed.reviewDueAt,
      confidence: computed.confidence,
    };
    this.db.learning.saveMastery(estimate);
    if (computed.rationale.length) {
      this.db.checkpoints.set(`mastery-rationale:${conceptId}`, computed.rationale.slice(-4));
    }
    return withReviewFlag(estimate, nowIso(this.clock));
  }

  estimate(conceptId: string): MasteryEstimate {
    const stored = this.db.learning.getMastery(conceptId);
    if (!stored) {
      return {
        conceptId,
        probability: 0,
        state: 'NOT_SEEN',
        evidenceCount: 0,
        independentCorrect: 0,
        lastEvidenceAt: null,
        reviewDueAt: null,
        confidence: 0,
      };
    }
    return withReviewFlag(stored, nowIso(this.clock));
  }

  probabilityMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const m of this.db.learning.allMastery()) map[m.conceptId] = m.probability;
    return map;
  }

  snapshot(): LearningSnapshot {
    const now = nowIso(this.clock);
    const stored = new Map(this.db.learning.allMastery().map((m) => [m.conceptId, m]));
    const concepts: LearningSnapshot['concepts'] = [];

    // Seed concepts (our authored map) plus every dynamic topic the student has
    // actually studied. Dynamic topics come from the stored concept table, so
    // they survive restarts without re-reading the page.
    const defs = [
      ...CONCEPTS.map((c) => ({ id: c.id, label: c.label, domain: c.domain as string })),
      ...dynamicConceptDefs(this.db),
    ];

    for (const def of defs) {
      const storedEstimate = stored.get(def.id);
      const estimate = withReviewFlag(
        storedEstimate ?? {
          conceptId: def.id,
          probability: 0,
          state: 'NOT_SEEN',
          evidenceCount: 0,
          independentCorrect: 0,
          lastEvidenceAt: null,
          reviewDueAt: null,
          confidence: 0,
        },
        now,
      );
      const rationale = this.db.checkpoints.get<string[]>(`mastery-rationale:${def.id}`) ?? [];
      concepts.push({
        conceptId: def.id,
        label: def.label,
        domain: def.domain,
        probability: estimate.probability,
        state: estimate.state,
        confidence: estimate.confidence,
        independentCorrect: estimate.independentCorrect,
        reviewDueAt: estimate.reviewDueAt,
        overdue: isReviewDue(estimate.reviewDueAt, now),
        rationale,
      });
    }

    const practiced = concepts.filter((c) => c.state !== 'NOT_SEEN');
    return {
      concepts,
      dueForReview: concepts.filter((c) => c.overdue).map((c) => c.conceptId),
      weakest: [...practiced].sort((a, b) => a.probability - b.probability).slice(0, 5).map((c) => c.conceptId),
      strongest: [...practiced].sort((a, b) => b.probability - a.probability).slice(0, 5).map((c) => c.conceptId),
      totals: {
        tracked: practiced.length,
        mastered: concepts.filter((c) => c.state === 'MASTERED').length,
        developing: concepts.filter((c) => c.state === 'DEVELOPING' || c.state === 'DEMONSTRATED').length,
        notSeen: concepts.filter((c) => c.state === 'NOT_SEEN').length,
      },
    };
  }

  /**
   * When the student misses a question, decide whether the real gap is lower
   * in the prerequisite graph. Used by the quiz engine to pick the next item.
   */
  diagnoseGap(conceptId: string): { conceptId: string; reason: string }[] {
    const probs = this.probabilityMap();
    const weak = weakPrerequisites(conceptId, probs, 0.55);
    return weak.slice(0, 3).map((id) => ({
      conceptId: id,
      reason: `${conceptById(id)?.label ?? id} behövs för ${conceptById(conceptId)?.label ?? conceptId} och verkar ännu inte sitta.`,
    }));
  }

  /**
   * Registers topics derived from what the student is actually studying, so the
   * same mastery model works for any subject (Canvas biology, a law course, ...),
   * not just the authored networking map.
   *
   * This only creates the concept row. It records NO evidence: seeing a topic on
   * a page is exposure, and exposure alone never moves mastery.
   */
  registerConcepts(concepts: ExtractedConcept[], options: { dependenciesFromTitles?: string[] } = {}): ExtractedConcept[] {
    const registered: ExtractedConcept[] = [];
    for (const concept of concepts) {
      if (!concept.id.startsWith('dyn:')) continue;
      this.db.learning.ensureConcept(concept.id, concept.label, concept.domain);
      registered.push(concept);
    }
    // Curriculum order becomes the (heuristic) prerequisite graph.
    const titles = options.dependenciesFromTitles;
    if (titles && titles.length > 1) {
      const ordered = titles.map((title, index) => ({ id: `n${index}`, title }));
      for (const dep of deriveCurriculumDependencies({ orderedNodes: ordered })) {
        this.db.learning.addDependency(dep.conceptId, dep.prerequisiteId);
      }
    }
    return registered;
  }

  /** Registers topics extracted from the current page + curriculum titles. */
  learnTopicsFromStudyContext(input: {
    courseName?: string | null;
    nodeTitles?: string[];
    headingPath?: string[];
    selection?: string | null;
    max?: number;
  }): ExtractedConcept[] {
    const extracted = extractConcepts(
      [
        ...(input.nodeTitles ?? []),
        ...(input.nodeTitles ?? []),
        ...(input.headingPath ?? []),
        ...(input.headingPath ?? []),
        input.selection ?? '',
      ].join(' '),
      input.max ?? 12,
    );
    return this.registerConcepts(extracted, { dependenciesFromTitles: input.nodeTitles });
  }

  /** Label lookup that works for both seed and dynamic concepts. */
  labelFor(conceptId: string): string {
    return conceptById(conceptId)?.label ?? this.db.learning.conceptLabel(conceptId) ?? conceptId;
  }

  dueReviews(limit = 10): MasteryEstimate[] {
    const now = nowIso(this.clock);
    return this.db.learning
      .allMastery()
      .map((m) => withReviewFlag(m, now))
      .filter((m) => m.state === 'REVIEW_DUE')
      .sort((a, b) => (a.reviewDueAt ?? '').localeCompare(b.reviewDueAt ?? ''))
      .slice(0, limit);
  }

  /**
   * DVA120 readiness. Deliberately avoids a single fake percentage: it returns
   * evidence-backed statements the coach can phrase honestly.
   */
  readiness(input: { trackedConceptIds: string[]; now?: string }): {
    statements: string[];
    evidenceStrength: 'none' | 'thin' | 'moderate' | 'solid';
    weak: string[];
    strong: string[];
  } {
    const now = input.now ?? nowIso(this.clock);
    const snapshot = this.snapshot();
    const relevant = snapshot.concepts.filter((c) => input.trackedConceptIds.includes(c.conceptId));
    const withEvidence = relevant.filter((c) => c.state !== 'NOT_SEEN');
    const weak = relevant.filter((c) => c.state !== 'NOT_SEEN' && c.probability < 0.6).map((c) => c.conceptId);
    const strong = relevant.filter((c) => c.probability >= 0.75 && c.independentCorrect >= 2).map((c) => c.conceptId);

    let evidenceStrength: 'none' | 'thin' | 'moderate' | 'solid' = 'none';
    const independent = withEvidence.reduce((sum, c) => sum + c.independentCorrect, 0);
    // A wrong answer is real evidence about the student too, so readiness must
    // not report "no evidence" just because nothing was answered correctly yet.
    const scoredAnswers = withEvidence.filter((c) => c.state !== 'EXPOSED').length;
    if (independent >= 15) evidenceStrength = 'solid';
    else if (independent >= 6) evidenceStrength = 'moderate';
    else if (independent > 0 || scoredAnswers > 0) evidenceStrength = 'thin';

    const statements: string[] = [];
    if (independent === 0 && scoredAnswers === 0) {
      statements.push('Jag har ännu inga oberoende svar att bedöma dig på, så jag kan inte säga något om din beredskap.');
    } else {
      if (strong.length) {
        statements.push(`Du verkar bekväm med ${formatList(strong)}.`);
      }
      if (weak.length) {
        statements.push(`Dina senaste övningar visar att ${formatList(weak)} behöver mer träning.`);
      }
      const overdue = relevant.filter((c) => c.overdue).map((c) => c.conceptId);
      if (overdue.length) statements.push(`${formatList(overdue)} är dags att repetera.`);
      if (evidenceStrength !== 'solid') {
        statements.push('Underlaget är fortfarande tunt – fler oberoende svar behövs innan jag kan uttala mig säkert.');
      }
    }
    void now;

    return { statements, evidenceStrength, weak, strong };
  }

  /** Review schedule rows for the progress view. */
  reviewSchedule(): { conceptId: string; label: string; dueAt: string | null; intervalDays: number }[] {
    return this.db.learning.allMastery().map((m) => ({
      conceptId: m.conceptId,
      label: conceptById(m.conceptId)?.label ?? m.conceptId,
      dueAt: m.reviewDueAt,
      intervalDays: reviewIntervalDays(m.probability, m.independentCorrect),
    }));
  }
}

/**
 * Concepts created by the generic topic extractor (prefix `dyn:`), read back from
 * the database. The authored map above is seed knowledge; these are what the
 * student is actually studying right now.
 */
function dynamicConceptDefs(db: Database): { id: string; label: string; domain: string }[] {
  return db.learning
    .allConcepts()
    .filter((c) => c.id.startsWith('dyn:'))
    .map((c) => ({ id: c.id, label: c.label, domain: c.domain }));
}

function formatList(ids: string[]): string {
  const labels = ids.map((id) => conceptById(id)?.label ?? id);
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} och ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} och ${labels[labels.length - 1]}`;
}

function clampDifficulty(n: number): 1 | 2 | 3 | 4 | 5 {
  const v = Math.round(n);
  if (v <= 1) return 1;
  if (v === 2) return 2;
  if (v === 3) return 3;
  if (v === 4) return 4;
  return 5;
}
