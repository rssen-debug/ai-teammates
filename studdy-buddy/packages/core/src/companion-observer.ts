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
  kind?: 'error' | 'study' | 'code' | 'creative';
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
    kind: 'error',
    label: 'Jag upptäckte ett fel · kollar vad som hjälper',
    question: 'Jag arbetar i ' + title.slice(0, 90) +
      '. I gränssnittet finns detta fel: ' + value +
      '. Förklara vad felet troligen betyder och föreslå EN konkret säker åtgärd på svenska. Max två korta meningar. Gör inga klick eller ändringar.',
  };
}

/** Context is inferred from local, accessible UI only. No broad screen
 * recording, hidden content capture, web uploads, or private app observation.
 * Labels are fixed templates and never contain the raw observed text.
 */
export function detectContextHint(snapshot: UiSnapshot, title: string): CompanionHint | null {
  if (!snapshot.accessible || !allowedObservationTitle(title)) return null;
  const safeElements = snapshot.elements.filter(e =>
    /^(text|statictext|document|label|heading|tab)$/i.test(e.role) &&
    !/(password|secret|token|api.?key|auth|otp|credit.?card|personnummer|bank)/i.test(e.name ?? '') &&
    !/(password|secret|token|api.?key|auth|otp|credit.?card|personnummer|bank)/i.test(e.value ?? '')
  ).slice(0, 40);
  // A generic app name alone is not evidence of what the user is doing.
  const sample = safeElements.map(e => (e.name || e.value || '').slice(0, 130)).join(' ').slice(0, 2200);
  if (!sample) return null;
  const combined = title + ' ' + sample;
  const patterns: Array<{kind: 'study'|'code'|'creative'; re: RegExp; label: string; question: string}> = [
    {
      kind: 'study',
      re: /\b(OSI|subnet(?:ting)?|IPv[46]|Cisco|Packet Tracer|NetAcad|quiz|checkpoint exam|network protocols|TCP\/IP)\b/i,
      label: 'Jag ser tecken på nätverksstudier',
      question: 'Jag ser tecken på nätverksstudier i ett tillåtet fönster. Vill du att jag hjälper till med en förklaring eller ett quiz?',
    },
    {
      kind: 'code',
      re: /\b(TypeScript|JavaScript|Python|VS Code|Visual Studio Code|GitHub|pull request|terminal|compile|build failed|npm test)\b/i,
      label: 'Jag ser tecken på programmering',
      question: 'Jag ser tecken på programmering i ett tillåtet fönster. Vill du ha hjälp att granska eller felsöka?',
    },
    {
      kind: 'creative',
      re: /\b(Premiere Pro|DaVinci Resolve|After Effects|CapCut|video editing|timeline|render queue|Figma|Canva)\b/i,
      label: 'Jag ser tecken på kreativt arbete',
      question: 'Jag ser tecken på kreativt arbete i ett tillåtet fönster. Vill du ha hjälp att planera nästa steg?',
    },
  ];
  const matched = patterns.find(p => p.re.test(combined));
  if (!matched) return null;
  return {
    signature: createHash('sha256').update(matched.kind + '\0' + title).digest('hex').slice(0, 20),
    kind: matched.kind,
    label: matched.label,
    question: matched.question,
  };
}
