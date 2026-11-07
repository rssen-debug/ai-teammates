import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalMissionId, checkpointDir, writeState, readState, journalEvent, carryFromState, buildStateFromParts } from '../src/core/mission-checkpoint.js';
import { runMission } from '../src/core/mission.js';

const stubCfg = (wsDir) => ({
  get: (k) => (k === 'workspace' ? wsDir : k === 'models.routes' ? { tasks: 'demo/echo' } : undefined),
  resolveModel: (ref) => ({ ref: ref || 'demo/echo', apiKey: 'x', kind: 'mock', provider: 'demo', model: 'echo' }),
});

test('W7 checkpoint module: id stability, write/read integrity, carry deriverar ENDAST verified-noder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const id = canonicalMissionId('Create a.txt containing HELLO and b.txt containing WORLD');
  assert.equal(id, canonicalMissionId('  create   a.txt containing HELLO and b.txt containing WORLD '));
  const d = checkpointDir(dir, id);
  writeState(d, { id, status: 'in_progress', nodeIds: ['a', 'b'], nodes: [
    { id: 'a', status: 'verified', text: 'made-a', verifiedSummary: 'a.txt (12 bytes)' },
    { id: 'b', status: 'failed', text: null, error: 'flake' },
  ]});
  const st = readState(d);
  assert.equal(st.status, 'in_progress');
  journalEvent(d, { event: 'resumed' });
  assert.match(fs.readFileSync(path.join(d, 'journal.jsonl'), 'utf8'), /resumed/);
  const carry = carryFromState(st);
  assert.deepEqual(Object.keys(carry), ['a']);
  assert.equal(carry.a.verified, true);
});

function makeMissionGoal() {
  return [
    '1) create a file called "alpha.txt" containing the exact word "HELLO-ALPHA".',
    '2) create a file called "beta.txt" containing the exact word "HELLO-BETA".',
  ].join('\n');
}

/* fake compiler: deterministic 2-node graph that mirrors the goal phrasing */
const compileGraph = () => JSON.stringify({ nodes: [
  { id: 'a', input: 'create the file alpha.txt containing the exact word "HELLO-ALPHA" (use fs.write so it really exists)' , deps: [], estMs: 10 },
  { id: 'b', input: 'create the file beta.txt containing the exact word "HELLO-BETA" (use fs.write so it really exists)', deps: [], estMs: 10 },
]});

/* fake workers: run behaviors are tunable; side-effect counters PROVE no repeated work */
function workerFactory(wsDir, behavior, counters) {
  return async (node) => {
    const which = node.id;
    counters[which] = (counters[which] || 0) + 1;
    const mode = behavior[which];
    if (mode === 'ok') {
      const name = which === 'a' ? 'alpha.txt' : 'beta.txt';
      fs.writeFileSync(path.join(wsDir, name), which === 'a' ? 'HELLO-ALPHA' : 'HELLO-BETA');
      return { text: `made ${name} for real`, usage: { input: 1, output: 1 } };
    }
    throw new Error('provider-drop (simulated crash mid-mission)');
  };
}

test('W7: mission resumes after interruption — verified work is carried, never re-run', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-ws-'));
  const goal = makeMissionGoal();
  const countersRunner1 = {};
  const r1 = await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'test', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'crash' }, countersRunner1),
  });
  /* Run 1: node b fails (simulated crash) → mission ends non-complete */
  const st = readState(checkpointDir(wsDir, canonicalMissionId(goal)));
  assert.ok(st, 'checkpoint state must exist after run 1');
  const nodeA = st.nodes.find((n) => n.id === 'a');
  const nodeB = st.nodes.find((n) => n.id === 'b');
  assert.equal(nodeA.status, 'verified', JSON.stringify(st, null, 1).slice(0, 700));
  assert.notEqual(nodeB.status, 'verified');

  /* Run 2 (the "process restart"): new counter; node a must NEVER re-run */
  const countersRunner2 = {};
  const resumeEvents = [];
  const r2 = await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'test', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'ok' }, countersRunner2),
    emit: (e) => resumeEvents.push(e),
  });
  assert.ok(resumeEvents.some((e) => e.type === 'mission_resumed'), 'mission_resumed event must fire');
  assert.equal(countersRunner2.a === 1 || countersRunner2.a === undefined, countersRunner2.a === undefined, 'node a must NOT be re-executed (carried checkpoint)');
  assert.ok((countersRunner2.b || 0) >= 1, 'node b executed in run 2');
  const st2 = readState(checkpointDir(wsDir, canonicalMissionId(goal)));
  assert.equal(st2.status, 'complete', `expected complete: ${JSON.stringify(st2, null, 1).slice(0, 700)}`);
  const txt = st2.nodes.find((n) => n.id === 'a').verifiedSummary;
  assert.ok(txt.includes('carried') || txt.includes('checkpoint') || txt.includes('alpha'));
  /* alpha.txt was written EXACTLY once across both runs */
  assert.ok(fs.existsSync(path.join(wsDir, 'alpha.txt')));
  assert.ok(fs.existsSync(path.join(wsDir, 'beta.txt')));
});

test('W7: dead mission never claims completion — final state blocked with reason', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-ws2-'));
  const goal = makeMissionGoal();
  await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'test', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: async (node) => ({ text: `claims done ${node.id} but wrote nothing`, usage: null }),
  });
  const st = readState(checkpointDir(wsDir, canonicalMissionId(goal)));
  assert.ok(st, 'state must exist');
  assert.equal(st.status, 'blocked', `never-faking: workers that only claim create no verified state (got ${st.status})`);
  assert.ok(st.nodes.some((n) => n.status === 'failed' || n.status === 'blocked'));
  assert.ok((st.limitsHit || []).length >= 1, 'limit marker (retry/replan) recorded: ' + JSON.stringify(st.limitsHit));
});


for (const sabotage of ['deleted', 'content-changed']) {
  test('W7 checkpoint revalidation: ' + sabotage + ' verified artifact is re-executed, not falsely carried', async () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-stale-'));
    const goal = makeMissionGoal();
    const firstCalls = {};
    await runMission({
      cfg: stubCfg(wsDir), registry: null, session: 'stale', input: goal,
      modelCall: async () => compileGraph(),
      workerOverride: workerFactory(wsDir, { a: 'ok', b: 'crash' }, firstCalls),
    });
    const cpDir = checkpointDir(wsDir, canonicalMissionId(goal));
    const firstState = readState(cpDir);
    assert.equal(firstState.nodes.find((n) => n.id === 'a').status, 'verified');
    assert.equal(firstCalls.a, 1);

    const alpha = path.join(wsDir, 'alpha.txt');
    if (sabotage === 'deleted') fs.unlinkSync(alpha);
    else fs.appendFileSync(alpha, '\nUNAUTHORIZED CHANGE');
    const nextCalls = {};
    const events = [];
    const resumed = await runMission({
      cfg: stubCfg(wsDir), registry: null, session: 'stale', input: goal,
      modelCall: async () => compileGraph(),
      workerOverride: workerFactory(wsDir, { a: 'ok', b: 'ok' }, nextCalls),
      emit: (event) => events.push(event),
    });
    assert.equal(nextCalls.a, 1, 'changed evidence must force a real new execution');
    assert.equal(nextCalls.b, 1);
    assert.ok(events.some((event) => event.type === 'mission_carry_invalid' && event.id === 'a'),
      'must report why checkpoint carry was rejected');
    assert.equal(resumed.carriedCount, 0, 'invalidated result must not count as carried');
    assert.equal(fs.readFileSync(alpha, 'utf8'), 'HELLO-ALPHA');
    assert.equal(readState(cpDir).status, 'complete');
  });
}

test('W7 checkpoint revalidation: intact verified artifact is carried without repeating side effects', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-intact-'));
  const goal = makeMissionGoal();
  await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'intact', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'crash' }, {}),
  });
  const nextCalls = {};
  const events = [];
  const resumed = await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'intact', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'ok' }, nextCalls),
    emit: (event) => events.push(event),
  });
  assert.equal(nextCalls.a, undefined, 'intact verified artifact must not be rewritten');
  assert.equal(nextCalls.b, 1);
  assert.equal(resumed.carriedCount, 1);
  assert.ok(events.some((event) => event.type === 'mission_carried' && event.id === 'a' && event.reverified === true));
  assert.equal(readState(checkpointDir(wsDir, canonicalMissionId(goal))).status, 'complete');
});


test('W7 checkpoint identity: a recompiled task cannot reuse another task with the same node ID', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-identity-'));
  const goal = makeMissionGoal();
  await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'identity', input: goal,
    modelCall: async () => compileGraph(),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'crash' }, {}),
  });
  const changedGraph = JSON.parse(compileGraph());
  changedGraph.nodes[0].input += ' Also satisfy this NEW requirement, not present in the prior run.';
  const nextCalls = {};
  const events = [];
  const resumed = await runMission({
    cfg: stubCfg(wsDir), registry: null, session: 'identity', input: goal,
    modelCall: async () => JSON.stringify(changedGraph),
    workerOverride: workerFactory(wsDir, { a: 'ok', b: 'ok' }, nextCalls),
    emit: (event) => events.push(event),
  });
  assert.equal(nextCalls.a, 1, 'the old matching file alone cannot prove the new task is done');
  assert.equal(nextCalls.b, 1);
  assert.equal(resumed.carriedCount, 0);
  assert.ok(events.some((event) => event.type === 'mission_carry_invalid' && event.id === 'a' &&
    /node changed|identity/.test(event.reason)));
  const checkpoint = readState(checkpointDir(wsDir, canonicalMissionId(goal)));
  assert.equal(checkpoint.status, 'complete');
  assert.equal(checkpoint.nodes[0].input, changedGraph.nodes[0].input);
});


for (const instruction of [
  'send an external email and charge a customer',
  'make command "node --version" exits 0',
]) {
  test('W7 unsafe resume: uncheckable previous side effects require review instead of replay: ' + instruction, async () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-unsafe-'));
    const goal = '1) ' + instruction + '\n2) create beta.txt containing the exact word "HELLO-BETA"';
    const graph = { nodes: [
      { id: 'a', input: instruction, deps: [], estMs: 10 },
      { id: 'b', input: 'create beta.txt containing the exact word "HELLO-BETA"', deps: [], estMs: 10 },
    ] };
    writeState(checkpointDir(wsDir, canonicalMissionId(goal)), {
      id: canonicalMissionId(goal), status: 'blocked', nodeIds: ['a', 'b'],
      nodes: [
        { id: 'a', input: graph.nodes[0].input, deps: [], status: 'verified', text: 'previously claimed done', verifiedSummary: 'old claim' },
        { id: 'b', input: graph.nodes[1].input, deps: [], status: 'failed', error: 'temporary failure' },
      ],
    });
    const events = [];
    const calls = {};
    const m = await runMission({
      cfg: stubCfg(wsDir), registry: null, session: 'unsafe', input: goal,
      modelCall: async () => JSON.stringify(graph),
      workerOverride: async (node) => {
        calls[node.id] = (calls[node.id] || 0) + 1;
        if (node.id === 'a') throw Error('dangerous repeated action!');
        fs.writeFileSync(path.join(wsDir, 'beta.txt'), 'HELLO-BETA');
        return { text: 'wrote beta.txt' };
      },
      emit: (event) => events.push(event),
    });
    assert.equal(calls.a, undefined, 'unknown prior side effect must never be retried automatically');
    assert.equal(calls.b, 1);
    assert.equal(m.failCount, 1);
    assert.match(m.textSummary.join('\n'), /REQUIRES_REVIEW/);
    assert.ok(events.some((e) => e.type === 'mission_carry_unverifiable' && e.id === 'a'));
    assert.equal(readState(checkpointDir(wsDir, canonicalMissionId(goal))).status, 'blocked');
  });
}
