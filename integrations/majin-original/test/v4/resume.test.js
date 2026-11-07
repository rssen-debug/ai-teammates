import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { looksLikeCorrection } from '../../src/v4/agent.js';

async function chat(s, cookie, text, extra = {}) {
  const res = await postChat(s.base, cookie, { text, ...extra });
  return { status: res.status, events: await readSse(res) };
}

async function resume(s, cookie, goalId) {
  const res = await fetch(`${s.base}/api/goal/resume`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
    body: JSON.stringify({ goalId }),
  });
  return { status: res.status, events: await readSse(res) };
}

function blockGoal(s, goalId) {
  const file = path.join(s.home, 'v4', 'goals', `${goalId}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.state = 'BLOCKED';
  data.history.push({ at: new Date().toISOString(), to: 'BLOCKED', reason: 'simulated crash' });
  fs.writeFileSync(file, JSON.stringify(data));
}

test('resume: a BLOCKED goal whose file is intact completes after real re-verification', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen återuppta.txt med innehåll: bevis');
    const goalId = events.find((e) => e.type === 'done').data.goalId;
    blockGoal(s, goalId);

    // A resume in practice happens after the host restarted, so the second
    // instance reads the goal from disk instead of a live cache entry.
    after = await startTestServer({ home });
    const out = await resume(after, after.existingSession(), goalId);
    assert.equal(out.status, 200);
    const result = out.events.find((e) => e.type === 'resume_result').data;
    assert.equal(result.status, 'completed');
    assert.equal(result.results[0].verified, true);

    const goal = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'goals', `${goalId}.json`), 'utf8'));
    assert.equal(goal.state, 'COMPLETED');
    assert.ok(goal.receipts.some((r) => r.action === 'resume.verify' && r.verified === true));
  } finally {
    if (after) await after.close();
    await s.close();
  }
});

test('resume: a BLOCKED goal whose file is gone stays BLOCKED with a reason', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen försvunnen.txt med innehåll: x');
    const goalId = events.find((e) => e.type === 'done').data.goalId;
    blockGoal(s, goalId);
    fs.unlinkSync(path.join(home, 'workspace', 'försvunnen.txt'));

    after = await startTestServer({ home });
    const out = await resume(after, after.existingSession(), goalId);
    const result = out.events.find((e) => e.type === 'resume_result').data;
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.missing, ['artifact:försvunnen.txt']);
    assert.match(result.results[0].reason, /missing/);

    const goal = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'goals', `${goalId}.json`), 'utf8'));
    assert.equal(goal.state, 'BLOCKED', 'a failed resume must never report success');
  } finally {
    if (after) await after.close();
    await s.close();
  }
});

test('resume: a tampered file is refused (hash mismatch is not a resume)', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen manipulerad.txt med innehåll: original');
    const goalId = events.find((e) => e.type === 'done').data.goalId;
    blockGoal(s, goalId);
    fs.writeFileSync(path.join(home, 'workspace', 'manipulerad.txt'), 'något annat');

    after = await startTestServer({ home });
    const out = await resume(after, after.existingSession(), goalId);
    const result = out.events.find((e) => e.type === 'resume_result').data;
    assert.equal(result.status, 'blocked');
    assert.match(JSON.stringify(result.results), /hash/i);
  } finally {
    if (after) await after.close();
    await s.close();
  }
});

test('resume: only BLOCKED goals can be resumed', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen klar.txt med innehåll: x');
    const goalId = events.find((e) => e.type === 'done').data.goalId;
    const out = await resume(s, cookie, goalId);
    const err = out.events.find((e) => e.type === 'error');
    assert.ok(err, 'a COMPLETED goal is not resumable');
    assert.match(err.data.message, /COMPLETED/);
  } finally {
    await s.close();
  }
});

test('resume: requires a session and a CSRF header', async () => {
  const s = await startTestServer();
  try {
    const noSession = await fetch(`${s.base}/api/goal/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ goalId: 'goal_x' }),
    });
    assert.equal(noSession.status, 401);
    const { cookie } = await s.pair();
    const noCsrf = await fetch(`${s.base}/api/goal/resume`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ goalId: 'goal_x' }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

test('correction: the heuristic only links messages that continue the same work', () => {
  const goal = { acceptance: [{ id: 'artifact:rapport.txt' }] };
  assert.equal(looksLikeCorrection('Skriv filen rapport.txt igen med rätt innehåll', goal), true);
  assert.equal(looksLikeCorrection('nej, bara remote jobb', goal), true);
  assert.equal(looksLikeCorrection('fortsätt', goal), true);
  assert.equal(looksLikeCorrection('Vad är vädret i Stockholm?', goal), false);
  assert.equal(looksLikeCorrection('Skriv filen annan.txt med innehåll: ny', goal), false);
  assert.equal(looksLikeCorrection('hej', null), false);
});

test('correction: a follow-up turn is recorded as a revision of the same thread', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen revidera.txt med innehåll: ett');
    const convId = first.events.find((e) => e.type === 'done').data.conversationId;
    const firstGoal = first.events.find((e) => e.type === 'done').data.goalId;

    const second = await chat(s, cookie, 'nej, ändra revidera.txt till innehåll: två', { conversationId: convId });
    const secondGoalEvent = second.events.filter((e) => e.type === 'goal').pop().data;
    assert.equal(secondGoalEvent.revisionOf, firstGoal, 'linked to the previous goal, not orphaned');
    assert.equal(secondGoalEvent.revision, 1);

    const read = await fetch(`${s.base}/api/conversation?id=${convId}`, { headers: { cookie } });
    const conv = (await read.json()).conversation;
    assert.equal(conv.goals.length, 2);
    assert.ok(conv.goals.some((g) => g.revisionOf === firstGoal));
  } finally {
    await s.close();
  }
});

test('correction: an unrelated new task starts a fresh goal with no revision link', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen a1.txt med innehåll: ett');
    const convId = first.events.find((e) => e.type === 'done').data.conversationId;
    const second = await chat(s, cookie, 'Vad kan du göra just nu?', { conversationId: convId });
    const goal = second.events.filter((e) => e.type === 'goal').pop().data;
    assert.equal(goal.revisionOf, undefined);
  } finally {
    await s.close();
  }
});

test('cross-device: a second paired device sees the same conversation and goal state', async () => {
  const s = await startTestServer();
  try {
    const phone = await s.pair();
    const desktop = await s.pair();
    assert.notEqual(phone.cookie, desktop.cookie, 'two independent sessions');

    const { events } = await chat(s, phone.cookie, 'Skriv filen delad.txt med innehåll: från telefonen');
    const done = events.find((e) => e.type === 'done').data;

    const conv = await fetch(`${s.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie: desktop.cookie } });
    assert.equal(conv.status, 200);
    const body = await conv.json();
    assert.ok(body.conversation.messages.some((m) => m.content.includes('delad.txt')));
    assert.equal(body.conversation.goals[0].state, 'COMPLETED');

    const goal = await fetch(`${s.base}/api/goal?id=${done.goalId}`, { headers: { cookie: desktop.cookie } });
    assert.equal((await goal.json()).goal.state, 'COMPLETED');
  } finally {
    await s.close();
  }
});
