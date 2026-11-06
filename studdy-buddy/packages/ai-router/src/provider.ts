import type { ProviderConfig, ModelCapabilities } from '@studdy/shared';
import { requestOnce, TimeoutError, HttpError } from '@studdy/shared';

/**
 * Provider abstraction. We speak the OpenAI-compatible chat-completions
 * protocol, which DeepSeek, OpenRouter and most third-party gateways expose.
 * Nothing here assumes a vendor: the base URL and model id are configuration.
 */

export interface ChatMessagePayload {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatRequest {
  messages: ChatMessagePayload[];
  model: string;
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  tools?: unknown[];
  /** Ask for reasoning when the provider supports the OpenAI-compatible flag. */
  reasoning?: 'off' | 'auto' | 'deep';
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string;
  finishReason: string | null;
  raw: unknown;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: ChatUsage;
  error?: string;
}

export interface ProviderClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'auth' | 'rate_limit' | 'not_found' | 'bad_request' | 'server' | 'network' | 'unknown',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HttpError) {
    const kind =
      err.status === 401 || err.status === 403
        ? 'auth'
        : err.status === 404
          ? 'not_found'
          : err.status === 429
            ? 'rate_limit'
            : err.status === 400 || err.status === 422
              ? 'bad_request'
              : err.status >= 500
                ? 'server'
                : 'unknown';
    return new ProviderError(friendlyStatusMessage(kind, err.status, err.bodyText), kind, err.status);
  }
  if (err instanceof TimeoutError) return new ProviderError(err.message, 'network');
  return new ProviderError(err instanceof Error ? err.message : String(err), 'network');
}

function friendlyStatusMessage(kind: string, status: number, body: string): string {
  const snippet = body.slice(0, 400);
  switch (kind) {
    case 'auth':
      return `The provider rejected the API key (HTTP ${status}). Check the key and that it has access to this model. ${snippet}`;
    case 'not_found':
      return `The provider does not know this endpoint or model (HTTP 404). Check base URL and model id. ${snippet}`;
    case 'rate_limit':
      return `Rate limited by the provider (HTTP 429). ${snippet}`;
    case 'bad_request':
      return `The provider rejected the request (HTTP ${status}). ${snippet}`;
    case 'server':
      return `The provider had a server error (HTTP ${status}). ${snippet}`;
    default:
      return `HTTP ${status}: ${snippet}`;
  }
}

export class OpenAiCompatibleClient {
  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string | null,
    private readonly options: ProviderClientOptions = {},
  ) {}

  private endpoint(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private body(request: ChatRequest): string {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.jsonMode) payload.response_format = { type: 'json_object' };
    if (request.tools) payload.tools = request.tools;
    // Generic OpenAI-compatible gateways do not consistently implement
    // reasoning_effort. The model can still reason from the prompt, but sending
    // an unsupported vendor-specific parameter produces HTTP 400 (Kilo, etc.).
    // Only add capability-specific parameters after an explicit provider probe.
    void request.reasoning;
    return JSON.stringify(payload);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    try {
      const res = await requestOnce(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: this.body(request),
        timeoutMs: this.options.timeoutMs ?? 60_000,
        signal: request.signal,
        fetchImpl: this.options.fetchImpl,
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text, this.endpoint('/chat/completions'));
      let json: OpenAiChatResponse;
      try {
        json = JSON.parse(text) as OpenAiChatResponse;
      } catch {
        throw new ProviderError(`Provider returned non-JSON: ${text.slice(0, 200)}`, 'unknown');
      }
      if (json.error) throw new ProviderError(json.error.message ?? 'Unknown provider error', 'bad_request');

      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? '';
      return {
        text: content ?? '',
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? estimateTokens(request.messages),
          outputTokens: json.usage?.completion_tokens ?? estimateTokens([{ role: 'assistant', content }]),
        },
        model: json.model ?? request.model,
        finishReason: choice?.finish_reason ?? null,
        raw: json,
      };
    } catch (err) {
      throw classify(err);
    }
  }

  /** Streams SSE deltas. Yields partial text as it arrives. */
  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    let res: Response;
    try {
      res = await requestOnce(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...(JSON.parse(this.body(request)) as object), stream: true, stream_options: { include_usage: true } }),
        timeoutMs: this.options.timeoutMs ?? 120_000,
        signal: request.signal,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (err) {
      throw classify(err);
    }
    if (!res.ok) {
      const text = await res.text();
      throw classify(new HttpError(res.status, text, 'stream'));
    }
    if (!res.body) throw new ProviderError('Provider returned an empty stream body', 'unknown');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: ChatUsage | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            yield { delta: '', done: true, usage };
            return;
          }
          try {
            const parsed = JSON.parse(data) as OpenAiChatResponse & { usage?: { prompt_tokens?: number; completion_tokens?: number } };
            if (parsed.usage) {
              usage = {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield { delta, done: false };
          } catch {
            // Ignore keep-alive fragments; providers occasionally send bare colons.
          }
        }
      }
      yield { delta: '', done: true, usage };
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Live capability probing. We never assume a capability from the model name.
   */
  async probeCapabilities(clock: () => number = Date.now): Promise<ModelCapabilities> {
    const caps: ModelCapabilities = {
      text: false,
      streaming: false,
      vision: false,
      json: false,
      tools: false,
      contextTokens: null,
      testedAt: new Date(clock()).toISOString(),
    };

    // 1. text
    try {
      const res = await this.chat({
        model: this.config.modelId,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 8,
        temperature: 0,
      });
      caps.text = res.text.length >= 0 && res.finishReason !== null;
    } catch (err) {
      // Auth/not-found failures mean nothing else will work; surface immediately.
      if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'not_found')) throw err;
    }

    // 2. streaming
    try {
      let chunks = 0;
      for await (const chunk of this.stream({
        model: this.config.modelId,
        messages: [{ role: 'user', content: 'Count 1 to 3.' }],
        maxTokens: 16,
      })) {
        if (chunk.delta) chunks += 1;
        if (chunks >= 2) break;
      }
      caps.streaming = chunks > 0;
    } catch {
      caps.streaming = false;
    }

    // 3. JSON mode
    try {
      const res = await this.chat({
        model: this.config.modelId,
        messages: [{ role: 'user', content: 'Return JSON: {"ok": true}' }],
        maxTokens: 32,
        temperature: 0,
        jsonMode: true,
      });
      const parsed = JSON.parse(res.text.trim()) as unknown;
      caps.json = typeof parsed === 'object' && parsed !== null;
    } catch {
      caps.json = false;
    }

    // 4. vision - only when the student configured a vision model explicitly.
    if (this.config.visionModelId) {
      try {
        const res = await this.chat({
          model: this.config.visionModelId,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What single colour fills this image? One word.' },
                {
                  type: 'image_url',
                  image_url: {
                    // 1x1 red PNG, inlined so the probe needs no network fetch of an asset.
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                  },
                },
              ],
            },
          ],
          maxTokens: 16,
          temperature: 0,
        });
        caps.vision = res.text.trim().length > 0;
      } catch {
        caps.vision = false;
      }
    }

    // 5. tool calling - a declared tool that must produce a tool_call.
    try {
      const body = JSON.stringify({
        model: this.config.modelId,
        max_tokens: 128,
        temperature: 0,
        messages: [{ role: 'user', content: 'Call the ping tool for host 10.0.0.1.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Ping a host',
              parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
            },
          },
        ],
      });
      const res = await requestOnce(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body,
        timeoutMs: 30_000,
        fetchImpl: this.options.fetchImpl,
      });
      if (res.ok) {
        const json = (await res.json()) as { choices?: { message?: { tool_calls?: unknown[] } }[] };
        caps.tools = (json.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0;
      }
    } catch {
      caps.tools = false;
    }

    return caps;
  }
}

/** Cheap heuristic used only when the provider omits usage numbers. */
export function estimateTokens(messages: ChatMessagePayload[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else chars += m.content.reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : 80), 0);
  }
  return Math.ceil(chars / 4);
}

export function estimateCost(usage: ChatUsage, config: ProviderConfig): number {
  return (usage.inputTokens / 1_000_000) * config.inputCostPerMTok + (usage.outputTokens / 1_000_000) * config.outputCostPerMTok;
}
