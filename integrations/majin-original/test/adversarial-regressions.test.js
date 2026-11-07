/* GRAND ARCHITECT Acceptans — Del 10E: REAL adversarial regression tests.
   Every attack vector below is CLASSIFIED (see docs/ADVERSARIAL.md) and
   exercised against the live engine in headless code: path traversal, proto
   pollution, hostile tool-args, guard bypass, eval-content survival, loop
   hijack. Each test exists because refusing/bounding that vector has to be
   PROVEN, not hoped for. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adv-'));

const { createRuntime } = await import('../src/core/runtime.js');
const { load } = await import('../src/core/config.js');
const { resolveIn } = await import('../src/core/tools/files.js');
const mockSession = { get: () => undefined };

async function mkrt(ws, { guardMode = 'off' } = {}) {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: guardMode }, moa: { policy: 'off' }, workspace: ws,
    tasks: { approvalTimeoutMs: 120 },
  }, { persist: false });
  return rt;
}

test('10E-V1 path containment: HONEST policy map — outside-detection exists, protected-class writes denied, neverOn shell blocked', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adv-v1-'));
  /* (a) detection: traversal IS detected (flag), reads are by design allowed
         anywhere (the product reads user dirs on purpose — that is documented). */
  const ctx = { cfg: { get: (k) => (k === 'workspace' ? ws : undefined) } };
  const out = resolveIn(ctx, '../../etc/hostname');
  assert.equal(out.outside, true, 'escape is DETECTED (outside flag) — mission contracts rely on it');
  /* (b) writing inside a PROTECTED root (/etc by default) is denied without a human yes */
  const rt = await mkrt(ws, { guardMode: 'confirm' });
  try {
    const r = await rt.registry.exec('fs.write', { path: '/etc/majin-pwn-write.txt', content: 'x' }, { session: 'adv' });
    assert.equal(r.ok, false, `protected write must die without approval: ${JSON.stringify(r).slice(0, 160)}`);
    assert.equal(fs.existsSync('/etc/majin-pwn-write.txt'), false, 'NOTHING may land in /etc');
  } finally {
    await rt.shutdown();
  }
  /* (c) shell never-class: mkfs shape is ALWAYS blocked, even with confirm:true */
  const rt2 = await mkrt(ws, { guardMode: 'confirm' });
  try {
    const s2 = await rt2.registry.exec('shell.run', { command: 'mkfs -t ext4 /dev/sdb1', confirm: true }, { session: 'adv' });
    assert.equal(s2.ok, false); assert.equal(s2.error?.code, 'blocked', `never-class must hard-block: ${JSON.stringify(s2.error?.code)}`);
  } finally {
    await rt2.shutdown();
  }
});

test('10E-V2 proto pollution: hostile config object cannot pollute Object.prototype', async (t) => {
  const cfg = load();
  const hostile = JSON.parse('{"__proto__": {"pwned": true}}');
  cfg.patch({ guard: hostile }, { persist: false });
  assert.equal(({}).pwned, undefined, 'Object.prototype unharmed');
  assert.equal(cfg.get('guard.pwned'), undefined, 'the injected value lives nowhere reachable as guard.pwned');
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'prototype chain untouched');
  assert.equal(JSON.stringify(cfg.json()).includes('"pwned"'), false, 'nothing hostile survives serialization');
  /* sink-level discrimination: the RAW store itself must not carry the hostile
     prototype — this assertion dies the moment the merge filter disappears
     (sabotage E1), even though clone/own-prop hygiene masks the read surface. */
  const rawGuard = cfg.raw().guard || {};
  assert.equal(Object.prototype.hasOwnProperty.call(rawGuard, 'pwned'), false, 'raw store: no hostile own key');
  assert.ok(rawGuard.pwned !== true, 'raw store: stored guard object prototype is clean');
});

test('10E-V3 hostile tool args: giant + control-char args bounded, no crash, honest envelope', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adv-v3-'));
  const rt = await mkrt(ws);
  const huge = 'A'.repeat(4_000_000) + '\x00\x01\x02';
  const r = await rt.registry.exec('fs.write', { path: 'big.txt', content: huge }, { session: 'adv' });
  assert.equal(r.ok, true, 'legit write must work — bounded ≠ refused');
  const out = await rt.registry.exec('fs.read', { path: 'big.txt' }, { session: 'adv' });
  assert.equal(out.ok, true);
  assert.ok(String(out.result).length < 300_000, `tool output is capped, got ${String(out.result).length} chars`);
  assert.match(String(out.result), /of [0-9]+ bytes/, 'truncation is VISIBLE in the header (lines 1-N of X bytes), not silent');
  assert.equal(out.meta?.truncated, true, 'meta.truncated flags it too');
  await rt.shutdown();
});

test('10E-V4 guard bypass attempt: readOnly session runs NO mutating tool, even directly addressed', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adv-v4-'));
  const rt = await mkrt(ws);
  const r = await rt.registry.exec('fs.write', { path: 'should-never.txt', content: 'pwn' }, { session: 'adv', readOnly: true });
  assert.equal(r.ok, false); assert.equal(r.error?.code, 'read_only');
  assert.equal(fs.existsSync(path.join(ws, 'should-never.txt')), false);
  await rt.shutdown();
});

test('10E-V5 eval-content survival: storing hostile javascript does not execute it', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adv-v5-'));
  const rt = await mkrt(ws);
  const payload = 'process?.exit?.() ?? 0; require("child_process").execSync("touch /tmp/majin-v5-pwn"); global.V5_PWNED = true;';
  const w = await rt.registry.exec('fs.write', { path: 'trap.txt', content: payload }, { session: 'adv' });
  assert.equal(w.ok, true);
  assert.equal(global.V5_PWNED, undefined, 'writing NEVER evaluates');
  assert.equal(fs.existsSync('/tmp/majin-v5-pwn'), false, 'no exec side-effects');
  const stored = fs.readFileSync(path.join(ws, 'trap.txt'), 'utf8');
  assert.equal(stored, payload, 'hostile content stored verbatim — as DATA');
  await rt.shutdown();
});
