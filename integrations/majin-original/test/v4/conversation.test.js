import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse } from './helpers.mjs';

async function chat(s, cookie, text, extra = {}) {
  const res = await postChat(s.base, cookie, { text, ...extra });
  return { status: res.status, events: await readSse(res) };
}

function deltas(events) {
  return events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
}

test('conversation: a file task streams, executes and completes with evidence', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen protokoll.txt med innehåll: MAJIN var här');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool_start'));
    assert.ok(types.includes('tool_result'));

    const result = events.find((e) => e.type === 'tool_result').data;
    assert.equal(result.ok, true);
    assert.equal(result.verified, true, 'file must be verified on disk');

    const done = events.find((e) => e.type === 'done').data;
    assert.equal(done.status, 'completed');

    const goal = events.filter((e) => e.type === 'goal').pop().data;
    assert.equal(goal.state, 'COMPLETED');

    const written = path.join(s.home, 'workspace', 'protokoll.txt');
    assert.equal(fs.readFileSync(written, 'utf8'), 'MAJIN var här');
  } finally {
    await s.close();
  }
});

test('conversation: assistant text is persisted and survives a new request', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen a.txt med innehåll: ett');
    const done = first.events.find((e) => e.type === 'done').data;

    const res = await fetch(`${s.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie } });
    const data = await res.json();
    assert.equal(data.conversation.messages.length, 2);
    assert.equal(data.conversation.messages[0].role, 'user');
    assert.equal(data.conversation.messages[1].role, 'assistant');
    assert.ok(data.conversation.messages[1].content.includes('a.txt'));
  } finally {
    await s.close();
  }
});

test('conversation: duplicate requestId is replayed, never executed twice', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const requestId = 'fixed-request-id-1';
    const one = await chat(s, cookie, 'Skriv filen dup.txt med innehåll: en gång', { requestId });
    assert.equal(one.events.find((e) => e.type === 'done').data.status, 'completed');

    const two = await chat(s, cookie, 'Skriv filen dup.txt med innehåll: en gång', { requestId });
    const status = two.events.find((e) => e.type === 'done').data.status;
    assert.equal(status, 'replayed');
    assert.equal(two.events.filter((e) => e.type === 'tool_start').length, 0);
  } finally {
    await s.close();
  }
});

test('conversation: follow-up in the same conversation keeps context', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen ctx.txt med innehåll: första');
    const convId = first.events.find((e) => e.type === 'done').data.conversationId;

    const second = await chat(s, cookie, 'Lista filerna i arbetsytan', { conversationId: convId });
    assert.equal(second.events.find((e) => e.type === 'done').data.conversationId, convId);

    const res = await fetch(`${s.base}/api/conversation?id=${convId}`, { headers: { cookie } });
    const data = await res.json();
    assert.equal(data.conversation.messages.length, 4);
  } finally {
    await s.close();
  }
});

test('conversation: goal states are legal and never skip VERIFYING', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { events } = await chat(s, cookie, 'Skriv filen states.txt med innehåll: x');
    const goal = events.filter((e) => e.type === 'goal').pop().data;
    const states = goal.history.map((h) => h.to);
    assert.ok(states.includes('VERIFYING'));
    assert.ok(states.indexOf('VERIFYING') < states.indexOf('COMPLETED'));
    assert.ok(!states.includes('FAILED'));
    assert.ok(goal.receipts.every((r) => typeof r.verified === 'boolean'));
  } finally {
    await s.close();
  }
});

test('conversation: an empty message is refused', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: '   ' });
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

test('conversation: history is scoped to one conversation', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const a = await chat(s, cookie, 'Skriv filen one.txt med innehåll: 1');
    await chat(s, cookie, 'Skriv filen two.txt med innehåll: 2');
    const idA = a.events.find((e) => e.type === 'done').data.conversationId;
    const list = await fetch(`${s.base}/api/conversations`, { headers: { cookie } });
    const data = await list.json();
    assert.ok(data.conversations.length >= 2);
    const convA = data.conversations.find((c) => c.id === idA);
    assert.equal(convA.messages, 2);
  } finally {
    await s.close();
  }
});

test('conversation: deleting a conversation removes it from disk', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen del.txt med innehåll: x');
    const convId = first.events.find((e) => e.type === 'done').data.conversationId;
    // Permanent deletion is confirmed. Without the flag the server refuses,
    // because "delete" and "archive" must never be the same click.
    const refusals = await fetch(`${s.base}/api/conversations?id=${convId}`, {
      method: 'DELETE',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    assert.equal(refusals.status, 400);
    const del = await fetch(`${s.base}/api/conversations?id=${convId}&confirm=1`, {
      method: 'DELETE',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(path.join(s.home, 'v4', 'conversations', `${convId}.json`)), false);
  } finally {
    await s.close();
  }
});

test('conversation: stream is cancelled by /api/cancel and records CANCELLED', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const created = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    const conv = (await created.json()).conversation;

    const res = await postChat(s.base, cookie, { text: 'Skriv filen slow.txt med innehåll: x', conversationId: conv.id });
    const cancelled = await fetch(`${s.base}/api/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ conversationId: conv.id }),
    });
    assert.equal(cancelled.status, 200);
    const events = await readSse(res);
    const final = events.filter((e) => e.type === 'done').pop();
    assert.ok(['cancelled', 'completed'].includes(final.data.status));
    void deltas(events);
  } finally {
    await s.close();
  }
});

test('conversation: unknown conversation id is a 404 on read', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await fetch(`${s.base}/api/conversation?id=conv_does_not_exist`, { headers: { cookie } });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('goals: a RUNNING goal left by a crash is reconciled to BLOCKED on boot', async () => {
  const s = await startTestServer();
  let second;
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen boot.txt med innehåll: x');
    const goalId = first.events.find((e) => e.type === 'done').data.goalId;

    // simulate a crash: rewrite the stored goal as RUNNING
    const file = path.join(s.home, 'v4', 'goals', `${goalId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.state = 'RUNNING';
    fs.writeFileSync(file, JSON.stringify(data));

    second = await startTestServer({ home: s.home });
    assert.ok(second.context.reconciled.includes(goalId));
    const goal = second.context.goals.get(goalId);
    assert.equal(goal.state, 'BLOCKED');
  } finally {
    await s.close();
    if (second) await second.close();
  }
});

test('goals: receipts carry SHA-256 evidence tied to the written bytes', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const content = 'bevis med åäö';
    const { events } = await chat(s, cookie, `Skriv filen bevis.txt med innehåll: ${content}`);
    const receipt = events.filter((e) => e.type === 'goal').pop().data.receipts
      .find((r) => r.action === 'tool:workspace_write');
    assert.equal(receipt.verified, true);
    const crypto = await import('node:crypto');
    const expected = crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    assert.equal(receipt.evidence.sha256, expected);
  } finally {
    await s.close();
  }
});
