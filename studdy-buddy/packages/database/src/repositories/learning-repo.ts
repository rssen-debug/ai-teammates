import type { LearningEvidenceInput, MasteryEstimate, ConceptState } from '@studdy/shared';
import { createId, nowIso } from '@studdy/shared';
import type { SqlDriver } from '../driver.js';

export interface EvidenceRow {
  id: string;
  concept_id: string;
  kind: string;
  difficulty: number;
  hints_used: number;
  independent: number;
  source: string;
  detail: string | null;
  created_at: string;
}

interface MasteryRow {
  concept_id: string;
  probability: number;
  state: string;
  evidence_count: number;
  independent_correct: number;
  last_evidence_at: string | null;
  review_due_at: string | null;
  confidence: number;
  updated_at: string;
}

export class LearningRepo {
  constructor(private readonly db: SqlDriver) {}

  ensureConcept(id: string, label: string, domain = 'networking'): void {
    this.db.run('INSERT INTO concept (id, label, domain) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label', [
      id,
      label,
      domain,
    ]);
  }

  conceptLabel(id: string): string | null {
    const row = this.db.get<{ label: string }>('SELECT label FROM concept WHERE id = ?', [id]);
    return row?.label ?? null;
  }

  allConcepts(): { id: string; label: string; domain: string }[] {
    return this.db.all<{ id: string; label: string; domain: string }>('SELECT id, label, domain FROM concept ORDER BY id');
  }

  addDependency(conceptId: string, prerequisiteId: string): void {
    this.db.run('INSERT OR IGNORE INTO concept_dependency (concept_id, prerequisite_id) VALUES (?, ?)', [conceptId, prerequisiteId]);
  }

  prerequisites(conceptId: string): string[] {
    return this.db
      .all<{ prerequisite_id: string }>('SELECT prerequisite_id FROM concept_dependency WHERE concept_id = ?', [conceptId])
      .map((r) => r.prerequisite_id);
  }

  allDependencies(): { conceptId: string; prerequisiteId: string }[] {
    return this.db
      .all<{ concept_id: string; prerequisite_id: string }>('SELECT concept_id, prerequisite_id FROM concept_dependency')
      .map((r) => ({ conceptId: r.concept_id, prerequisiteId: r.prerequisite_id }));
  }

  recordEvidence(input: LearningEvidenceInput): EvidenceRow {
    const independent = input.kind === 'QUIZ_CORRECT' && input.hintsUsed === 0;
    const row: EvidenceRow = {
      id: createId('ev'),
      concept_id: input.conceptId,
      kind: input.kind,
      difficulty: input.difficulty,
      hints_used: input.hintsUsed,
      independent: independent ? 1 : 0,
      source: input.source,
      detail: input.detail ?? null,
      created_at: nowIso(),
    };
    this.ensureConcept(input.conceptId, input.conceptId);
    this.db.run(
      `INSERT INTO learning_evidence (id, concept_id, kind, difficulty, hints_used, independent, source, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.concept_id, row.kind, row.difficulty, row.hints_used, row.independent, row.source, row.detail, row.created_at],
    );
    return row;
  }

  evidenceFor(conceptId: string, limit = 100): EvidenceRow[] {
    return this.db.all<EvidenceRow>(
      'SELECT * FROM learning_evidence WHERE concept_id = ? ORDER BY created_at DESC LIMIT ?',
      [conceptId, limit],
    );
  }

  allEvidence(limit = 2000): EvidenceRow[] {
    return this.db.all<EvidenceRow>('SELECT * FROM learning_evidence ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  saveMastery(estimate: MasteryEstimate): void {
    this.db.run(
      `INSERT INTO mastery_estimate (concept_id, probability, state, evidence_count, independent_correct, last_evidence_at, review_due_at, confidence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(concept_id) DO UPDATE SET
         probability = excluded.probability,
         state = excluded.state,
         evidence_count = excluded.evidence_count,
         independent_correct = excluded.independent_correct,
         last_evidence_at = excluded.last_evidence_at,
         review_due_at = excluded.review_due_at,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at`,
      [
        estimate.conceptId,
        estimate.probability,
        estimate.state,
        estimate.evidenceCount,
        estimate.independentCorrect,
        estimate.lastEvidenceAt,
        estimate.reviewDueAt,
        estimate.confidence,
        nowIso(),
      ],
    );
  }

  getMastery(conceptId: string): MasteryEstimate | null {
    const row = this.db.get<MasteryRow>('SELECT * FROM mastery_estimate WHERE concept_id = ?', [conceptId]);
    return row ? mapMastery(row) : null;
  }

  allMastery(): MasteryEstimate[] {
    return this.db.all<MasteryRow>('SELECT * FROM mastery_estimate ORDER BY probability DESC').map(mapMastery);
  }

  recordAttempt(input: {
    questionId: string;
    conceptId: string;
    difficulty: number;
    correct: boolean;
    hintsUsed: number;
    answer?: string | null;
  }): void {
    this.db.run(
      'INSERT INTO practice_attempt (id, question_id, concept_id, difficulty, correct, hints_used, answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [createId('att'), input.questionId, input.conceptId, input.difficulty, input.correct ? 1 : 0, input.hintsUsed, input.answer ?? null, nowIso()],
    );
  }

  recordMisconception(conceptId: string, description: string): void {
    const existing = this.db.get<{ id: string; occurrences: number }>(
      'SELECT id, occurrences FROM misconception WHERE concept_id = ? AND description = ? LIMIT 1',
      [conceptId, description],
    );
    if (existing) {
      this.db.run('UPDATE misconception SET occurrences = ?, last_seen_at = ? WHERE id = ?', [
        existing.occurrences + 1,
        nowIso(),
        existing.id,
      ]);
      return;
    }
    this.db.run('INSERT INTO misconception (id, concept_id, description, occurrences, last_seen_at) VALUES (?, ?, ?, 1, ?)', [
      createId('mis'),
      conceptId,
      description,
      nowIso(),
    ]);
  }

  misconceptions(limit = 20): { conceptId: string; description: string; occurrences: number }[] {
    return this.db
      .all<{ concept_id: string; description: string; occurrences: number }>(
        'SELECT concept_id, description, occurrences FROM misconception ORDER BY last_seen_at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({ conceptId: r.concept_id, description: r.description, occurrences: r.occurrences }));
  }

  attemptHistory(limit = 50): { conceptId: string; correct: boolean; difficulty: number; hintsUsed: number; createdAt: string }[] {
    return this.db
      .all<{ concept_id: string; correct: number; difficulty: number; hints_used: number; created_at: string }>(
        'SELECT concept_id, correct, difficulty, hints_used, created_at FROM practice_attempt ORDER BY created_at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({ conceptId: r.concept_id, correct: r.correct === 1, difficulty: r.difficulty, hintsUsed: r.hints_used, createdAt: r.created_at }));
  }

  /** Wipes all learning history while keeping settings. Used by "reset progress". */
  resetLearning(): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM learning_evidence');
      this.db.run('DELETE FROM mastery_estimate');
      this.db.run('DELETE FROM practice_attempt');
      this.db.run('DELETE FROM misconception');
    });
  }
}

function mapMastery(row: MasteryRow): MasteryEstimate {
  return {
    conceptId: row.concept_id,
    probability: row.probability,
    state: row.state as ConceptState,
    evidenceCount: row.evidence_count,
    independentCorrect: row.independent_correct,
    lastEvidenceAt: row.last_evidence_at,
    reviewDueAt: row.review_due_at,
    confidence: row.confidence,
  };
}
