import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@studdy/database';

/** Obsidian-compatible local mirror, generated from verified learning only.
 * The database remains canonical. Never export secrets, raw screen data, user
 * chat logs or individual test answers. No Obsidian installation required.
 */
function clean(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[|[\]\x60<>]/g, '').trim().slice(0, 110);
}
export function noteId(conceptId: string): string {
  return createHash('sha256').update(conceptId).digest('hex').slice(0, 16);
}
export interface VaultConcept {
  id: string; label: string; state: string; probability: number; confidence: number;
  evidenceCount: number; independentCorrect: number; lastEvidenceAt: string | null; reviewDueAt: string | null;
}
export interface VaultSnapshot {
  courseName: string | null; lastTopic: string | null; concepts: VaultConcept[]; updatedAt: string;
}
export function renderVault(snapshot: VaultSnapshot): { index: string; notes: { name: string; text: string }[] } {
  const active = snapshot.concepts.filter(c => c.evidenceCount > 0).sort((a,b) => a.label.localeCompare(b.label));
  const index = [
    '# Buddy – Studieläge',
    '',
    '> Autogenererat ur verifierat lärande. Att öppna en lektion är inte ett bevis på kunskap.',
    '',
    '## Pågående studier',
    '',
    '- Kurs: ' + clean(snapshot.courseName ?? 'Inte identifierad'),
    '- Senaste ämne: ' + clean(snapshot.lastTopic ?? 'Ännu inget'),
    '- Antal ämnen med övningsbevis: ' + active.length,
    '- Synkroniserat: ' + snapshot.updatedAt,
    '',
    '## Kunskapskarta',
    '',
    ...active.slice(0,200).map(c => '- [[Concepts/' + noteId(c.id) + '|' + clean(c.label) + ']] – ' +
      clean(c.state) + ' · ' + Math.round(c.probability * 100) + '% modellestimat · ' +
      c.independentCorrect + ' självständiga rätt'),
    '',
    '## Säkerhet och tolkning',
    '',
    '- Procenten är osäkra kunskapsestimat, inte officiella NetAcad-betyg.',
    '- Inga API-nycklar, skärmbilder, chattloggar eller testfrågor exporteras.',
    '- Lägg egna anteckningar utanför den maskinskapade Concepts-mappen.',
    '',
  ].join('\n');
  const notes = active.slice(0,200).map(c => ({
    name: noteId(c.id) + '.md',
    text: [
      '# ' + clean(c.label),
      '',
      '- Status: ' + clean(c.state),
      '- Kunskapsestimat: ' + Math.round(c.probability * 100) + '%',
      '- Säkerhet i uppskattningen: ' + Math.round(c.confidence * 100) + '%',
      '- Registrerade evidenspunkter: ' + c.evidenceCount,
      '- Självständigt korrekta svar: ' + c.independentCorrect,
      '- Senaste evidens: ' + (c.lastEvidenceAt ?? 'Ingen'),
      '- Nästa repetition: ' + (c.reviewDueAt ?? 'Ej schemalagd'),
      '',
      'Tillbaka till [[Buddy – Studieläge]].',
      '',
    ].join('\n'),
  }));
  return { index, notes };
}
export function writeStudyVault(db: Database, root: string, now = new Date()): string {
  const labels = new Map(db.learning.allConcepts().map(x => [x.id, x.label]));
  const concepts = db.learning.allMastery().map(m => ({
    id: m.conceptId, label: labels.get(m.conceptId) ?? m.conceptId,
    state: m.state, probability: m.probability, confidence: m.confidence,
    evidenceCount: m.evidenceCount, independentCorrect: m.independentCorrect,
    lastEvidenceAt: m.lastEvidenceAt, reviewDueAt: m.reviewDueAt,
  }));
  const course = db.curriculum.latestCourse();
  const session = db.sessions.latestOpen();
  const snapshot: VaultSnapshot = {
    courseName: course?.courseName ?? null,
    lastTopic: session?.lastNodeTitle ?? null,
    concepts, updatedAt: now.toISOString(),
  };
  const rendered = renderVault(snapshot);
  const vault = join(root, 'Study Vault');
  const generated = join(vault, 'Concepts');
  mkdirSync(generated, { recursive: true });
  writeChanged(join(vault, 'Buddy – Studieläge.md'), rendered.index);
  for (const note of rendered.notes) writeChanged(join(generated, note.name), note.text);
  return vault;
}
function writeChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  const temp = file + '.new';
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}
