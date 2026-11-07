/**
 * Telemetry: useful for debugging, incapable of leaking what the user typed.
 *
 * V2's ledger enforces a per-event field allowlist in its serializer. These
 * tests attack that property from the outside — through a real turn with a
 * recognisable secret in the message — because a privacy claim that is only
 * documented is a privacy claim that will rot.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { TelemetryLedger, TELEMETRY_EVENTS } from '../../src/v2/telemetry/ledger.js';
import { aggregate } from '../../src/v2/telemetry/aggregate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'KONFIDENTIELLT-7f3a9c';

function ledgerRows(home) {
  const dir = path.join(home, 'v4', 'telemetry');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0];
  if (!file) return [];
  return fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('telemetry: a real turn records goal.start, model.call, task.result and goal.finish', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await readSse(await postChat(s.base, cookie, { text: 'Skriv filen logg.txt med innehåll: hej', requestId: 't1' }));
  } finally {
    await s.close({ keep: true });
  }
  const rows = ledgerRows(home);
  const events = rows.map((r) => r.event);
  for (const expected of ['goal.start', 'task.result', 'goal.finish']) {
    assert.ok(events.includes(expected), `missing ${expected} in ${JSON.stringify(events)}`);
  }
  const finish = rows.find((r) => r.event === 'goal.finish');
  assert.equal(finish.finalState, 'COMPLETED');
  assert.ok(typeof finish.durationMs === 'number');
  assert.equal(finish.verifiedReceipts >= 1, true, 'the verified receipt is counted');
  fs.rmSync(home, { recursive: true, force: true });
});

test('telemetry: message text, file content, paths and keys never reach the ledger', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await readSse(await postChat(s.base, cookie, {
      text: `Skriv filen hemlig.txt med innehåll: ${SECRET}`,
      requestId: 't2',
    }));
  } finally {
    await s.close({ keep: true });
  }

  const dir = path.join(home, 'v4', 'telemetry');
  const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(raw.length > 0, 'the ledger has content');
  assert.ok(!raw.includes(SECRET), 'the message content leaked into telemetry');
  assert.ok(!raw.includes('hemlig.txt'), 'the file name leaked into telemetry');
  assert.ok(!raw.includes(home), 'an absolute path leaked into telemetry');

  // and the same for the other artefacts that do contain it, as a control
  assert.ok(fs.readFileSync(path.join(home, 'workspace', 'hemlig.txt'), 'utf8').includes(SECRET), 'control: the file really does contain it');
  fs.rmSync(home, { recursive: true, force: true });
});

test('telemetry: the serializer drops fields outside the allowlist, whatever is passed', () => {
  const home = tempHome();
  const ledger = new TelemetryLedger(path.join(home, 'tel'));
  const row = ledger.append('goal.start', {
    goalId: 'goal_abc',
    objectiveLen: 42,
    apiKey: 'sk-should-never-appear',
    message: 'user text should never appear',
    path: '/home/user/private/file.txt',
  });
  assert.equal(row.goalId, 'goal_abc');
  assert.equal(row.objectiveLen, 42);
  assert.equal(row.apiKey, undefined);
  assert.equal(row.message, undefined);
  assert.equal(row.path, undefined);

  const written = fs.readFileSync(path.join(home, 'tel', fs.readdirSync(path.join(home, 'tel'))[0]), 'utf8');
  assert.ok(!written.includes('sk-should-never-appear'));
  assert.ok(!written.includes('user text'));
  assert.ok(!written.includes('/home/user/private'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('telemetry: an unknown event name is refused instead of written', () => {
  const home = tempHome();
  const ledger = new TelemetryLedger(path.join(home, 'tel'));
  assert.throws(() => ledger.append('message.content', { text: 'x' }), /unknown telemetry event/);
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(TELEMETRY_EVENTS.includes('goal.finish'));
});

test('telemetry: the aggregate reads V4 data and reports completion rate', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await readSse(await postChat(s.base, cookie, { text: 'Skriv filen a.txt med innehåll: 1', requestId: 'a1' }));
    await readSse(await postChat(s.base, cookie, { text: 'Skriv filen ../escape.txt med innehåll: 2', requestId: 'a2' }));
  } finally {
    await s.close({ keep: true });
  }
  const report = aggregate(path.join(home, 'v4', 'telemetry'), { lastDays: 7 });
  assert.ok(report.events >= 4, `expected several events, got ${report.events}`);
  assert.ok(report.goals.count >= 2, 'both turns finished');
  assert.equal(report.goals.completedRate > 0 && report.goals.completedRate < 1, true, 'one completed, one refused');
  fs.rmSync(home, { recursive: true, force: true });
});

test('telemetry: the CLI summarises the ledger and says when it is empty', async () => {
  const empty = tempHome();
  const runEmpty = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v4/logs.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MAJIN_HOME: empty },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(runEmpty.status, 0, runEmpty.stderr);
  assert.match(runEmpty.stdout, /No events yet/);
  fs.rmSync(empty, { recursive: true, force: true });

  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await readSse(await postChat(s.base, cookie, { text: 'Skriv filen b.txt med innehåll: x', requestId: 'b1' }));
  } finally {
    await s.close({ keep: true });
  }
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v4/logs.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MAJIN_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /goals\s+1 finished, 1 completed/);
  assert.match(run.stdout, /contains no message text/);

  const json = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v4/logs.mjs'), '--json'], {
    cwd: ROOT,
    env: { ...process.env, MAJIN_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.events > 0);
  assert.equal(parsed.goals.completed, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('telemetry: a broken ledger cannot take a turn down', async () => {
  const home = tempHome();
  // Make the telemetry path a file, so the ledger directory cannot be created.
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4', 'telemetry'), 'not a directory');
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, { text: 'Skriv filen c.txt med innehåll: x', requestId: 'c1' }));
    const done = events.filter((e) => e.type === 'done').pop();
    assert.equal(done.data.status, 'completed', 'the turn still works without telemetry');
    assert.equal(s.context.audit.status().ok,true,'mandatory audit remains healthy when optional analytics is unavailable');
    const auditRows=fs.readFileSync(path.join(s.context.audit.dir,'chain.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(auditRows.some(row=>row.kind==='telemetry'&&row.payload.event==='goal.finish'));
  } finally {
    await s.close();
  }
});
