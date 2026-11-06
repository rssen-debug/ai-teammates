/**
 * Network helpers with the behaviours the spec demands: hard timeouts,
 * cancellation, exponential backoff with jitter, and never throwing a bare
 * string at the caller.
 */

export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Request timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${bodyText.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** HTTP statuses considered retryable. */
  retryStatuses: number[];
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
  retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
};

export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  retry?: Partial<RetryPolicy>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  /** Deterministic jitter for tests (0..1). */
  random?: () => number;
}

export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  // Full-ish jitter keeps thundering herds away from a shared provider.
  return Math.round(exp * (0.6 + random() * 0.4));
}

/**
 * Performs a request with timeout + retry. Streaming responses must NOT use
 * this (the body is consumed by the caller), see `requestOnce`.
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      const res = await requestOnce(url, options);
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text, url);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Expected JSON from ${url} but got: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      lastError = err;
      const retryable =
        (err instanceof HttpError && policy.retryStatuses.includes(err.status)) || err instanceof TimeoutError || isNetworkError(err);
      if (!retryable || attempt === policy.attempts - 1) break;
      await sleep(backoffDelay(attempt, policy, random));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function requestOnce(url: string, options: RequestOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (isAbortError(err)) {
      if (options.signal?.aborted) throw new Error('Request cancelled by user');
      throw new TimeoutError(timeoutMs);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  return Boolean(cause?.code) || /fetch failed|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(String((err as Error).message));
}

/**
 * Token bucket rate limiter. Deterministic clock injection keeps it testable.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until `count` tokens are available. */
  waitMs(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.refillPerSecond) * 1000);
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Minimal LRU used for response caching. */
export class LruCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.clock()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
