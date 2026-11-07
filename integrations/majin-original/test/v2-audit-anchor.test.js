/**
 * Audit anchor lane — signed external-witness checkpoints over the REAL chain.
 * The core attack tested honestly: a FULL rewrite of chain.jsonl (which the
 * inner walk alone cannot catch) must be caught by the anchor.
 */
import test from 'node:test';
import { privateFilePermissions } from '../src/v4/file-permissions.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuditChain } from '../src/v2/audit/chain.js';
import { keygen, anchor, verifyAnchor, pubFingerprint, KEY_DIR, PUB_FILE, PRIV_FILE } from '../src/v2/audit/anchor.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'majin-v2.mjs');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-anchor-')); }
const run = (args, cwd = REPO) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { cwd }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

test('a signed checkpoint detects a rewritten prefix even when the replacement chain has more rows',()=>{
  const dir=tmp(),replacement=tmp();
  const original=new AuditChain(dir);original.append('event',{real:true});keygen(dir);anchor(dir);
  const changed=new AuditChain(replacement);changed.append('event',{forged:true});changed.append('event',{padding:true});
  for(const file of ['chain.jsonl','head.json'])fs.copyFileSync(path.join(replacement,file),path.join(dir,file));
  assert.equal(new AuditChain(dir).verify().ok,true,'rewritten chain is internally consistent');
  const verdict=verifyAnchor(dir);assert.equal(verdict.ok,false);assert.equal(verdict.cls,'ANCHOR_MISMATCH');
});

test('1. keygen creates 0600 private key + public key; second run refuses silent rotation', () => {
  const dir = tmp();
  const r1 = keygen(dir);
  assert.equal(r1.created, true);
  assert.match(r1.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(privateFilePermissions(path.join(dir, KEY_DIR, PRIV_FILE)), true, 'signing key is private under POSIX modes or NTFS ACLs');
  const r2 = keygen(dir);
  assert.equal(r2.created, false, 'rotation is a decision, never a default');
});

test('2. full loop: append → anchor → verifyAnchor OK with fingerprint', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { phase: 'one' });
  chain.append('receipt', { id: 'rcpt_x' });
  keygen(dir);
  const rec = anchor(dir);
  assert.equal(rec.chainSeq, 2);
  assert.equal(rec.aseq, 1);
  const v = verifyAnchor(dir);
  assert.equal(v.cls, 'OK');
  assert.equal(v.fingerprint, pubFingerprint(path.join(dir, KEY_DIR, PUB_FILE)));
});

test('3. FULL REWRITE of everything incl. anchors → honest NO_ANCHOR, never a false OK', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { data: 'original-truth' });
  keygen(dir);
  anchor(dir);

  // attacker deletes EVERYTHING (chain + anchors + keys) and rebuilds a
  // complete, internally-valid forged chain
  fs.rmSync(dir, { recursive: true });
  const attacker = new AuditChain(dir);
  attacker.append('event', { data: 'forged-history' });

  // the forged chain passes its own inner walk — that is expected…
  assert.equal(new AuditChain(dir).verify({ anchor: false }).ok, true);
  // …but anchor verification must NOT claim OK: witnesses are gone, so the
  // honest answer is inconclusive. Detection of the rewrite itself is covered
  // by the stronger cases (anchors survive: tests 4/8).
  const v = verifyAnchor(dir);
  assert.equal(v.cls, 'NO_ANCHOR');
  assert.equal(v.inconclusive, true);
  assert.match(v.detail, /cannot be excluded/);
});;

test('4. rewrite with pubkey present → ANCHOR_MISMATCH (the real attack with witnesses in place)', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { data: 'original-truth' });
  keygen(dir);
  anchor(dir);
  // operator keeps the public key separately (the whole point) — attacker cannot forge it
  const pub = fs.readFileSync(path.join(dir, KEY_DIR, PUB_FILE), 'utf8');
  const forged = tmp();
  const attacker = new AuditChain(forged);
  attacker.append('event', { data: 'forged-history' });
  fs.mkdirSync(path.join(forged, KEY_DIR), { recursive: true });
  fs.writeFileSync(path.join(forged, KEY_DIR, PUB_FILE), pub); // witnesses stay honest
  // transplant the attacker's forged anchors.jsonl? no — attacker cannot sign; leave original anchors out
  fs.copyFileSync(path.join(dir, 'anchors.jsonl'), path.join(forged, 'anchors.jsonl'));
  const v = verifyAnchor(forged);
  assert.equal(v.cls, 'ANCHOR_MISMATCH');
  assert.match(v.detail, /full rewrite detected/);
});

test('5. signature tampering on one anchor line → SIG_INVALID naming the line', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { i: 1 });
  keygen(dir);
  anchor(dir);
  chain.append('event', { i: 2 });
  anchor(dir);
  const file = path.join(dir, 'anchors.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.chainHead = rec.chainHead.slice(0, 8) + 'f'.repeat(56);
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = verifyAnchor(dir);
  assert.equal(v.cls, 'SIG_INVALID');
  assert.match(v.detail, /anchor 1/);
});

test('6. no anchors → honest NO_ANCHOR (chain fine, rewrite inconclusive — never silent OK)', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { i: 1 });
  const v = verifyAnchor(dir);
  assert.equal(v.ok, true);
  assert.equal(v.cls, 'NO_ANCHOR');
  assert.equal(v.inconclusive, true);
  assert.match(v.detail, /cannot be excluded/);
});

test('7. new entries after the anchor → ANCHOR_BEHIND warning (valid for its range, no panic)', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { i: 1 });
  keygen(dir);
  anchor(dir);
  const reopened = new AuditChain(dir);
  reopened.append('event', { i: 2 });
  const v = verifyAnchor(dir);
  assert.equal(v.cls, 'ANCHOR_BEHIND');
  assert.equal(v.warning, true);
  anchor(dir); // deliberate re-anchor extends the witnessed range
  assert.equal(verifyAnchor(dir).cls, 'OK');
});

test('8. CLI: keygen → anchor → verify --with-anchor end-to-end, real child processes', async () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { via: 'cli-e2e' });

  const bad = await run(['--audit-anchor', dir]);
  assert.equal(bad.code, 1); // no key yet — refusal is honest, not silent
  assert.match(bad.stderr + bad.stdout, /KEY_MISSING/);

  const kg = await run(['--audit-keygen', dir]);
  assert.equal(kg.code, 0, kg.stderr);
  assert.match(kg.stdout, /fingerprint=[0-9a-f]{16}/);

  const an = await run(['--audit-anchor', dir]);
  assert.equal(an.code, 0, an.stderr);
  assert.match(an.stdout, /AUDIT anchored SEQ=1/);

  const vf = await run(['--audit-verify', dir, '--with-anchor']);
  assert.equal(vf.code, 0, vf.stderr);
  assert.match(vf.stdout, /AUDIT ok ENTRIES=1/);
  assert.match(vf.stdout, /ANCHOR OK FP=/);

  // after a rewrite the same CLI reports exit 1 with ANCHOR_MISMATCH
  const pub = fs.readFileSync(path.join(dir, KEY_DIR, PUB_FILE), 'utf8');
  fs.rmSync(path.join(dir, 'chain.jsonl'));
  fs.rmSync(path.join(dir, 'head.json'));
  const evil = new AuditChain(dir);
  evil.append('event', { via: 'cli-forged' });
  fs.writeFileSync(path.join(dir, KEY_DIR, PUB_FILE), pub); // operator's witness restored
  const vf2 = await run(['--audit-verify', dir, '--with-anchor']);
  assert.equal(vf2.code, 1);
  assert.match(vf2.stdout + vf2.stderr, /ANCHOR ANCHOR_MISMATCH/);
});
