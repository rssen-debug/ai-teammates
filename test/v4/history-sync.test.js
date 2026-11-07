/**
 * Shared history, honestly implemented.
 *
 * The owner's definition of done: the same conversation opens on the computer
 * and the phone, continues where it stopped, and no history disappears on a
 * restart. These tests drive two independent clients against one host and check
 * the properties that make that true:
 *
 *   - one store (V4's own conversations) — no second chat system
 *   - a list endpoint with search, archive view and a `since` cursor
 *   - tombstones so a deletion does not come back on the other device
 *   - rename survives later messages (manual title wins forever)
 *   - deleting while a turn runs is refused unless the caller cancels it
 *   - V1 transcripts import without touching the source files, idempotently
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';

async function chat(s, cookie, text, extra = {}) {
  const events = await readSse(await postChat(s.base, cookie, { text, ...extra }));
  return { events, done: events.find((e) => e.type === 'done')?.data };
}

test('history: two sessions and a restarted host recover the same safe durable tool receipts', async () => {
  const home = tempHome();
  let server = await startTestServer({ home });
  try {
    const first = await server.pair();
    const second = await server.pair();
    assert.notEqual(first.cookie, second.cookie);
    const { events, done } = await chat(server, first.cookie, 'Write file receipt-history.txt with content: persisted');
    const live = events.find((event) => event.type === 'tool_result' && event.data.verified)?.data;
    assert.ok(live?.receiptId);
    const read = async () => apiJson(server, second.cookie, `/api/conversation?id=${done.conversationId}`);
    const before = await read();
    const receipts = before.body.conversation.goals.flatMap((goal) => goal.receipts);
    const receipt = receipts.find((entry) => entry.id === live.receiptId);
    assert.equal(receipt.action, 'tool:workspace_write');
    assert.equal(receipt.result, 'success');
    assert.equal(receipt.verified, true);
    assert.equal(receipt.target, 'receipt-history.txt');
    assert.ok(receipt.at);
    assert.equal(Object.hasOwn(receipt, 'evidence'), false, 'raw tool output must not enter the transcript payload');
    assert.equal(Object.hasOwn(receipt, 'input'), false);
    await server.close({ keep: true });
    server = await startTestServer({ home });
    const after = await read();
    assert.equal(after.status, 200, 'the second session must survive host restart');
    assert.deepEqual(after.body.conversation.goals.flatMap((goal) => goal.receipts), receipts);
    assert.equal(fs.readFileSync(path.join(home, 'workspace', 'receipt-history.txt'), 'utf8'), 'persisted');
  } finally {
    await server.close();
  }
});

async function apiJson(s, cookie, path, init = {}) {
  const res = await fetch(`${s.base}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.method && init.method !== 'GET' ? { 'x-majin-csrf': '1', 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('history: rename is manual and later messages never overwrite it', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen namn.txt med innehåll: x');
    const id = first.done.conversationId;

    const renamed = await apiJson(s, cookie, '/api/conversations', {
      method: 'PATCH',
      body: JSON.stringify({ id, title: 'Mitt projekt' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.conversation.title, 'Mitt projekt');
    assert.equal(renamed.body.conversation.titlePolicy, 'manual');

    await chat(s, cookie, 'Lista filerna i arbetsytan', { conversationId: id });
    const read = await apiJson(s, cookie, `/api/conversation?id=${id}`);
    assert.equal(read.body.conversation.title, 'Mitt projekt', 'an automatic title replaced a manual one');
  } finally {
    await s.close();
  }
});

test('history: the first user message titles a new conversation automatically', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen auto.txt med innehåll: x');
    const read = await apiJson(s, cookie, `/api/conversation?id=${first.done.conversationId}`);
    assert.equal(read.body.conversation.title, 'Skriv filen auto.txt med innehåll: x');
    assert.equal(read.body.conversation.titlePolicy, 'auto');
  } finally {
    await s.close();
  }
});

test('history: archive is reversible and separates the two views', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const first = await chat(s, cookie, 'Skriv filen ark.txt med innehåll: x');
    const id = first.done.conversationId;

    const archived = await apiJson(s, cookie, '/api/conversations', {
      method: 'PATCH',
      body: JSON.stringify({ id, archived: true }),
    });
    assert.equal(archived.status, 200);
    assert.ok(archived.body.conversation.archivedAt);

    const active = await apiJson(s, cookie, '/api/conversations?view=active');
    assert.ok(!active.body.conversations.some((c) => c.id === id), 'an archived chat is not in the active list');
    const onlyArchived = await apiJson(s, cookie, '/api/conversations?view=archived');
    assert.ok(onlyArchived.body.conversations.some((c) => c.id === id));

    // It is still openable: archiving is a filter, not a delete.
    const read = await apiJson(s, cookie, `/api/conversation?id=${id}`);
    assert.equal(read.status, 200);

    await apiJson(s, cookie, '/api/conversations', {
      method: 'PATCH',
      body: JSON.stringify({ id, archived: false }),
    });
    const back = await apiJson(s, cookie, '/api/conversations?view=active');
    assert.ok(back.body.conversations.some((c) => c.id === id));
  } finally {
    await s.close();
  }
});

test('history: search matches transcript text, not only titles', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    await chat(s, cookie, 'Skriv filen alfa.txt med innehåll: hemlig markör');
    await chat(s, cookie, 'Skriv filen beta.txt med innehåll: annat');

    const hit = await apiJson(s, cookie, '/api/conversations?view=all&q=markör');
    assert.equal(hit.body.conversations.length, 1);
    assert.match(hit.body.conversations[0].title, /alfa/);

    const miss = await apiJson(s, cookie, '/api/conversations?view=all&q=ingentingalls');
    assert.equal(miss.body.conversations.length, 0);
  } finally {
    await s.close();
  }
});

test('history: two devices see the same list, and a new turn on one appears on the other', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const phone = (await s.pair()).cookie;
    const desktop = s.existingSession();

    const first = await chat(s, phone, 'Skriv filen delad.txt med innehåll: från telefonen');
    const id = first.done.conversationId;

    const onDesktop = await apiJson(s, desktop, '/api/conversations');
    assert.equal(onDesktop.body.conversations.length, 1, 'the desktop does not see the phone conversation');
    assert.equal(onDesktop.body.conversations[0].id, id);

    // Continue on the desktop; the phone must pick the message up via the
    // cursor, not by reloading the entire list.
    const cursor = onDesktop.body.serverTime;
    await new Promise((r) => setTimeout(r, 10));
    await chat(s, desktop, 'Lista filerna i arbetsytan', { conversationId: id });

    const delta = await apiJson(s, phone, `/api/conversations?view=all&since=${encodeURIComponent(cursor)}`);
    assert.ok(delta.body.conversations.some((c) => c.id === id), 'the change did not show up through the cursor');
    assert.ok(delta.body.conversations.find((c) => c.id === id).version > onDesktop.body.conversations[0].version);

    const conv = await apiJson(s, phone, `/api/conversation?id=${id}`);
    assert.ok(conv.body.conversation.messages.length >= 4, 'the phone cannot read the continued transcript');
    const texts = conv.body.conversation.messages.map((m) => m.content).join('\n');
    assert.match(texts, /från telefonen/);
    assert.match(texts, /Lista filerna/);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('history: a deletion on one device does not come back on the other', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const phone = (await s.pair()).cookie;
    const desktop = s.existingSession();
    const first = await chat(s, phone, 'Skriv filen borta.txt med innehåll: x');
    const id = first.done.conversationId;

    const before = await apiJson(s, desktop, '/api/conversations');
    assert.equal(before.body.conversations.length, 1);

    const del = await apiJson(s, phone, `/api/conversations?id=${id}&confirm=1`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const after = await apiJson(s, desktop, '/api/conversations');
    assert.equal(after.body.conversations.length, 0, 'the other device still lists a deleted chat');
    assert.ok(after.body.deleted.some((d) => d.id === id), 'no tombstone was reported');

    const opened = await apiJson(s, desktop, `/api/conversation?id=${id}`);
    assert.equal(opened.status, 404);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('history: deleting while a turn runs is refused, and explicit cancel then deletes', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const created = await apiJson(s, cookie, '/api/conversations', { method: 'POST', body: '{}' });
    const id = created.body.conversation.id;

    // A real turn is registered through exactly this call in the chat route.
    // Starting it here makes the guard deterministic instead of racing a fast
    // demo turn that may already have finished.
    s.context.agent.beginTurn(`conv:${id}`, { owner: 'test-device' });

    const refused = await apiJson(s, cookie, `/api/conversations?id=${id}&confirm=1`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'TURN_RUNNING');

    const forced = await apiJson(s, cookie, `/api/conversations?id=${id}&confirm=1&cancel=1`, { method: 'DELETE' });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.cancelled, true);

    const list = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.ok(!list.body.conversations.some((c) => c.id === id));
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('history: conversations, titles and archive state survive a restart', async () => {
  const home = tempHome();
  const first = await startTestServer({ home });
  let id;
  let cookie;
  try {
    cookie = (await first.pair()).cookie;
    const turn = await chat(first, cookie, 'Skriv filen består.txt med innehåll: x');
    id = turn.done.conversationId;
    await apiJson(first, cookie, '/api/conversations', {
      method: 'PATCH',
      body: JSON.stringify({ id, title: 'Bestående' }),
    });
  } finally {
    await first.close({ keep: true });
  }

  const second = await startTestServer({ home });
  try {
    const reopened = second.existingSession();
    const list = await apiJson(second, reopened, '/api/conversations');
    const found = list.body.conversations.find((c) => c.id === id);
    assert.ok(found, 'the conversation did not survive the restart');
    assert.equal(found.title, 'Bestående');
    const conv = await apiJson(second, reopened, `/api/conversation?id=${id}`);
    assert.ok(conv.body.conversation.messages.length >= 2);
  } finally {
    await second.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('history: importing V1 transcripts never touches the source and is idempotent', async () => {
  const home = tempHome();
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const write = (id, lines) => fs.writeFileSync(
    path.join(sessions, `${id}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  write('gammal-1', [
    { role: 'system', content: 'ignored' },
    { role: 'user', content: 'Hej från V1', ts: '2026-09-01T10:00:00.000Z' },
    { role: 'assistant', content: 'Hej! Hur kan jag hjälpa?', ts: '2026-09-01T10:00:05.000Z' },
    { role: 'tool', content: 'tool output is not a chat message' },
  ]);
  write('gammal-2', [
    { role: 'user', content: 'Andra samtalet', ts: '2026-09-02T10:00:00.000Z' },
    { role: 'assistant', content: 'Svar', ts: '2026-09-02T10:00:01.000Z' },
  ]);
  fs.writeFileSync(path.join(sessions, 'chats-index.json'), JSON.stringify({
    version: 'majin-chats/1',
    chats: {
      'gammal-1': { id: 'gammal-1', title: 'Ett gammalt samtal', titlePolicy: 'manual', archivedAt: null },
    },
  }));
  const before = fs.readdirSync(sessions).sort().map((f) => [f, fs.readFileSync(path.join(sessions, f), 'utf8')]);

  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();

    const dry = await apiJson(s, cookie, '/api/conversations/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'v1', dryRun: true }),
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.plan.create.length, 2);
    const listedAfterDry = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.equal(listedAfterDry.body.conversations.length, 0, 'a dry run wrote something');

    const applied = await apiJson(s, cookie, '/api/conversations/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'v1', dryRun: false }),
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.result.created.length, 2);

    const list = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.equal(list.body.conversations.length, 2);
    const titled = list.body.conversations.find((c) => c.title === 'Ett gammalt samtal');
    assert.ok(titled, 'the V1 title was not preserved');
    assert.equal(titled.messages, 2, 'tool and system rows must not become chat messages');

    // Importing again must not duplicate anything.
    const again = await apiJson(s, cookie, '/api/conversations/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'v1', dryRun: false }),
    });
    assert.equal(again.body.result.created.length, 0);
    assert.equal(again.body.result.merged.length, 0);
    const list2 = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.equal(list2.body.conversations.length, 2);

    // The source directory is byte-for-byte unchanged.
    const after = fs.readdirSync(sessions).sort().map((f) => [f, fs.readFileSync(path.join(sessions, f), 'utf8')]);
    assert.deepEqual(after, before, 'the import modified the V1 source files');
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('history: a growing V1 transcript is merged, not duplicated', async () => {
  const home = tempHome();
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'växer.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ role: 'user', content: 'första' })}\n`);

  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await apiJson(s, cookie, '/api/conversations/import', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
    const first = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.equal(first.body.conversations.length, 1);
    assert.equal(first.body.conversations[0].messages, 1);

    fs.appendFileSync(file, `${JSON.stringify({ role: 'assistant', content: 'andra' })}\n`);
    const second = await apiJson(s, cookie, '/api/conversations/import', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
    assert.equal(second.body.result.created.length, 0);
    assert.equal(second.body.result.merged.length, 1);
    assert.equal(second.body.result.merged[0].added, 1);

    const list = await apiJson(s, cookie, '/api/conversations?view=all');
    assert.equal(list.body.conversations.length, 1, 'the merge created a duplicate conversation');
    const conv = await apiJson(s, cookie, `/api/conversation?id=${list.body.conversations[0].id}`);
    assert.deepEqual(conv.body.conversation.messages.map((m) => m.content), ['första', 'andra']);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
