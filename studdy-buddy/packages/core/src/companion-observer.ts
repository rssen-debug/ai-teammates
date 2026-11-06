import { createHash } from 'node:crypto';
import type { UiSnapshot } from '@studdy/shared';

const PRIVATE_WINDOW = /bank|login|sign.?in|password|lösenord|vault|1password|bitwarden|keepass|incognito|inprivate|private browsing|privat fönster|whatsapp|signal|telegram|discord|gmail|outlook|chatgpt/i;
const ERROR_TERMS = /\b(error|failed|failure|invalid|unreachable|timeout|denied|exception|felaktig|misslyckades|ogiltig|kunde inte|destination host unreachable|request timed out|syntax error)\b/i;

export function allowedObservationTitle(title: string): boolean {
  return title.length > 0 && !PRIVATE_WINDOW.test(title);
}

export interface CompanionHint {
  signature: string;
  label: string;
  question: string;
}

/** Only fixed, local text classification. The raw UI tree is never logged. */
export function detectCompanionHint(snapshot: UiSnapshot, title: string): CompanionHint | null {
  if (!snapshot.accessible || !allowedObservationTitle(title)) return null;
  const candidates = snapshot.elements
    .filter(e => /^(text|statictext|alert|status|document|edit|label)$/i.test(e.role))
    .map(e => (e.name || e.value || '').slice(0, 220).trim())
    .filter(t => t.length >= 6 && t.length <= 220 && ERROR_TERMS.test(t) && !PRIVATE_WINDOW.test(t));
  if (!candidates.length) return null;
  const value = candidates[0]!;
  const signature = createHash('sha256').update(title + '\0' + value).digest('hex').slice(0, 20);
  return {
    signature,
    label: 'Jag upptäckte ett fel · kollar vad som hjälper',
    question: 'Jag arbetar i ' + title.slice(0, 90) +
      '. I gränssnittet finns detta fel: ' + value +
      '. Förklara vad felet troligen betyder och föreslå EN konkret säker åtgärd på svenska. Max två korta meningar. Gör inga klick eller ändringar.',
  };
}
