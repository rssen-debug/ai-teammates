/**
 * MAJIN V4 — pairing, sessions, cookies.
 *
 * The private release is single-owner: one pairing code is generated on first
 * boot, shown once on the host console, and exchanged for a signed, server-side
 * session. Sessions survive a host restart (the brief requires that) and can be
 * revoked individually. The code is never stored in plaintext.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LENGTH = 8;

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd=fs.openSync(tmp,'wx',0o600);
    try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,file);
  } finally {try{fs.unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  try {
    fs.chmodSync(file, 0o600);
  } catch { /* best effort on filesystems without POSIX modes */ }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 32-byte HMAC key, created once with 0600. */
export function loadSecret(file) {
  const existing = (() => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  })();
  if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  writePrivate(file, secret);
  return secret;
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function formatCode(raw) {
  const s = String(raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return formatCode(out);
}

/**
 * Create the pairing record if missing. Returns the plaintext code ONLY on
 * creation or when `rotate` is true — a second call returns null.
 */
export function ensurePairing(file, secret, { rotate = false } = {}) {
  const current = readJson(file);
  if (current?.hash && !rotate) return null;
  const code = randomCode();
  writePrivate(file, JSON.stringify({
    v: 1,
    hash: hmac(secret, code),
    createdAt: new Date().toISOString(),
    rotatedAt: rotate ? new Date().toISOString() : null,
  }, null, 2));
  return code;
}

/** Constant-time check of a submitted pairing code. */
export function verifyPairing(file, secret, submitted) {
  const rec = readJson(file);
  if (!rec?.hash) return false;
  const normalized = formatCode(submitted);
  if (normalized.length !== CODE_LENGTH + 1) return false;
  return safeEqual(rec.hash, hmac(secret, normalized));
}

export function pairingExists(file) {
  return Boolean(readJson(file)?.hash);
}

/**
 * Server-side session store. Persisted as JSON so a host restart does not log
 * the phone out; deletion here is effective immediately.
 */
export class SessionStore {
  constructor({ file, secret, ttlMs, now = () => Date.now() }) {
    this.file = file;
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.now = now;
    const data = readJson(file);
    this.sessions = new Map(Object.entries(data?.sessions || {}));
    this.purge();
  }

  #persist() {
    writePrivate(this.file, JSON.stringify({
      v: 1,
      updatedAt: new Date(this.now()).toISOString(),
      sessions: Object.fromEntries(this.sessions),
    }, null, 2));
  }

  purge() {
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= this.now()) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.#persist();
    return changed;
  }

  create({ ip = null, userAgent = null } = {}) {
    const id = crypto.randomBytes(24).toString('base64url');
    const t = this.now();
    const session = {
      id,
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + this.ttlMs,
      ip,
      userAgent: userAgent ? String(userAgent).slice(0, 180) : null,
    };
    this.sessions.set(id, session);
    this.#persist();
    return { token: `${id}.${hmac(this.secret, id)}`, session };
  }

  /** Verify a cookie token against signature, existence and expiry. */
  verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const id = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!safeEqual(sig, hmac(this.secret, id))) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      this.#persist();
      return null;
    }
    return session;
  }

  touch(session, { extend = true } = {}) {
    if (!session) return;
    const t = this.now();
    session.lastSeenAt = t;
    if (extend) session.expiresAt = t + this.ttlMs;
    this.sessions.set(session.id, session);
    this.#persist();
  }

  revoke(tokenId) {
    const removed = this.sessions.delete(tokenId);
    if (removed) this.#persist();
    return removed;
  }

  revokeByToken(token) {
    if (typeof token !== 'string') return false;
    const id = token.slice(0, token.lastIndexOf('.'));
    return this.revoke(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: `${s.id.slice(0, 6)}…`,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
      userAgent: s.userAgent,
    }));
  }

  get size() {
    return this.sessions.size;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Cookie flags: HttpOnly always; Secure when the request is HTTPS. */
export function sessionCookie(name, token, { secure, maxAgeSeconds }) {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, { secure }) {
  return sessionCookie(name, '', { secure, maxAgeSeconds: 0 });
}
