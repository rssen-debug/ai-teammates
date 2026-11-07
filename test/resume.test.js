/* Del 1D acceptance: interrupted work resumes WITHOUT duplicate side effects.
 * A crashed task must never re-run a completed external action; when the outcome
 * is uncertain, the code inspects the real world before deciding — and explicit
 * Resume / Retry / Cancel / Start Fresh actions all behave honestly. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-'));

const {
  recordEffect, readJournal, journalState, planResume, recoverTask, taskAction, sha256,
} = await import('../src/core/effects.js');

const bashFailureNote = '' /* keep eslint-quiet about unused */

test('crash mid-plan: resumes only the pending step, never re-writes a completed file', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-ws-'));
  const session = 'crashA';
  const plan = [
    { id: 's1', text: 'write report.txt', effect: { kind: 'fs.write', target: path.join(ws, 'report.txt') } },
    { id: 's2', text: 'write summary.txt', effect: { kind: 'fs.write', target: path.join(ws, 'summary.txt') } },
  ];
  const calls = [];
  const executor = async (step) => {
    calls.push(step.id);
    const content = step.id === 's1' ? 'report body' : 'summary body';
    fs.writeFileSync(step.effect.target, content);
    return { ok: true, content };
  };

  /* fas 1: crash EFTERSista step s1 — journalen visar s1 completed, s2 saknas */
  await recoverTask({ session, plan: plan.slice(0, 1), execute: executor });
  assert.equal(calls.join(','), 's1');
  assert.ok(readJournal(session).some((e) => e.id === 's1' && e.status === 'completed'));

  /* simulerad omstart: samma session, hela planen — s2 MAY run, s1 MAY NOT */
  const res = await recoverTask({ session, plan, execute: executor });
  assert.deepEqual(calls, ['s1', 's2'], `s1 måste vara SKIPPED, inte körd igen — fick ${calls.join('+')}`);
  assert.equal(res.executed.length, 1, 'exakt EN pending step körs');
  assert.equal(res.verifiedDone.length, 1, 's1 verifieras via journal + evidens');
  assert.match(res.verifiedDone[0].evidence, /external evidence matches/);
  /* och journalen är dubbel-fylld för båda nu */
  assert.ok(readJournal(session).filter((e) => e.id === 's2').length >= 2, 's2 got started+completed entries');
});

test('crash i write-window (journal=started, file actually written): evidence closes the gap, no duplicate write', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-ws2-'));
  const session = 'crashB';
  const target = path.join(ws, 'order.txt');
  const content = 'ORDER-275';
  /* fysisk sanning: filen SKREVdes, men journalen hann bara logga STARTED innan kraschen */
  fs.writeFileSync(target, content);
  recordEffect(session, { id: 's1', kind: 'fs.write', target, hash: sha256(Buffer.from(content)), status: 'started' });

  const calls = [];
  const res = await recoverTask({
    session,
    plan: [{ id: 's1', text: 'write order.txt', effect: { kind: 'fs.write', target, hash: sha256(Buffer.from(content)) } }],
    execute: async (step) => { calls.push(step.id); fs.writeFileSync(step.effect.target, content); return { ok: true, content }; },
  });
  assert.equal(calls.length, 0, `evidensen säger att filen är korrekt — aldrig skriv igen: ${calls.join('+')}`);
  assert.equal(res.verifiedDone.length, 1);
  assert.match(res.verifiedDone[0].evidence, /crash window/);
});

test('corrupted outcome (file gone) forces a RE-run; different content is NOT silently accepted', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-ws3-'));
  const session = 'crashC';
  const target = path.join(ws, 'config.ini');
  recordEffect(session, { id: 's1', kind: 'fs.write', target, hash: sha256(Buffer.from('version=1')), status: 'completed' });
  /* disk-sanning: nOLL — filen finns inte */
  const decision = planResume(session, [{ id: 's1', text: 'write config.ini', effect: { kind: 'fs.write', target, hash: sha256(Buffer.from('version=1')) } }], { workspaceRoot: ws });
  assert.equal(decision.uncertain.length, 1, 'journal claimed completed but evidence is gone → uncertain, aldrig unknown-retry');
  assert.match(decision.uncertain[0].reason, /evidence is gone/);

  /* motsatt fall: fil finns men med fel innehåll = evidence mismatch → absent → uncertain */
  fs.writeFileSync(target, 'version=99 (tampered)');
  const d2 = planResume(session, [{ id: 's1', text: 'x', effect: { kind: 'fs.write', target, hash: sha256(Buffer.from('version=1')) } }], { workspaceRoot: ws });
  assert.equal(d2.uncertain.length, 1, 'tampered content måste ALDRIG betraktas som klar');
});

test('explicit actions: cancel never touches completed steps; startFresh archives and isolates', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-ws4-'));
  const session = 'actionsA';
  const file = path.join(ws, 'done.txt');
  fs.writeFileSync(file, 'done!');
  recordEffect(session, { id: 's1', kind: 'fs.write', target: file, hash: sha256(Buffer.from('done!')), status: 'completed' });
  const plan = [
    { id: 's1', text: 'write done.txt', effect: { kind: 'fs.write', target: file, hash: sha256(Buffer.from('done!')) } },
    { id: 's2', text: 'write next.txt', effect: { kind: 'fs.write', target: path.join(ws, 'next.txt') } },
  ];
  const cancel = await taskAction({ session, action: 'cancel', plan });
  assert.equal(cancel.action, 'cancel');
  const state = journalState(session);
  assert.equal(state.get('s1').status, 'completed', 'completed steps remain completed');
  assert.equal(state.get('s2').status, 'cancelled', 'pending steps become cancelled');

  const fresh = await taskAction({ session, action: 'startFresh' });
  assert.equal(fresh.action, 'startFresh');
  assert.ok(fresh.archived, 'the old journal was archived');
  assert.equal(readJournal(session).length, 0, 'fresh start = empty journal (no old state leaks)');
});

test('retry on a candidly cancelled plan runs nothing twice: completed stays skipped, cancelled stays guarded', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-ws5-'));
  const session = 'actionsB';
  const file = path.join(ws, 'a.txt');
  fs.writeFileSync(file, 'written content');
  const hash = sha256(Buffer.from('written content'));
  recordEffect(session, { id: 's1', kind: 'fs.write', target: file, hash, status: 'completed' });
  recordEffect(session, { id: 's2', kind: 'fs.write', target: path.join(ws, 'b.txt'), status: 'cancelled' });
  const calls = [];
  const res = await recoverTask({
    session,
    plan: [
      { id: 's1', text: 'w a', effect: { kind: 'fs.write', target: file, hash } },
      { id: 's2', text: 'w b', effect: { kind: 'fs.write', target: path.join(ws, 'b.txt') } },
    ],
    execute: async (step) => { calls.push(step.id); return { ok: true, content: 'written content' }; },
  });
  assert.equal(calls.length, 0, `varken completed (s1) eller cancelled (s2) får springa: ${calls.join('+')}`);
  assert.equal(res.cancelled.length, 1);
  assert.equal(res.verifiedDone.length, 1);
});


test('WIRED end-to-end: a real agent-turn fs.write lands in the session journal with the true content hash', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-resume-live-'));
  const { createRuntime } = await import('../src/core/runtime.js');
  const { setScript } = await import('../src/core/provider/mock.js');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  setScript('main:tasks', [
    { toolCalls: [{ name: 'fs.write', args: { path: 'live.txt', content: 'needle-content' } }] },
    { text: 'wrote it!' },
  ]);
  await rt.agent.turn({ input: 'please write live.txt containing needle-content', session: 'journal-live' });
  const entries = readJournal('journal-live').filter((e) => e.kind === 'fs.write' && e.status === 'completed');
  assert.ok(entries.length >= 1, `fs.write must journal: ${JSON.stringify(readJournal('journal-live'))}`);
  const hit = entries.find((e) => String(e.target).endsWith('live.txt'));
  assert.ok(hit, `live.txt måste finnas i journalen: ${JSON.stringify(entries)}`);
  assert.equal(hit.hash, sha256(Buffer.from('needle-content')), 'journalen bär den SANNA innehålls-hashen');
  assert.equal(fs.readFileSync(path.join(ws, 'live.txt'), 'utf8'), 'needle-content');
  await rt.shutdown();
});
