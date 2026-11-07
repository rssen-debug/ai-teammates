/**
 * MAJIN V6 — privacy filter for local events and optional private sync.
 *
 * Two different guarantees:
 *  - scrubEvent: keep the event useful but never persist secrets or full email
 *    bodies / verification links.
 *  - assertSyncSafe: hard refusal for a sync payload. Refusing to upload is
 *    always preferable to leaking a token, a CV, or a login link.
 */

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|session[_-]?id|refresh|access[_-]?token|client[_-]?secret|private[_-]?key|credential)/i;
const CONTENT_KEY = /(^|_)(body|bodytext|html|content|cv|coverletter|resume|attachment|link|verificationurl|reseturl)($|_)/i;
const EMAIL = /\b([A-Z0-9._%+-])([A-Z0-9._%+-]*)(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const BEARER = /\b(Bearer|Bot|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const URL_WITH_SECRET = /\bhttps?:\/\/[^\s"'<>]*[?&](token|code|key|sig|signature|auth|session)=[^\s"'<>]*/gi;

const MAX_STRING = 1200;
const MAX_ARRAY = 200;
const MAX_DEPTH = 8;

export function maskEmail(address) {
  return String(address).replace(EMAIL, (_match, first, rest, domain) => `${first}${'*'.repeat(Math.min(6, Math.max(2, rest.length)))}${domain}`);
}

function safeString(value) {
  let text = String(value);
  text = text.replace(BEARER, (match, scheme) => `${scheme} [REDACTED]`);
  text = text.replace(URL_WITH_SECRET, '[REDACTED_URL]');
  text = maskEmail(text);
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text;
}

/** Remove secrets/personal content while keeping operational shape. */
export function scrub(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: safeString(value.message), code: value.code || null };
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => scrub(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) { out[key] = '[REDACTED]'; continue; }
      if (CONTENT_KEY.test(key) && typeof item === 'string') { out[key] = `[OMITTED ${item.length} chars]`; continue; }
      out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  return safeString(value);
}

/** Keys and shapes that must never leave the owner's machine. */
const FORBIDDEN_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|refresh[_-]?token|client[_-]?secret|private[_-]?key|cvtext|coverletter|emailbody|email_body|rawbody|raw_body|verificationurl|verification_url|verificationlink|reseturl|session[_-]?id)/i;
const FORBIDDEN_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\b1\/\/[A-Za-z0-9_-]{20,}/,
  /https?:\/\/[^\s"']*[?&](token|code|key|sig|signature|auth)=/i,
];

export function findSyncViolations(value, trail = 'payload', depth = 0) {
  const violations = [];
  if (depth > 12) return [`${trail}: nesting too deep`];
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE) {
      if (pattern.test(value)) violations.push(`${trail}: forbidden secret/link pattern`);
    }
    return violations;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => violations.push(...findSyncViolations(item, `${trail}[${index}]`, depth + 1)));
    return violations;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) { violations.push(`${trail}.${key}: forbidden field`); continue; }
      violations.push(...findSyncViolations(item, `${trail}.${key}`, depth + 1));
    }
  }
  return violations;
}

export function assertSyncSafe(payload) {
  const violations = findSyncViolations(payload);
  if (violations.length) {
    throw Object.assign(new Error(`Refusing sync: payload contains private data (${violations.slice(0, 3).join('; ')})`), {
      code: 'SYNC_PRIVATE_DATA',
      violations,
    });
  }
  return true;
}
