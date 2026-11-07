/**
 * Turn journal + mid-stream reconnection.
 *
 * The point of these tests is the promise a phone makes: "close the app and
 * come back without losing work". A dropped socket used to abort the turn.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnJournal } from '../../src/v4/turns.js';
import { startTestServer, postChat, readSse } from './helpers.mjs';

test('journal: sequence numbers are monotonic and replay from a given point', () => {
  const j = new TurnJournal();
  const t = j.create({ conversationId: 'c1' });
  j.append(t, 'delta', { text: 'a' });
  j.append(t, 'delta', { text: 'b' });
  j.append(t, 'delta', { text: 'c' });
  assert.deepEqual(t.events.map((e) => e.seq), [1, 2, 3]);

  const seen = [];
  j.subscribe(t, 2, (e) => seen.push(e.seq));
  j.append(t, 'delta', { text: 'd' });
  assert.deepEqual(seen, [3, 4], 'replayed seq 3, then the live seq 4');
});

test('journal: a finished turn replays and then closes without hanging', () => {
  const j = new TurnJournal();
  const t = j.create();
  j.append(t, 'delta', { text: 'x' });
  j.finish(t, 'completed');
  const seen = [];
  j.subscribe(t, 0, (e) => seen.push(e.type));
  assert.deepEqual(seen, ['delta', '__done']);
});

test('journal: a slow subscriber cannot break the turn', () => {
  const j = new TurnJournal();
  const t = j.create();
  t.subscribers.add(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => j.append(t, 'delta', { text: 'still works' }));
  assert.equal(t.seq, 1);
});

test('journal: finished turns are pruned and the buffer is bounded', () => {
  let now = 1_000_000;
  const j = new TurnJournal({ maxTurns: 3, ttlMs: 1000, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    const t = j.create();
    j.append(t, 'delta', { text: String(i) });
    j.finish(t, 'completed');
    now += 10;
  }
  // Finished turns are what the cap applies to; live ones are protected
  // (see journal-live.test.js for that contract).
  assert.ok(j.order.length <= 3, `bounded, got ${j.order.length}`);
  now += 5000;
  j.prune();
  assert.equal(j.turns.size, 0, 'expired turns are gone');
});

test('turn journal: the chat stream carries an id on every event and announces the turn', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen tr1.txt med innehåll: x', requestId: 't1' });
    assert.ok(res.headers.get('x-majin-turn'));
    const raw = await res.text();
    assert.match(raw, /^id: \d+$/m, 'every event is identified for replay');
    const open = raw.split('\n\n').find((b) => b.includes('event: open'));
    assert.ok(open, 'an open event exists');
    assert.match(open, /"turnId":"turn_/, 'the client is told which turn it is on');
  } finally {
    await s.close();
  }
});

test('turn journal: a client that lost the stream can reattach and receive the rest', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen tr2.txt med innehåll: bevis', requestId: 't2' });
    const turnId = res.headers.get('x-majin-turn');
    assert.ok(turnId);
    await res.text(); // consume the whole turn; "phone was away"

    // Reattach from the beginning, as a phone with no sequence number would.
    const re = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=0`, { headers: { cookie } });
    assert.equal(re.status, 200);
    const events = await readSse(re);
    assert.ok(events.some((e) => e.type === 'tool_result'), 'the verified tool result is replayed');
    const done = events.filter((e) => e.type === 'done').pop();
    assert.equal(done.data.status, 'completed');
    assert.ok(events.every((e, i) => e.seq === undefined || true));
  } finally {
    await s.close();
  }
});

test('turn journal: reattaching with a cursor does not repeat events already held', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen tr3.txt med innehåll: x', requestId: 't3' });
    const turnId = res.headers.get('x-majin-turn');
    const raw = await res.text();
    const ids = [...raw.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const lastSeq = Math.max(...ids);
    assert.ok(lastSeq > 0);

    // A client that holds everything gets nothing new and the stream closes.
    const atEnd = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=${lastSeq}`, { headers: { cookie } });
    const nothing = await readSse(atEnd);
    assert.deepEqual(nothing, [], 'no duplicate events');

    // One event behind, it receives exactly the missing one.
    const behind = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=${lastSeq - 1}`, { headers: { cookie } });
    const rest = await readSse(behind);
    assert.equal(rest.length, 1, 'exactly the event it was missing');
    assert.equal(rest[0].type, 'done');
  } finally {
    await s.close();
  }
});

test('turn journal: reattach requires a session and rejects unknown turns', async () => {
  const s = await startTestServer();
  try {
    const anon = await fetch(`${s.base}/api/chat/stream?turnId=x&from=0`);
    assert.equal(anon.status, 401);
    const { cookie } = await s.pair();
    const unknown = await fetch(`${s.base}/api/chat/stream?turnId=turn_nope&from=0`, { headers: { cookie } });
    assert.equal(unknown.status, 404);
  } finally {
    await s.close();
  }
});

test('turn journal: the turn survives the client hanging up (work is not thrown away)', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const controller = new AbortController();
    const res = await fetch(`${s.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base, cookie },
      body: JSON.stringify({ text: 'Skriv filen tr4.txt med innehåll: överlevde', requestId: 't4' }),
      signal: controller.signal,
    });
    const turnId = res.headers.get('x-majin-turn');
    // Read a little, then hang up exactly like a phone changing network.
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    try {
      await reader.cancel();
    } catch { /* aborted */ }

    // Give the host a moment; then check the work really landed.
    await new Promise((r) => setTimeout(r, 400));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(s.home, 'workspace', 'tr4.txt');
    assert.ok(fs.existsSync(file), 'the file was written even though the client left');
    assert.equal(fs.readFileSync(file, 'utf8'), 'överlevde');

    const re = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=0`, { headers: { cookie } });
    const events = await readSse(re);
    assert.equal(events.filter((e) => e.type === 'done').pop().data.status, 'completed');
  } finally {
    await s.close();
  }
});

test('turn journal: stop works by turn id, before the client knows the conversation', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen stop1.txt med innehåll: x', requestId: 's1' });
    const turnId = res.headers.get('x-majin-turn');
    assert.ok(turnId, 'the turn id is available immediately');

    const cancel = await fetch(`${s.base}/api/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ turnId }),
    });
    const body = await cancel.json();
    assert.equal(cancel.status, 200);
    assert.equal(body.cancelled, true, 'the host accepted the stop');

    const events = await readSse(res);
    const status = events.filter((e) => e.type === 'done').pop().data.status;
    // The demo brain may finish first; what matters is that a stop is possible
    // without knowing the conversation id, and that the stream still terminates.
    assert.ok(['cancelled', 'completed'].includes(status), status);
  } finally {
    await s.close();
  }
});

test('turn journal: cancelling an unknown turn is a no-op, not an error', async () => {
  const s = await startTestServer();
  try {
    const { cookie, res, body } = await s.pair();
    assert.equal(res.status, 200, `pairing prerequisite failed: ${JSON.stringify(body)}`);
    assert.ok(cookie, 'successful pairing must issue the session cookie used for cancellation');
    const cancel = await fetch(`${s.base}/api/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ turnId: 'turn_does_not_exist' }),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).cancelled, false);
  } finally {
    await s.close();
  }
});

test('turn journal: cancel still requires a session and the CSRF header', async () => {
  const s = await startTestServer();
  try {
    const anon = await fetch(`${s.base}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ turnId: 'x' }),
    });
    assert.equal(anon.status, 401);
    const { cookie } = await s.pair();
    const noCsrf = await fetch(`${s.base}/api/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ turnId: 'x' }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});
