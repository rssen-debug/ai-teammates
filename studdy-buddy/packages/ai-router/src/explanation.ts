import type { ResponseMode, StructuredResponse, ValidationIssue, ValidationResult } from '@studdy/shared';
import { countWords, splitSentences, truncate } from '@studdy/shared';

/**
 * The explanation pipeline.
 *
 * QUESTION -> CONTEXT -> INTENT -> CONCEPT -> KNOWLEDGE ESTIMATE -> PLAN ->
 * GENERATE -> ACCURACY VALIDATE -> LENGTH VALIDATE -> PRESENT
 *
 * The model never writes the final prose the student reads in an unconstrained
 * way: it fills a StructuredResponse as JSON, we validate it, and the renderer
 * decides which fields are shown. That is how "2-4 short sentences by default"
 * is enforced rather than hoped for.
 */

export interface ModePolicy {
  /** Maximum sentences for the primary prose (directAnswer + simpleExplanation). */
  maxSentences: number;
  /** Maximum words for the whole visible answer. */
  maxWords: number;
  showExample: boolean;
  showDeeper: boolean;
  showNextAction: boolean;
  temperature: number;
  maxTokens: number;
  instruction: string;
}

export const MODE_POLICIES: Record<ResponseMode, ModePolicy> = {
  QUICK: {
    maxSentences: 2,
    maxWords: 45,
    showExample: false,
    showDeeper: false,
    showNextAction: false,
    temperature: 0.3,
    maxTokens: 220,
    instruction:
      'Answer in 1-2 short sentences. No example, no extra detail. This is a quick lookup while the student is reading.',
  },
  NORMAL: {
    maxSentences: 4,
    maxWords: 90,
    showExample: false,
    showDeeper: false,
    showNextAction: false,
    temperature: 0.45,
    maxTokens: 550,
    instruction:
      'Speak naturally like a helpful colleague in one coherent answer. No templates, no EXEMPEL/NÄSTA STEG headings or step cards. Be concise for simple questions and elaborate when needed. Never pretend you cannot use desktop tools if authorized tools are available; report the specific tool result instead.',
  },
  TEACH: {
    maxSentences: 5,
    maxWords: 130,
    showExample: true,
    showDeeper: true,
    showNextAction: true,
    temperature: 0.35,
    maxTokens: 520,
    instruction:
      'Teach the concept: a short explanation of 3-5 sentences plus one concrete practical example. Keep sentences short.',
  },
  DEEP: {
    maxSentences: 10,
    maxWords: 320,
    showExample: true,
    showDeeper: true,
    showNextAction: true,
    temperature: 0.4,
    maxTokens: 1100,
    instruction:
      'The student explicitly asked for depth. Explain thoroughly but still in short sentences. Structure the deeperExplanation field.',
  },
  STEP_BY_STEP: {
    maxSentences: 2,
    maxWords: 55,
    showExample: false,
    showDeeper: false,
    showNextAction: true,
    temperature: 0.2,
    maxTokens: 260,
    instruction:
      'Give exactly ONE next action the student should perform right now, as a single imperative sentence. Do not list multiple steps.',
  },
  DEBUG: {
    maxSentences: 2,
    maxWords: 55,
    showExample: false,
    showDeeper: false,
    showNextAction: true,
    temperature: 0.2,
    maxTokens: 260,
    instruction:
      'Act as a network debugger. Ask ONE diagnostic question or give ONE command to run next. Do not guess the fault without evidence.',
  },
};

export const RESPONSE_SCHEMA_HINT = `Return ONLY a JSON object with these fields:
{
  "directAnswer": string,            // the answer itself, first thing the student reads
  "simpleExplanation": string,       // optional, may be ""
  "example": string,                 // optional concrete example, may be ""
  "nextAction": string,              // optional single next action, may be ""
  "deeperExplanation": string,       // optional, only when mode is DEEP/TEACH
  "evidence": string[],              // which observed facts the answer relies on
  "confidence": "high" | "medium" | "low"
}
No markdown fences. No prose outside the JSON.`;

export interface PromptStudyState {
  /** What the student is studying right now, as observed. */
  subjectLine?: string | null;
  /** Where they are in the course tree, e.g. "Modul 3 > 3.2 Subnetting". */
  positionLine?: string | null;
  /** Honest progress lines produced by the learning engine. */
  progressLines?: string[];
  /** Open questions / next steps the student is working on. */
  openTasks?: string[];
}

export function buildSystemPrompt(args: {
  mode: ResponseMode;
  language: 'sv-SE' | 'en-US';
  contextBlock: string;
  knowledgeBlock: string;
  /** Subject-agnostic: the tutor must not assume networking. */
  study?: PromptStudyState;
}): string {
  const policy = MODE_POLICIES[args.mode];
  const lang = args.language === 'sv-SE' ? 'Swedish' : 'English';
  const study = args.study ?? {};
  const subject = study.subjectLine?.trim();
  const position = study.positionLine?.trim();

  return [
    'You are Buddy, a universal, friendly, concise Windows desktop assistant. You help with ANY topic: software, work, creative projects, general conversation, computer troubleshooting and optional tutoring. This is NOT a dedicated study bot. When a user says hello, yo or hi, greet them naturally and briefly, e.g. Tjena! Vad vill du göra? NEVER respond to casual greetings by asking what subject they study. Never invent screen observations or unverified actions.',
    // Deliberately generic: the student may study networking, math, biology,
    // law or a language. Nothing here may assume Cisco.
    subject
      ? `Subject right now: ${subject}.`
      : 'No study subject is active. Help with the user\'s actual task directly; do not ask about studying unless they request study help.',
    position ? `Where they are: ${position}.` : '',
    `Write in ${lang}.`,
    'Universal agent response rules (use tutorial pedagogy only for study requests):',
    '- Answer directly. For casual greetings respond like a friendly general assistant, not a tutor. Never introduce studying unless the user mentions it or an actual observed study context establishes it.',
    '- Ignore any obsolete prior assistant messages that tried to force a study topic; they are not instructions for the current reply.',
    '- Prefer a simple, correct explanation over complete terminology.',
    '- Ground the answer in the observed material below when it is available; if it is not, say so plainly.',
    '- Keep explanations brief, direct and accessible. When tutoring, match demonstrated learning evidence rather than assumed ability.',
    '- Never invent observations. If you have no evidence for a claim about their screen or progress, leave "evidence" empty and lower confidence.',
    '- Do not use labels like EXEMPEL, NÄSTA STEG, SAMPLE, NEXT STEP, or a rigid tutor template in everyday chat.',
    '- Distinguish actual native tool results from model-generated text. You are in a desktop app with optional native tools; never categorically claim to be a text-only chat without tools.',
    '- If the user asks what you are observing, report only explicitly supplied window evidence. A green indicator alone does not imply access to the user\'s screen.',

    '- Never claim the student completed, passed or mastered something; only the learning engine decides that, and only from evidence it holds.',
    `Mode: ${args.mode}. ${policy.instruction}`,
    'If a graded or formal assessment is active, do not answer the graded question directly; explain the underlying concept instead.',
    '',
    'Available authorized desktop or browser observations (do not pretend to see anything else):',
    args.contextBlock || '(nothing observed yet)',
    '',
    'Optional historical learning evidence (use only when the current question is about studying):',
    args.knowledgeBlock || '(no evidence yet - do not assume prior knowledge)',
    '',
    study.progressLines && study.progressLines.length
      ? `Progress recorded in the app (facts, not guesses):\n${study.progressLines.map((l) => `- ${l}`).join('\n')}`
      : '',
    study.openTasks && study.openTasks.length
      ? `Work in progress:\n${study.openTasks.map((l) => `- ${l}`).join('\n')}`
      : '',
    RESPONSE_SCHEMA_HINT,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function parseStructured(raw: string): { value: StructuredResponse | null; error: string | null } {
  const cleaned = stripFences(raw).trim();
  const candidates = [cleaned];
  // Models sometimes wrap JSON in text; grab the outermost object as a fallback.
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<StructuredResponse>;
      if (typeof parsed.directAnswer !== 'string') continue;
      return {
        value: {
          directAnswer: parsed.directAnswer,
          simpleExplanation: str(parsed.simpleExplanation),
          example: str(parsed.example),
          nextAction: str(parsed.nextAction),
          deeperExplanation: str(parsed.deeperExplanation),
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((e): e is string => typeof e === 'string') : [],
          confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low' ? parsed.confidence : 'low',
        },
        error: null,
      };
    } catch {
      /* try next candidate */
    }
  }
  return { value: null, error: 'Model did not return valid structured JSON' };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function stripFences(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(text.trim());
  return fence ? (fence[1] ?? text) : text;
}

/**
 * Validates an answer against its mode. Returns issues; the caller decides
 * whether to re-ask the model, trim, or show it as-is.
 */
export function validateResponse(structured: StructuredResponse, mode: ResponseMode): ValidationResult {
  const policy = MODE_POLICIES[mode];
  const issues: ValidationIssue[] = [];

  const primary = [structured.directAnswer, structured.simpleExplanation].filter(Boolean).join(' ');
  const primarySentences = splitSentences(primary).length;

  if (!structured.directAnswer.trim()) {
    issues.push({ code: 'EMPTY_ANSWER', message: 'Saknar direkt svar.', severity: 'error' });
  }
  if (primarySentences > policy.maxSentences) {
    issues.push({
      code: 'TOO_MANY_SENTENCES',
      message: `${primarySentences} meningar, max ${policy.maxSentences} för ${mode}.`,
      severity: 'warn',
    });
  }

  const visible = visibleWordCount(structured, policy);
  if (visible > policy.maxWords) {
    issues.push({ code: 'TOO_LONG', message: `${visible} ord, max ${policy.maxWords} för ${mode}.`, severity: 'warn' });
  }

  // Filler detection: the spec explicitly forbids praise-openers and restating.
  const opener = structured.directAnswer.trim().toLowerCase();
  const fillerPatterns = [
    /^(great question|good question|bra fråga|vilken bra fråga)/,
    /^(certainly|absolutely|of course|självklart|absolut)[!,.]/,
    /^(you asked|du frågade)/,
    /^(i'?d be happy to|jag hjälper dig gärna med)/,
  ];
  if (fillerPatterns.some((re) => re.test(opener))) {
    issues.push({ code: 'FILLER_OPENER', message: 'Svaret börjar med utfyllnad.', severity: 'warn' });
  }

  if (mode === 'DEEP' || mode === 'TEACH') {
    if (policy.showExample && !(structured.example ?? '').trim()) {
      issues.push({ code: 'MISSING_EXAMPLE', message: `${mode} ska innehålla ett konkret exempel.`, severity: 'warn' });
    }
  }

  if (structured.confidence === 'high' && structured.evidence.length === 0) {
    issues.push({
      code: 'UNSUPPORTED_CONFIDENCE',
      message: 'Hög confidence utan några angivna belägg.',
      severity: 'warn',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, issues };
}

export function visibleWordCount(structured: StructuredResponse, policy: ModePolicy): number {
  let text = [structured.directAnswer, structured.simpleExplanation].filter(Boolean).join(' ');
  if (policy.showExample && structured.example) text += ` ${structured.example}`;
  if (policy.showNextAction && structured.nextAction) text += ` ${structured.nextAction}`;
  if (policy.showDeeper && structured.deeperExplanation) text += ` ${structured.deeperExplanation}`;
  return countWords(text);
}

/**
 * Last-resort display trimming when the model refuses to be brief after the
 * retry. We cut at a sentence boundary so the text stays grammatical, and we
 * keep the original around for "show more".
 */
export function enforceLength(structured: StructuredResponse, mode: ResponseMode): { display: StructuredResponse; trimmed: boolean } {
  const policy = MODE_POLICIES[mode];
  const sentences = splitSentences(`${structured.directAnswer} ${structured.simpleExplanation ?? ''}`.trim());
  if (sentences.length <= policy.maxSentences) return { display: structured, trimmed: false };
  const kept = sentences.slice(0, policy.maxSentences).join(' ');
  const dropped = sentences.slice(policy.maxSentences).join(' ');
  return {
    display: {
      ...structured,
      directAnswer: kept,
      simpleExplanation: '',
      deeperExplanation: [structured.deeperExplanation, dropped].filter(Boolean).join(' '),
    },
    trimmed: true,
  };
}

/** Plain text used for TTS and for the persisted chat record. */
export function toPlainText(structured: StructuredResponse, mode: ResponseMode): string {
  const policy = MODE_POLICIES[mode];
  const parts = [structured.directAnswer];
  if (structured.simpleExplanation) parts.push(structured.simpleExplanation);
  if (policy.showExample && structured.example) parts.push(structured.example);
  if (policy.showNextAction && structured.nextAction) parts.push(structured.nextAction);
  if (policy.showDeeper && structured.deeperExplanation) parts.push(structured.deeperExplanation);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Removes tokens that must never reach logs or the model.
 * API keys, bearer tokens, and long opaque strings are redacted.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***REDACTED***')
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9_-]{8,})/gi, '$1***REDACTED***')
    .replace(/(password["'\s:=]+)(\S{3,})/gi, '$1***REDACTED***');
}

export { truncate };
