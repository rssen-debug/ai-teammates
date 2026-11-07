/**
 * MAJIN V4 — request security primitives.
 *
 * The browser is an untrusted client. Every mutating request must pass all of:
 *   host allowlist -> origin allowlist -> CSRF header -> authenticated session.
 * Rate limits are per client key and per bucket; they are process-local state
 * that resets on restart (documented, not pretended to be distributed).
 */

export class HttpError extends Error {
  constructor(status, code, message, meta = null) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

/** Client key for rate limiting. Trust proxy headers only when configured. */
export function clientKey(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Match a hostname against an allowlist entry. An entry may be exact
 * ("majin.example.com") or a subdomain rule ("*.example.com"), which is how a
 * tunnel with rotating subdomains is allowed without allowing the whole world.
 * A wildcard never matches the bare apex of another domain: "*.example.com"
 * matches "a.example.com" but not "example.com" and not "evilexample.com".
 */
export function hostMatches(hostname, entry) {
  const host = String(hostname).toLowerCase();
  const rule = String(entry).toLowerCase().trim();
  if (!rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === rule;
}

/** Host header must be one we answer for, otherwise DNS rebinding applies. */
export function assertHostAllowed(req, config) {
  const raw = String(req.headers.host || '');
  const hostname = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new HttpError(400, 'HOST_MISSING', 'Host header is required.');
  if (config.publicOrigin) {
    try {
      if (new URL(config.publicOrigin).hostname.toLowerCase() === hostname) return hostname;
    } catch { /* fall through to allowlist */ }
  }
  for (const entry of config.allowedHosts) {
    if (hostMatches(hostname, entry)) return hostname;
  }
  throw new HttpError(403, 'HOST_REJECTED', 'This host header is not allowed.');
}

/**
 * Origin/Referer must match the host we are serving. A missing Origin is
 * accepted only for non-mutating requests (browsers always send Origin on
 * cross-site POST); the CSRF header requirement covers the rest.
 */
export function assertOriginAllowed(req, config, hostname) {
  const origin = req.headers.origin;
  if (!origin) {
    const referer = req.headers.referer;
    if (!referer) return;
    let refHost;
    try {
      refHost = new URL(referer).hostname.toLowerCase();
    } catch {
      throw new HttpError(403, 'ORIGIN_REJECTED', 'Malformed Referer.');
    }
    if (refHost !== hostname) throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed.');
    return;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'Malformed Origin.');
  }
  if (parsed.hostname.toLowerCase() !== hostname) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed.');
  }
}

/** Custom header requirement: a cross-site form can't set it without CORS. */
export function assertCsrfHeader(req) {
  const value = String(req.headers['x-majin-csrf'] || '');
  if (value !== '1') {
    throw new HttpError(403, 'CSRF_REQUIRED', 'Missing X-MAJIN-CSRF header.');
  }
}

/**
 * Sliding-window limiter.
 *
 * Bounded on purpose. The naive version (a Map keyed by client, never pruned)
 * grows for the lifetime of the process: on an always-on host behind a tunnel,
 * every distinct client address becomes a permanent entry. Two rules keep it
 * proportional to *active* clients:
 *   - expired buckets are swept before the table can grow past MAX_BUCKETS
 *   - if a burst of new clients still fills the table, the oldest buckets are
 *     dropped (they were about to expire anyway)
 * The clock is injectable so the sweep is tested deterministically.
 */
export class RateLimiter {
  static MAX_BUCKETS = 10_000;

  constructor({ windowMs = 60_000, limits = {}, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.limits = limits;
    this.now = now;
    this.buckets = new Map();
    this.sweeps = 0;
    this.lastSweep = 0;
  }

  /** Drop buckets whose newest hit is older than the window. */
  sweep(t = this.now()) {
    const cutoff = t - this.windowMs;
    let removed = 0;
    for (const [id, hits] of this.buckets) {
      const last = hits[hits.length - 1];
      if (!hits.length || last <= cutoff) {
        this.buckets.delete(id);
        removed += 1;
      }
    }
    if (removed) this.sweeps += 1;
    this.lastSweep = t;
    return removed;
  }

  /** Throws HttpError(429) when the bucket is exhausted; returns remaining. */
  take(bucket, key, cost = 1) {
    const max = this.limits[bucket];
    const id = `${bucket}:${key}`;
    const t = this.now();
    const cutoff = t - this.windowMs;

    // Sweep at most once per window: cheap, and it keeps the table proportional
    // to active clients instead of to every client that ever connected.
    if (t - this.lastSweep >= this.windowMs) this.sweep(t);

    // Sweep before inserting, so a flood of new keys cannot outrun the cleanup.
    if (!this.buckets.has(id) && this.buckets.size >= RateLimiter.MAX_BUCKETS) {
      this.sweep(t);
      // Still full: this is a genuine burst of distinct clients. Evict the
      // oldest-inserted entries; Map preserves insertion order.
      while (this.buckets.size >= RateLimiter.MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value;
        this.buckets.delete(oldest);
      }
    }

    const hits = (this.buckets.get(id) || []).filter((ts) => ts > cutoff);
    if (max != null && hits.length + cost > max) {
      const retryAfter = Math.max(1, Math.ceil((hits[0] + this.windowMs - t) / 1000));
      this.buckets.set(id, hits);
      throw new HttpError(429, 'RATE_LIMITED', `Too many requests. Retry in ${retryAfter}s.`, { retryAfter });
    }
    for (let i = 0; i < cost; i += 1) hits.push(t);
    this.buckets.set(id, hits);
    return max == null ? null : Math.max(0, max - hits.length);
  }

  reset() {
    this.buckets.clear();
  }
}

/** Reject request bodies larger than `maxBytes` before reading them. */
export function assertBodySize(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    assertBodySize(req, maxBytes);
    const chunks = [];
    let bytes = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (bytes === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'BAD_JSON', 'Request body must be a JSON object.'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}
