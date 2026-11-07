/**
 * V2 audit anchors — signed checkpoints over the chain head.
 *
 * Why: the hash chain alone proves INTERNAL consistency. An attacker who
 * rewrites the WHOLE file (or swaps head.json along with it) produces a
 * self-consistent lie. The anchor closes that hole: the current head is
 * signed with an Ed25519 key whose private half lives in a 0600 file that
 * the operator can move/offline-copy — verification needs only the public
 * key, so a verifier never needs the secret.
 *
 * Prior art adopted as PATTERN (DEPENDENCIES log): stenslae/transparency-log
 * (checkpoint-per-append discipline), atc-audit (Ed25519 signed anchors,
 * key pair at install time), Padakan (HMAC with a local 0600 key — we choose
 * asymmetric so the verifier holds no secret). Rekor/public witnessing:
 * DEFERRED — submitting hashes to an external log is an external action,
 * owner-gated like all others.
 *
 * Honesty classes for verifyAnchor: OK | NO_ANCHOR (chain fine but nothing
 * anchored — INCONCLUSIVE about rewrite, never silently OK) | SIG_INVALID |
 * ANCHOR_MISMATCH | ANCHOR_BEHIND (new entries after the anchor; the anchor
 * is still valid for its range, so this is a WARNING not a break) |
 * CHAIN_BROKEN (the underlying chain fails first — anchors never override).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuditChain, HEAD_FILE, AUDIT_FILE, GENESIS, canonicalize } from './chain.js';
import { protectAuditFile } from './permissions.js';

export const ANCHOR_FILE = 'anchors.jsonl';
export const KEY_DIR = 'keys';
export const PRIV_FILE = 'ed25519.private.pem';
export const PUB_FILE = 'ed25519.public.pem';

export function keygen(dir) {
  const keyDir = path.join(dir, KEY_DIR);
  fs.mkdirSync(keyDir, { recursive: true });
  const priv = path.join(keyDir, PRIV_FILE);
  const pub = path.join(keyDir, PUB_FILE);
  if (fs.existsSync(priv)) return { created: false, pubPath: pub, note: 'key already exists — refusing to rotate silently (rotation is a decision, not a default)' };
  protectAuditFile(keyDir);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  protectAuditFile(priv);
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  return { created: true, pubPath: pub, fingerprint: pubFingerprint(pub) };
}

export function pubFingerprint(pubPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(pubPath)).digest('hex').slice(0, 16);
}

/**
 * anchor(dir): verify the chain first (never anchor a broken chain), then
 * append a signed checkpoint of the CURRENT head to anchors.jsonl.
 * Returns the frozen anchor record.
 */
export function anchor(dir) {
  const chain = new AuditChain(dir); // refuses FORK-tail extension, verifies reads fine
  const verdict = chain.verify({ anchor: false }); // anchor check here is OUR job, not chain.js's
  if (!verdict.ok) {
    const err = new Error(`refusing to anchor a broken chain: ${verdict.reason} at line ${verdict.brokenAt}`);
    err.cls = 'CHAIN_BROKEN';
    err.verdict = verdict;
    throw err;
  }
  const keyDir = path.join(dir, KEY_DIR);
  const privPath = path.join(keyDir, PRIV_FILE);
  const pubPath = path.join(keyDir, PUB_FILE);
  if (!fs.existsSync(privPath)) {
    const err = new Error('no signing key — run keygen first (anchors are deliberate, never implicit)');
    err.cls = 'KEY_MISSING';
    throw err;
  }
  const anchorFile = path.join(dir, ANCHOR_FILE);
  let prevAnchorHash = '0'.repeat(64);
  let aseq = 0;
  if (fs.existsSync(anchorFile)) {
    const last = fs.readFileSync(anchorFile, 'utf8').trim().split('\n').pop();
    const p = JSON.parse(last);
    prevAnchorHash = p.anchorHash;
    aseq = p.aseq;
  }
  const core = {
    aseq: aseq + 1,
    at: new Date().toISOString(),
    chainSeq: verdict.entries,
    chainHead: verdict.head,
    prevAnchorHash,
    fingerprint: pubFingerprint(pubPath),
  };
  const sig = crypto.sign(null, Buffer.from(canonicalize(core)), fs.readFileSync(privPath, 'utf8')).toString('base64');
  const record = { ...core, sig };
  record.anchorHash = crypto.createHash('sha256').update(prevAnchorHash + '\n' + canonicalize(core) + '\n' + sig).digest('hex');
  fs.appendFileSync(anchorFile, JSON.stringify(record) + '\n');
  return Object.freeze(record);
}

/**
 * verifyAnchor(dir): the honest verdict described in the header.
 * Needs ONLY the public key — the private key may (should) be elsewhere.
 */
export function verifyAnchor(dir) {
  const verdict = new AuditChain(dir).verify({ anchor: false });
  if (!verdict.ok) return { ok: false, cls: 'CHAIN_BROKEN', chain: verdict, detail: 'the underlying chain fails before anchors are even consulted' };
  const anchorFile = path.join(dir, ANCHOR_FILE);
  if (!fs.existsSync(anchorFile) || fs.readFileSync(anchorFile, 'utf8').trim() === '') {
    return { ok: true, cls: 'NO_ANCHOR', inconclusive: true, chain: verdict, detail: 'chain verified, no anchors exist — a full rewrite before this moment cannot be excluded' };
  }
  const pubPath = path.join(dir, KEY_DIR, PUB_FILE);
  if (!fs.existsSync(pubPath)) {
    const err = new Error('public key missing — cannot verify anchors (fetch the .pem the operator published)');
    err.cls = 'PUBKEY_MISSING';
    throw err;
  }
  const pub = fs.readFileSync(pubPath, 'utf8');
  const chainHeads=fs.existsSync(path.join(dir,AUDIT_FILE))?fs.readFileSync(path.join(dir,AUDIT_FILE),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).hash):[];
  const lines = fs.readFileSync(anchorFile, 'utf8').trim().split('\n');
  let prevAnchorHash = '0'.repeat(64);
  let latest = null;
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    const { sig, anchorHash, ...core } = rec;
    if (core.prevAnchorHash !== prevAnchorHash) {
      return { ok: false, cls: 'SIG_INVALID', chain: verdict, detail: `anchor ${i + 1}: prevAnchorHash link broken` };
    }
    if (!crypto.verify(null, Buffer.from(canonicalize(core)), pub, Buffer.from(sig, 'base64'))) {
      return { ok: false, cls: 'SIG_INVALID', chain: verdict, detail: `anchor ${i + 1}: signature does not verify against the public key` };
    }
    const want = crypto.createHash('sha256').update(prevAnchorHash + '\n' + canonicalize(core) + '\n' + sig).digest('hex');
    if (anchorHash !== want) return { ok: false, cls: 'SIG_INVALID', chain: verdict, detail: `anchor ${i + 1}: anchorHash recompute mismatch` };
    // A valid old signature must cover the actual prefix, even after new rows.
    const coveredHead=core.chainSeq===0?GENESIS:chainHeads[core.chainSeq-1];
    if(!Number.isSafeInteger(core.chainSeq)||core.chainSeq<0||core.chainHead!==coveredHead)return {ok:false,cls:'ANCHOR_MISMATCH',chain:verdict,detail:`anchor ${i+1}: signed head does not match the actual chain prefix — full rewrite detected`};
    prevAnchorHash = anchorHash;
    latest = rec;
  }
  if (latest.chainSeq < verdict.entries) {
    return { ok: true, cls: 'ANCHOR_BEHIND', warning: true, chain: verdict, anchor: latest, detail: `chain has ${verdict.entries - latest.chainSeq} entries after the last anchor — anchor valid for its range, re-anchor to extend` };
  }
  if (latest.chainSeq !== verdict.entries || latest.chainHead !== verdict.head) {
    return { ok: false, cls: 'ANCHOR_MISMATCH', chain: verdict, anchor: latest, detail: 'anchor covers a DIFFERENT chain state than what is on disk — full rewrite detected' };
  }
  return { ok: true, cls: 'OK', chain: verdict, anchor: latest, fingerprint: pubFingerprint(pubPath) };
}
