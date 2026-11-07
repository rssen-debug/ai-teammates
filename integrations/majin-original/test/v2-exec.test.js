/**
 * V2 executor contracts: chain-aware whitelist (the documented bypass lesson),
 * tier x mode decisions, and the sandboxed exec pipeline running REAL harmless
 * processes while proving destructive/escaping ones never spawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Whitelist, executablesOf, normalizeExecutable } from '../src/v2/exec/whitelist.js';
import { decide } from '../src/v2/exec/approval-modes.js';
import { sandboxedExec } from '../src/v2/exec/sandbox.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { EventBus } from '../src/v2/runtime/events.js';

test('whitelist: normalization strips paths, case, extensions (sections 50-51)', () => {
  assert.equal(normalizeExecutable('C:\\Tools\\GIT.EXE'), 'git');
  assert.equal(normalizeExecutable('/usr/bin/Node'), 'node');
  assert.equal(normalizeExecutable('"C:\\Program Files\\ffMPEG\\ffmpeg.exe"'), 'ffmpeg');
});

test('whitelist: chain bypass caught — every segment must be whitelisted (advisory GHSA-vjv9-7m7j-h833)', () => {
  assert.deepEqual(executablesOf('echo ok; rm -rf /tmp/x && cat /etc/passwd'), ['echo', 'rm', 'cat']);
  const wl = new Whitelist(null, null, { baseline: ['echo'] });
  assert.equal(wl.check('echo hello').allowed, true);
  const v = wl.check('echo hello; cat /etc/passwd');
  assert.equal(v.allowed, false);
  assert.deepEqual(v.missing, ['cat']);
});

test('whitelist: persistent file survives reload', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v2-wl-')), 'wl.json');
  const wl = new Whitelist(f, null, { baseline: [] });
  wl.add('MYTOOL.cmd');
  const back = new Whitelist(f, null, { baseline: [] });
  assert.equal(back.check('mytool --version').allowed, true);
});

test('modes: tier x mode matrix behaves as briefed', () => {
  assert.equal(decide({ mode: 'guided', tier: 'ok', whitelisted: true }).decision, 'allow');
  assert.equal(decide({ mode: 'guided', tier: 'ok', whitelisted: false }).decision, 'ask');
  assert.equal(decide({ mode: 'guided', tier: 'hold', whitelisted: true }).decision, 'ask');
  assert.equal(decide({ mode: 'balanced', tier: 'hold', whitelisted: true }).decision, 'ask');
  assert.equal(decide({ mode: 'auto', tier: 'ok', whitelisted: false }).decision, 'ask');
  assert.equal(decide({ mode: 'hands_off', tier: 'ok', whitelisted: true }).decision, 'allow');
  // 'no' tier: blocked FOREVER, in every mode
  for (const m of ['guided', 'balanced', 'auto', 'hands_off']) {
    assert.equal(decide({ mode: m, tier: 'no', whitelisted: true }).decision, 'blocked');
  }
});

test('sandbox: real harmless exec works inside root; chain wait/cosmetic events present', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-exec-'));
  const events = new EventBus();
  const opts = {
    root, whitelist: new Whitelist(null, null), approvals: new Approvals(events), events, mode: 'balanced', timeoutMs: 8000,
  };
  const r = await sandboxedExec('echo v2-works', opts);
  assert.equal(r.decision, 'done');
  assert.equal(r.exit, 0);
  assert.match(r.stdout, /v2-works/);
});

test('sandbox: forbidden commands never spawn — blocked before any process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-exec-'));
  const events = new EventBus();
  const opts = {
    root, whitelist: new Whitelist(null, null), approvals: new Approvals(events), events, mode: 'hands_off', timeoutMs: 1000,
  };
  const r = await sandboxedExec('rm -rf /', opts);
  assert.equal(r.decision, 'blocked');
  assert.equal(r.exit, null);
  // even hands-off cannot run this: no process ever started
});

test('sandbox: HOLD tier waits for consent; after owner consent it executes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-exec-'));
  const target = path.join(root, 'deleteme');
  fs.mkdirSync(target);
  const events = new EventBus();
  const approvals = new Approvals(events);
  const opts = { root, whitelist: new Whitelist(null, null), approvals, events, mode: 'balanced', timeoutMs: 8000 };
  assert.equal(path.dirname(path.resolve(target)), path.resolve(root), 'the recursive delete fixture stays in its isolated workspace');
  const cmd = process.platform === 'win32' ? `rmdir /s /q "${target}"` : `rm -rf "${target}"`;
  const w = await sandboxedExec(cmd, opts);
  assert.equal(w.decision, 'waiting');
  assert.ok(fs.existsSync(target), 'must NOT have executed without consent');
  approvals.grant(w.pendingScope, { user: 'owner' });
  const r2 = await sandboxedExec(cmd, opts);
  assert.equal(r2.decision, 'done');
  assert.equal(fs.existsSync(target), false, 'consented deletion works');
});

test('sandbox: cwd confinement refuses escape outside root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-exec-'));
  const events = new EventBus();
  const opts = { root, whitelist: new Whitelist(null, null), approvals: new Approvals(events), events, timeoutMs: 4000 };
  const r = await sandboxedExec('pwd', { ...opts, cwd: os.tmpdir() });
  assert.equal(r.decision, 'denied');
  assert.match(r.reason, /escapes/);
});
