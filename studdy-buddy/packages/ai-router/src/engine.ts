import type { ProviderConfig, ResponseMode, StructuredResponse, ValidationResult } from '@studdy/shared';
import { createId, seedless, truncate } from './internal.js';
import {
  MODE_POLICIES,
  buildSystemPrompt,
  type PromptStudyState,
  enforceLength,
  parseStructured,
  toPlainText,
  validateResponse,
} from './explanation.js';
import type { AiRouter } from './router.js';
import type { ChatMessagePayload } from './provider.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ExplainRequest {
  question: string;
  mode: ResponseMode;
  language: 'sv-SE' | 'en-US';
  /**
   * Previous turns of this session, oldest first. Trimmed by `MAX_HISTORY_TURNS`
   * and by a character budget: memory is not "send the whole transcript".
   */
  history?: ConversationTurn[];
  /** Facts about the student's recorded progress, from the learning engine. */
  study?: PromptStudyState;
  /** Facts gathered locally by the observation layer. */
  contextFacts: string[];
  /** Description of the student's current knowledge, from the learning engine. */
  knowledgeFacts: string[];
  assessmentMode?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface ExplainResult {
  structured: StructuredResponse;
  plainText: string;
  validation: ValidationResult;
  trimmed: boolean;
  attempts: number;
  /** True when we fell back to a safe local message because the provider failed. */
  degraded: boolean;
  error: string | null;
}

/**
 * Hard cap on remembered turns. Ten turns of context is enough to keep a study
 * conversation coherent, and it bounds both the token bill and the chance that
 * the model confuses an old topic with the current one.
 */
export const MAX_HISTORY_TURNS = 10;
/** Character budget for remembered turns; older turns are dropped first. */
export const MAX_HISTORY_CHARS = 4000;

/**
 * Turns a stored transcript into model messages.
 *
 * When the budget is exceeded the *oldest* turns are dropped, because the most
 * recent exchange is what the student is continuing. A dropped turn leaves a
 * marker so the model knows memory is partial instead of silently hallucinating
 * continuity.
 */
export function toHistoryMessages(
  history: ConversationTurn[] | undefined,
  options: { maxTurns?: number; maxChars?: number } = {},
): ChatMessagePayload[] {
  if (!history || history.length === 0) return [];
  const maxTurns = options.maxTurns ?? MAX_HISTORY_TURNS;
  const maxChars = options.maxChars ?? MAX_HISTORY_CHARS;

  const recent = history.slice(-maxTurns);
  const kept: ChatMessagePayload[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn) continue;
    const text = turn.text.trim();
    if (!text) continue;
    if (used + text.length > maxChars) break;
    used += text.length;
    kept.unshift({ role: turn.role, content: truncate(text, 1200) });
  }

  const dropped = recent.length - kept.length;
  if (dropped > 0) {
    kept.unshift({
      role: 'system',
      content: `(${dropped} earlier turn(s) in this session were dropped for length. Do not assume you remember them.)`,
    });
  }
  return kept;
}

/**
 * Removes a trailing turn that is the same text as the question about to be sent.
 *
 * Callers persist the student's message *before* asking (so a crash cannot lose
 * it). That turn is then already in the history. Without this guard the model
 * receives the question twice, which biases it toward answering twice.
 */
export function dedupeTrailingQuestion(
  history: ConversationTurn[] | undefined,
  question: string,
): ConversationTurn[] {
  if (!history || history.length === 0) return history ?? [];
  const last = history[history.length - 1];
  if (last && last.role === 'user' && last.text.trim() === question.trim()) return history.slice(0, -1);
  return history;
}

/**
 * The explanation engine: prompt -> structured answer -> validation -> (retry)
 * -> length enforcement -> presentation payload.
 */
export class ExplanationEngine {
  constructor(private readonly router: AiRouter) {}

  async explain(provider: ProviderConfig, request: ExplainRequest): Promise<ExplainResult> {
    const policy = MODE_POLICIES[request.mode];
    // `history` may already contain the student's current message (services.ts
    // persists it before asking). Sending it twice makes the model answer as if
    // it had been asked twice, so drop a trailing exact duplicate.
    const history = dedupeTrailingQuestion(request.history, request.question);
    const messages: ChatMessagePayload[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          mode: request.mode,
          language: request.language,
          contextBlock: request.contextFacts.map((f) => `- ${f}`).join('\n'),
          knowledgeBlock: request.knowledgeFacts.map((f) => `- ${f}`).join('\n'),
          study: request.study,
        }),
      },
      // Memory: the actual previous turns of this session, budgets enforced.
      ...toHistoryMessages(history),
      { role: 'user', content: request.question },
    ];

    let attempts = 0;
    let lastStructured: StructuredResponse | null = null;
    let lastValidation: ValidationResult = { ok: false, issues: [] };
    let lastError: string | null = null;

    // At most two attempts: one initial, one corrective. More than that burns
    // the student's budget for a cosmetic problem.
    for (let i = 0; i < 2; i += 1) {
      attempts += 1;
      try {
        const result = await this.router.complete(provider, {
          messages,
          maxTokens: policy.maxTokens,
          temperature: policy.temperature,
          jsonMode: true,
          task: request.mode === 'DEBUG' || request.mode === 'STEP_BY_STEP' ? 'troubleshoot' : 'explain',
          signal: request.signal,
          cacheable: true,
        });
        if (request.onDelta) request.onDelta(result.text);

        const parsed = parseStructured(result.text);
        if (!parsed.value) {
          lastError = parsed.error;
          messages.push({ role: 'assistant', content: result.text });
          messages.push({
            role: 'user',
            content: `That was not valid JSON. Return ONLY the JSON object described earlier. ${parsed.error ?? ''}`,
          });
          continue;
        }

        lastStructured = parsed.value;
        lastValidation = validateResponse(parsed.value, request.mode);

        const hasWarn = lastValidation.issues.some((issue) => issue.severity === 'warn');
        if (!hasWarn) break;

        // Ask for a tighter version once, then accept and trim locally.
        messages.push({ role: 'assistant', content: JSON.stringify(parsed.value) });
        messages.push({
          role: 'user',
          content: `Too long or slightly off for mode ${request.mode} (${lastValidation.issues
            .map((issue) => issue.message)
            .join('; ')}). Rewrite the same answer, shorter, keeping it factually identical.`,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        break; // provider/network errors are not fixed by re-prompting
      }
    }

    if (!lastStructured) {
      const fallback: StructuredResponse = {
        directAnswer:
          request.language === 'sv-SE'
            ? 'AI-anslutningen fungerar inte just nu. Kontrollera API-nyckel och modell i Inställningar.'
            : 'AI is unavailable right now. Check the API key and model in Settings.',
        evidence: [],
        confidence: 'low',
      };
      return {
        structured: fallback,
        plainText: fallback.directAnswer,
        validation: { ok: false, issues: [] },
        trimmed: false,
        attempts,
        degraded: true,
        error: lastError,
      };
    }

    const { display, trimmed } = enforceLength(lastStructured, request.mode);
    return {
      structured: display,
      plainText: toPlainText(display, request.mode),
      validation: lastValidation,
      trimmed,
      attempts,
      degraded: false,
      error: null,
    };
  }

  /** Streaming variant for the chat bubble; the renderer shows raw text and then swaps in the parsed view. */
  async streamPlain(provider: ProviderConfig, request: ExplainRequest): Promise<{ text: string; error: string | null }> {
    const policy = MODE_POLICIES[request.mode];
    let text = '';
    try {
      for await (const chunk of this.router.stream(provider, {
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              mode: request.mode,
              language: request.language,
              contextBlock: request.contextFacts.map((f) => `- ${f}`).join('\n'),
              knowledgeBlock: request.knowledgeFacts.map((f) => `- ${f}`).join('\n'),
              study: request.study,
            }),
          },
          ...toHistoryMessages(dedupeTrailingQuestion(request.history, request.question)),
          { role: 'user', content: request.question },
        ],
        maxTokens: policy.maxTokens,
        temperature: policy.temperature,
        task: 'explain',
        signal: request.signal,
      })) {
        if (chunk.delta) {
          text += chunk.delta;
          request.onDelta?.(chunk.delta);
        }
      }
      const parsed = parseStructured(text);
      return { text: parsed.value ? toPlainText(parsed.value, request.mode) : truncate(text, 4000), error: null };
    } catch (err) {
      return { text, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Deterministic id for a question, used to dedupe identical asks within a session. */
export function questionKey(question: string, mode: ResponseMode): string {
  return seedless(`${mode}:${question.trim().toLowerCase()}`);
}

export { createId };
