/**
 * V2 audit chain (master brief: "every decision emitted lands in the audit
 * trail" — approvals.js already promises this; the EventBus ring buffer is
 * volatile and holds only 500 events; telemetry shards are plain JSONL and
 * can be silent-edited. This module upgrades them to a durable,
 * tamper-evident store).
 *
 * Design reused from public prior art (evaluated in
 * docs/v2/DEPENDENCIES_AND_LICENSES.md — no npm package adopted, +0 deps):
 *   hash = sha256(prevHash + "\n" + canonicalJSON(entry-without-hash))
 * - append-only chain.jsonl, one entry per line, fd O_APPEND + fsync,
 *   mode 0600 on create                (Cancore-io/sdk PR #115 discipline)
 * - seq strictly increasing, genesis prev = 64 zeros
 * - head.json anchor { seq, hash, at } written on every append so deleting
 *   the NEWEST lines is caught too, not only edits in the middle
 *   (tientran1234/audit-log guarantee)
 * - open recovers { seq, prev } from the last line; a file not ending in
 *   "\n" or whose last line cannot be recomputed is DAMAGED and the chain
 *   refuses to extend                        (Sundarban audit.py behaviour)
 * - verify() walks the whole chain and reports the FIRST broken line with a
 *   classified reason — nothing past a break can be judged
 *   (BasitS-hash/incident-response-agent PR #40 semantics)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { protectAuditFile } from './permissions.js';
import jcsCanonicalize from 'canonicalize'; // RFC 8785 JCS — the RFC author's own reference implementation (Apache-2.0)

export const GENESIS = '0'.repeat(64);
export const AUDIT_FILE = 'chain.jsonl';
export const HEAD_FILE = 'head.json';

/** Deterministic JSON for hashing — RFC 8785 (JCS) via the author's own
 *  reference lib. Bit-identical on our domain to the previous hand-rolled
 *  canonicalizer (proven by the fixture-chain test + the JCS corpus test),
 *  so EXISTING chains verify unchanged — and our hashes are now interoperable
 *  with the receipts ecosystem that standardized on JCS (askledger et al.).
 *  Keys sorted, no whitespace, ES number shortest-round-trip, JSON escaping. */
export function canonicalize(value) {
  // jcsCanonicalize returns undefined for undefined/functions — our domain
  // never produces them in auditable payloads; keep the old neutral answer.
  return jcsCanonicalize(value) ?? 'null';
}

export function hashEntry(entry) {
  const { seq, ts, kind, actor, payload, prev } = entry;
  const body = canonicalize({ seq, ts, kind, actor, payload });
  return crypto.createHash('sha256').update(prev + '\n' + body).digest('hex');
}

export class AuditChainError extends Error {
  constructor(cls, message) {
    super(message);
    this.cls = cls; // DAMAGED_LOG | HEAD_MISMATCH | FORK
  }
}

export class AuditChain {
  constructor(dir) {
    if (!dir) throw new Error('audit chain requires a directory');
    this.dir = dir;
    this.file = path.join(dir, AUDIT_FILE);
    this.headFile = path.join(dir, HEAD_FILE);
    fs.mkdirSync(dir, { recursive: true });
    this.#recover();
  }

  #recover() {
    this.seq = 0;
    this.prev = GENESIS;
    this.damaged = null;
    if (!fs.existsSync(this.file)) return;
    const buf = fs.readFileSync(this.file);
    if (buf.length === 0) return;
    if (buf[buf.length - 1] !== 0x0a) {
      this.damaged = 'file does not end with a complete line';
      return;
    }
    const text = buf.toString('utf8');
    const lines = text.trimEnd().split('\n');
    let last;
    try {
      last = JSON.parse(lines[lines.length - 1]);
    } catch {
      this.damaged = `last line ${lines.length} is not parseable JSON`;
      return;
    }
    // never extend a log whose last entry does not recompute (Sundarban rule)
    if (!last.hash || hashEntry(last) !== last.hash) {
      this.damaged = `last entry seq=${last.seq} fails hash recompute — refusing to extend`;
      return;
    }
    this.seq = last.seq;
    this.prev = last.hash;
    // fork guard: an anchor disagreeing with the recovered tail means
    // truncation/rewriting — verify() reports the full diagnosis, and
    // append() refuses to extend (the constructor must stay usable for reads)
    const anchor = this.#readHead();
    if (anchor && (anchor.seq !== this.seq || anchor.hash !== this.prev)) {
      this.anchorFork = `head.json anchor seq=${anchor.seq} disagrees with chain tail seq=${this.seq}`;
    }
  }

  #readHead() {
    try {
      return JSON.parse(fs.readFileSync(this.headFile, 'utf8'));
    } catch {
      return null;
    }
  }

  #writeHead(entry) {
    // tmp+rename so a crash mid-write never leaves a half anchor
    const tmp = this.headFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ seq: entry.seq, hash: entry.hash, at: entry.ts }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.headFile);
  }

  /**
   * append(kind, payload, { actor }): one fsynced line. Throws
   * AuditChainError(DAMAGED_LOG) if the on-disk tail is not trustworthy.
   */
  append(kind, payload = {}, { actor = 'system', ts } = {}) {
    if (!kind) throw new Error('audit entry requires a kind');
    if (this.damaged) throw new AuditChainError('DAMAGED_LOG', `audit chain damaged: ${this.damaged}`);
    if (this.anchorFork) throw new AuditChainError('FORK', `audit chain forked: ${this.anchorFork}`);
    const entry = {
      seq: this.seq + 1,
      ts: ts || new Date().toISOString(),
      kind,
      actor: String(actor).slice(0, 64),
      payload,
      prev: this.prev,
    };
    entry.hash = hashEntry(entry);
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      // Protect the empty/new file before writing sensitive audit payloads.
      if (process.platform !== 'win32' || !this.privateAclApplied) {
        protectAuditFile(this.file);
        this.privateAclApplied = true;
      }
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.#writeHead(entry);
    this.seq = entry.seq;
    this.prev = entry.hash;
    return Object.freeze({ ...entry });
  }

  /**
   * verify(): walk the whole chain from genesis. Returns
   *   { ok, entries, head, brokenAt?, reason?, detail? }
   * Reason classes: PARSE_ERROR | GENESIS_MISMATCH | SEQ_GAP | LINK_BROKEN |
   * HASH_MISMATCH | TRUNCATED | HEAD_MISMATCH | EMPTY (ok=false only when
   * something is provably wrong; EMPTY is ok=true with entries=0).
   */
  verify({ anchor = true } = {}) {
    if (!fs.existsSync(this.file)) return { ok: true, entries: 0, head: GENESIS, reason: 'EMPTY' };
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    let prev = GENESIS;
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        return { ok: false, entries: n, brokenAt: lineNo, reason: 'PARSE_ERROR', detail: 'line is not parseable JSON' };
      }
      n = lineNo;
      if (lineNo === 1 && entry.prev !== GENESIS) {
        return { ok: false, entries: n, brokenAt: lineNo, reason: 'GENESIS_MISMATCH', detail: 'first entry does not chain to genesis' };
      }
      if (entry.seq !== lineNo) {
        return { ok: false, entries: n, brokenAt: lineNo, reason: 'SEQ_GAP', detail: `expected seq ${lineNo}, got ${entry.seq}` };
      }
      if (entry.prev !== prev) {
        return { ok: false, entries: n, brokenAt: lineNo, reason: 'LINK_BROKEN', detail: 'prev hash does not match previous entry hash' };
      }
      if (hashEntry(entry) !== entry.hash) {
        return { ok: false, entries: n, brokenAt: lineNo, reason: 'HASH_MISMATCH', detail: 'entry content does not match its recorded hash' };
      }
      prev = entry.hash;
    }
    if (anchor) {
      const head = this.#readHead();
      if (head) {
        if (head.seq > n) return { ok: false, entries: n, brokenAt: n, reason: 'TRUNCATED', detail: `anchor seq=${head.seq} proves newer entries were deleted` };
        if (head.seq === n && head.hash !== prev) return { ok: false, entries: n, brokenAt: n, reason: 'HEAD_MISMATCH', detail: 'anchor hash disagrees with recomputed chain head' };
      }
    }
    return { ok: true, entries: n, head: prev };
  }
}
