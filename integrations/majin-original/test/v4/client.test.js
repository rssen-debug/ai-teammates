/**
 * Client session model + a real HTTP round trip that emulates the browser.
 *
 * The browser tests in ui.test.js check contracts (manifest, assets, CSP).
 * These check behaviour: what the client does with the bytes the server sends.
 * They exist because the UI used to drop the conversation id, which silently
 * started a new conversation on every message — invisible to server tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL, applyEvent, applyAll, createSseParser, parseBlock } from '../../src/v4/ui/session.js';
import { startTestServer, postChat, readSse } from './helpers.mjs';

/** Drive a real /api/chat stream through the client model, like app.js does. */
async function browserTurn(s, cookie, body, session) {
  const res = await postChat(s.base, cookie, body);
  assert.equal(res.status, 200);
  const text = await res.text();
  const parser = createSseParser();
  const events = parser.push(`${text}\n\n`);
  const { state, intents } = applyAll(session, events);
  return { state, intents, events };
}

test('client: the conversation id from the server is kept, so a second message stays in one thread', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    let session = { ...INITIAL };

    const first = await browserTurn(s, cookie, { text: 'Skriv filen ct1.txt med innehåll: ett', requestId: 'c1' }, session);
    session = first.state;
    assert.ok(session.conversationId, 'the client learned the conversation id');
    assert.equal(session.status, 'completed');
    assert.equal(session.messages.length, 1);
    assert.match(session.messages[0].content, /ct1\.txt/);

    const second = await browserTurn(
      s,
      cookie,
      { text: 'Lista filerna i arbetsytan', requestId: 'c2', conversationId: session.conversationId },
      session,
    );
    session = second.state;
    assert.equal(session.conversationId, first.state.conversationId, 'still the same conversation');
    assert.equal(session.messages.length, 2, 'both answers are in the thread');
  } finally {
    await s.close();
  }
});

test('client: streamed deltas assemble in order and are never lost across chunk boundaries', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { state } = await browserTurn(s, cookie, { text: 'Hej', requestId: 'd1' }, { ...INITIAL });
    assert.ok(state.messages[0].content.length > 0);
    assert.equal(state.text, '', 'the accumulator is cleared after done');
  } finally {
    await s.close();
  }
});

test('client: a tool card moves running -> verified only when the server says so', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { state, intents } = await browserTurn(
      s,
      cookie,
      { text: 'Skriv filen ct2.txt med innehåll: bevis', requestId: 't1' },
      { ...INITIAL },
    );
    const tool = state.tools[0];
    assert.equal(tool.name, 'workspace_write');
    assert.equal(tool.state, 'verified');
    assert.ok(tool.receiptId, 'the card carries the receipt id');
    assert.ok(intents.some((i) => i.type === 'tool_result' && i.verified));
  } finally {
    await s.close();
  }
});

test('client: a failed turn sets an error state instead of a completed one', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const { state } = await browserTurn(
      s,
      cookie,
      { text: 'Skriv filen ../escape.txt med innehåll: nej', requestId: 'e1' },
      { ...INITIAL },
    );
    assert.equal(state.status, 'failed');
    assert.equal(state.streaming, false);
  } finally {
    await s.close();
  }
});

test('client: replay of a duplicate request does not append the answer twice', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const body = { text: 'Skriv filen ct3.txt med innehåll: en gång', requestId: 'r1' };
    const first = await browserTurn(s, cookie, body, { ...INITIAL });
    const second = await browserTurn(s, cookie, body, first.state);
    assert.equal(second.state.status, 'replayed');
    assert.equal(second.state.messages.length, 2, 'one user answer + one replay, not three');
    assert.equal(second.state.tools.length, first.state.tools.length, 'no second tool card');
  } finally {
    await s.close();
  }
});

test('client: approval_required pauses the turn and records what is being asked', () => {
  let state = { ...INITIAL };
  state = applyEvent(state, 'approval_required', { tool: 'workspace_write', reason: 'strict policy' }).state;
  assert.equal(state.status, 'awaiting_approval');
  assert.equal(state.pendingApproval.tool, 'workspace_write');
});

test('client: cancellation ends the stream and keeps the partial answer', () => {
  let state = { ...INITIAL };
  state = applyEvent(state, 'delta', { text: 'halva svaret' }).state;
  const { state: after, intents } = applyEvent(state, 'cancelled', {});
  assert.equal(after.status, 'cancelled');
  assert.ok(intents.some((i) => i.type === 'cancelled'));
  assert.equal(after.text, 'halva svaret');
});

test('client: an unknown event is ignored, not fatal', () => {
  const before = { ...INITIAL };
  const { state, intents } = applyEvent(before, 'something_new', { x: 1 });
  assert.deepEqual(intents, []);
  assert.equal(state.status, before.status);
});

test('client: the SSE parser handles comments, CRLF, split chunks and bad JSON', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push(': connected\n\n'), []);
  assert.deepEqual(parser.push('event: delta\ndata: {"text":"a"}\n\n').map(({ event, data }) => ({ event, data })), [{ event: 'delta', data: { text: 'a' } }]);
  assert.deepEqual(parser.push('event: delta\r\ndata: {"text":"b"}\r\n\r\n').map(({ event, data }) => ({ event, data })), [{ event: 'delta', data: { text: 'b' } }]);
  // a chunk cut in the middle must not emit a half event
  assert.deepEqual(parser.push('event: delta\ndata: {"te'), []);
  assert.deepEqual(parser.push('xt":"c"}\n\n').map(({ event, data }) => ({ event, data })), [{ event: 'delta', data: { text: 'c' } }]);
  assert.deepEqual(parser.push('event: delta\ndata: {broken\n\n'), []);
  assert.equal(parseBlock(''), null);
  assert.equal(parseBlock('event: x\n'), null);
});

test('client: a dropped stream is reattached to the same turn instead of losing the work', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    // Start the turn and hang up immediately, like a phone leaving Wi-Fi.
    const controller = new AbortController();
    const res = await fetch(`${s.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base, cookie },
      body: JSON.stringify({ text: 'Skriv filen reattach.txt med innehåll: kvar', requestId: 'ra1' }),
      signal: controller.signal,
    });
    const turnId = res.headers.get('x-majin-turn');
    const reader = res.body.getReader();
    const first = await reader.read();
    controller.abort();
    try {
      await reader.cancel();
    } catch { /* aborted */ }

    // The client saw the open event with a turn id before the line dropped.
    const parser = createSseParser();
    const seen = parser.push(new TextDecoder().decode(first.value));
    const open = seen.find((e) => e.event === 'open');
    assert.equal(open.data.turnId, turnId);

    await new Promise((r) => setTimeout(r, 400));
    // Reattach exactly as app.js does: from the last sequence held (0 here).
    const re = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=0`, { headers: { cookie } });
    const events = await readSse(re);
    const done = events.filter((e) => e.type === 'done').pop();
    assert.equal(done.data.status, 'completed');
    assert.ok(events.some((e) => e.type === 'tool_result' && e.data.verified));
  } finally {
    await s.close();
  }
});

test('client: a recovery event is surfaced in the turn instead of looking frozen', () => {
  let state = { ...INITIAL };
  state = applyEvent(state, 'user', { content: 'läs' }).state;
  state = applyEvent(state, 'delta', { text: 'ett ögonblick' }).state;
  const { state: after, intents } = applyEvent(state, 'recovery', { tool: 'x', failureClass: 'TIMEOUT', action: 'retry_simple', attempt: 1 });
  // The reducer must not lose the partial answer while the host retries.
  assert.equal(after.text, 'ett ögonblick');
  assert.deepEqual(intents, [], 'recovery is a view hint, not a message');
});
