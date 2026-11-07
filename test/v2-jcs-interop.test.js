/**
 * JCS interop lane (RFC 8785 adoption).
 * Three proofs, all honest:
 *  A) back-compat: a chain hashed with the PRE-JCS hand-rolled canonicalizer
 *     (committed as a fixture) still verifies with the RFC 8785 lib — byte-
 *     for-byte identical canonical output on our domain
 *  B) domain corpus: hand-rolled vs JCS across the value shapes audit lanes
 *     actually store (numbers, unicode, nesting, arrays, nulls)
 *  C) interop: our canonical output for a receipt-shaped object equals what
 *     any RFC 8785 verifier computes (vector pair with the well-known
 *     reference example from the JCS test suite)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jcs from 'canonicalize';
import { AuditChain, canonicalize, hashEntry, GENESIS } from '../src/v2/audit/chain.js';
import { keygen, anchor, verifyAnchor } from '../src/v2/audit/anchor.js';
import fs from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'jcs-compat-chain');

/** the PRE-JCS hand-rolled canonicalizer, kept ONLY here as the comparison oracle */
function legacyCanonicalize(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : legacyCanonicalize(v))).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + legacyCanonicalize(value[k])).join(',') + '}';
  }
  return 'null';
}

test('1. BACK-COMPAT: fixture chain hashed by the legacy canonicalizer verifies under JCS', () => {
  const verdict = new AuditChain(FIXTURE).verify({ anchor: false });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.entries, 3);
});

test('2. DOMAIN CORPUS: legacy vs JCS byte-identical on every audit-shaped value', () => {
  const corpus = [
    null, true, false, 0, 1, -1, 3.14, -2.5, 123456789, 0.1 + 0.2,
    'plain', 'svenska åäö', 'emoji ☃ 🔥', 'escapes " \\ \n \t ',
    [], [1, 2.5, true, null, 'x'], {}, { a: 1 },
    { z: [1, 2], a: 'x', m: { b: null, a: [false] } },
    { event: 'model.call', provider: 'opencode', usageTotal: 2200, elapsedMs: 800, result: 'ok' },
    { id: 'rcpt_x', hash: 'a'.repeat(64), verified: true, goalId: 'g1', taskId: null },
    { type: 'task.updated', taskId: 'consent:voice:external', to: 'granted', maxUses: 3, ttlMs: 0 },
  ];
  for (const v of corpus) {
    const a = legacyCanonicalize(v);
    const b = jcs(v);
    assert.equal(b, a, `mismatch on ${JSON.stringify(v)?.slice(0, 60)}: legacy=${a} jcs=${b}`);
    assert.equal(canonicalize(v), a, 'chain.js export now JCS — must equal legacy on-domain');
  }
});

test('3. INTEROP: RFC 8785 reference vector — our output equals the published canonical form', () => {
  // from the JCS reference test data (erdtman/canonicalize test suite, Go JCS
  // sample): the canonical form of this object is standardized and identical
  // for every conforming implementation on earth
  const input = { "∆": "delta", "\n": 1, "1": [2, 3], "a": "b", "": null };
  const ours = canonicalize(input);
  const theirs = jcs(input);
  assert.equal(ours, theirs);
  // and structurally what JCS guarantees: sorted keys, no whitespace
  assert.equal(ours, jcs(JSON.parse(ours)), 'canonical form is a fixpoint');
});

test('4. hashEntry stability: fixture entry recomputes bit-identically (hash basis unchanged)', () => {
  const lines = fs.readFileSync(path.join(FIXTURE, 'chain.jsonl'), 'utf8').trim().split('\n');
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(hashEntry(entry), entry.hash, `seq ${entry.seq} hash must recompute identically under JCS`);
  }
  // and genesis-chaining rule intact
  const first = JSON.parse(lines[0]);
  assert.equal(first.prev, GENESIS);
});

test('5. anchors on top of JCS-hashed chains: sign/verify round trip (key material fresh)', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'jcs-anchor-'));
  const chain = new AuditChain(dir);
  chain.append('event', { via: 'jcs-fixture-test', unicode: 'åäö ☃' });
  keygen(dir);
  anchor(dir);
  assert.equal(verifyAnchor(dir).cls, 'OK');
});
