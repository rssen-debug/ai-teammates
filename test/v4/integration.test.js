/**
 * Integration points between modules.
 *
 * Unit tests pass while the seams leak. These check that state changed in one
 * place is visible in the others: a goal resumed in the agent must appear in the
 * conversation the user reopens, and the canonical model chosen on one device must
 * survive a reload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';

async function chat(s, cookie, text, extra = {}) {
  return readSse(await postChat(s.base, cookie, { text, ...extra }));
}

function blockGoal(home, goalId) {
  const file = path.join(home, 'v4', 'goals', `${goalId}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.state = 'BLOCKED';
  fs.writeFileSync(file, JSON.stringify(data));
}

async function resume(s, cookie, goalId) {
  const res = await fetch(`${s.base}/api/goal/resume`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
    body: JSON.stringify({ goalId }),
  });
  return { status: res.status, events: await readSse(res) };
}

test('integration: a resumed goal leaves a record in the conversation the user reopens', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const events = await chat(s, cookie, 'Skriv filen återupptagen.txt med innehåll: bevis');
    const done = events.find((e) => e.type === 'done').data;
    blockGoal(home, done.goalId);

    after = await startTestServer({ home });
    const out = await resume(after, after.existingSession(), done.goalId);
    assert.equal(out.events.find((e) => e.type === 'resume_result').data.status, 'completed');

    // Reopen the conversation: the resume must be visible, not just a toast.
    const read = await fetch(`${after.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie: after.existingSession() } });
    const conv = (await read.json()).conversation;
    const texts = conv.messages.map((m) => m.content.toLowerCase()).join(' | ');
    assert.match(texts, /återuppt|verifier/, `resume left no trace in the conversation: ${texts}`);
    assert.ok(conv.messages.length >= 3, 'a third message was appended');
  } finally {
    if (after) await after.close();
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('integration: a resume that still fails also leaves a record, marked as an error', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const events = await chat(s, cookie, 'Skriv filen försvann.txt med innehåll: x');
    const done = events.find((e) => e.type === 'done').data;
    blockGoal(home, done.goalId);
    fs.unlinkSync(path.join(home, 'workspace', 'försvann.txt'));

    after = await startTestServer({ home });
    const session = after.existingSession();
    const out = await resume(after, session, done.goalId);
    assert.equal(out.events.find((e) => e.type === 'resume_result').data.status, 'blocked');

    const read = await fetch(`${after.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie: session } });
    const conv = (await read.json()).conversation;
    const last = conv.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.meta.error, true, 'a failed resume is marked as an error in history');
    assert.match(last.content.toLowerCase(), /verifier|blockerad|försvann|missing/);
  } finally {
    if (after) await after.close();
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('integration: the goal in the conversation reflects the resumed state, not the old one', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const events = await chat(s, cookie, 'Skriv filen state.txt med innehåll: x');
    const done = events.find((e) => e.type === 'done').data;
    blockGoal(home, done.goalId);

    after = await startTestServer({ home });
    const session = after.existingSession();
    await resume(after, session, done.goalId);

    const read = await fetch(`${after.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie: session } });
    const conv = (await read.json()).conversation;
    const goal = conv.goals.find((g) => g.id === done.goalId);
    assert.equal(goal.state, 'COMPLETED', 'the conversation shows the live state of the goal');
  } finally {
    if (after) await after.close();
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('integration: authorized canonical model selection survives host restart and client reload', async () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    providers: {
      p: { label: 'P', kind: 'openai', baseUrl: 'https://p.example', apiKey: 'k-123', models: ['m-one', 'm-two'] },
    },
    models: { routes: { chat: 'p/m-one' } },
  }));
  const s = await startTestServer({ home });
  let after, closed = false;
  try {
    const { cookie } = await s.pair();
    const created = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    const conv = (await created.json()).conversation;

    const select = await fetch(`${s.base}/api/model`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ conversationId: conv.id, modelId: 'p/m-two', expectedVersion: 0, authorizePotentialCost: true }),
    });
    assert.equal(select.status, 200);

    // The canonical selector replaces per-conversation defaults while leaving
    // historical conversation metadata untouched.
    const read = await fetch(`${s.base}/api/conversation?id=${conv.id}`, { headers: { cookie } });
    const body = await read.json();
    assert.equal(body.conversation.modelId, null);
    await s.close({ keep: true }); closed = true;
    after = await startTestServer({ home });
    const models = await (await fetch(`${after.base}/api/models`, { headers: { cookie } })).json();
    assert.equal(models.selection.modelId, 'p/m-two');
    assert.equal(models.selection.version, 1);
    assert.equal(after.context.model.routeForModel(null).model, 'm-two');
  } finally {
    if (after) await after.close();
    if (!closed) await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('integration: telemetry records a resume, so the log matches what happened', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  let after;
  try {
    const { cookie } = await s.pair();
    const events = await chat(s, cookie, 'Skriv filen tel.txt med innehåll: x');
    const done = events.find((e) => e.type === 'done').data;
    blockGoal(home, done.goalId);

    after = await startTestServer({ home });
    await resume(after, after.existingSession(), done.goalId);

    const dir = path.join(home, 'v4', 'telemetry');
    const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const rows = raw.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.event === 'goal.finish' && r.goalId === done.goalId);
    // The original turn wrote one row. A resume that completes the goal must
    // write a SECOND one — otherwise the log says the goal finished once, and
    // the log would be lying about when.
    assert.equal(rows.length, 2, `expected one row per finish, got ${rows.length}`);
    assert.equal(rows.every((r) => r.finalState === 'COMPLETED'), true);
  } finally {
    if (after) await after.close();
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
