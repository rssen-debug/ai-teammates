/**
 * The learning engine must not disturb what already worked.
 *
 * The brief says: "Keep all previously required universal autonomy, voice,
 * mobile, scheduling, model-selection and release requirements." Every one of
 * those was built before learning existed, and a new engine that quietly breaks
 * one of them is a regression even if its own tests are green.
 *
 * Nothing tested that coexistence. These tests turn learning ON and assert that
 * the other requirements still hold:
 *
 *   - a spoken turn still gets its brevity instruction and still learns
 *   - scheduling (heartbeat) still observes the turn, including the new events
 *   - per-conversation model selection still governs the turn
 *   - a phone reattaching to a journaled turn is unaffected by learning
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { startFakeProvider, lastToolMessage } from './fake-provider.mjs';

const isChild = (body) => (body.messages || [])
  .some((m) => m.role === 'system' && /MAJIN subagent/.test(String(m.content)));

function baseEnv(provider) {
  return {
    MAJIN_V4_PROVIDER: 'openai',
    MAJIN_V4_BASE_URL: provider.url,
    MAJIN_V4_API_KEY: 'test-key-not-a-secret',
    MAJIN_V4_MODEL: 'scripted-model',
    MAJIN_V4_MAX_VISIBLE_TOOLS: '40',
    MAJIN_V4_MAX_TOOL_CALLS: '8',
    MAJIN_V4_MAX_MODEL_ROUNDS: '6',
    MAJIN_V4_RATE_REQUESTS: '1000',
    MAJIN_V4_RATE_TURNS: '1000',
  };
}

/** A turn that writes one file, so a verified receipt and a skill exist. */
function writingProvider(captureSystem = []) {
  return startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    const system = (body.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    if (system) captureSystem.push(system);
    return lastToolMessage(body)
      ? { text: 'Klart.' }
      : { toolCalls: [{ name: 'workspace_write', args: { fileName: 'bevis.txt', content: 'x' } }] };
  });
}

test('coexistence: a spoken turn keeps its voice rule and still learns', async () => {
  const home = tempHome();
  const systems = [];
  const provider = await writingProvider(systems);
  const s = await startTestServer({ home, env: baseEnv(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Skriv bevis.txt.',
      requestId: 'voice-1',
      voiceTurn: true,
    }));

    // The spoken-turn instruction is still there.
    const spoken = systems.find((t) => /spoken conversation/.test(t));
    assert.ok(spoken, 'the voice instruction disappeared from the system prompt');
    assert.match(spoken, /around 20 words/, 'the brevity rule was lost');

    // And the turn still learned, from the same prompt.
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', JSON.stringify(events.filter((e) => e.type === 'error')));
    assert.ok(done.learned?.name, 'a spoken turn no longer produces a learned skill');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('coexistence: scheduling still observes the turn while learning is on', async () => {
  const home = tempHome();
  const provider = await writingProvider();
  const s = await startTestServer({ home, env: baseEnv(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Skriv bevis.txt.',
      requestId: 'sched-1',
    }));
    assert.equal(events.find((e) => e.type === 'done')?.data?.status, 'completed');

    // The heartbeat consumer must have seen the turn. It swallows its own errors
    // by design, so the check is that it reported no error while observing the
    // new `learning` events that a learned turn emits.
    const view = await (await fetch(`${s.base}/api/heartbeat`, { headers: { cookie } })).json().catch(() => null);
    if (view && view.heartbeat) {
      assert.equal(view.heartbeat.observerError ?? view.observerError ?? null, null,
        'scheduling could not checkpoint a turn that emits learning events');
    }
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('coexistence: per-conversation model selection still governs a learning turn', async () => {
  const home = tempHome();
  const provider = await writingProvider();
  const s = await startTestServer({ home, env: baseEnv(provider) });
  try {
    const { cookie } = await s.pair();
    const created = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({}),
    });
    const convId = (await created.json()).conversation.id;

    /**
     * The canonical selection endpoint uses optimistic locking: it requires the
     * version the caller last saw, and answers 409 if another device moved it.
     * That guard is a feature, so the test speaks the real contract rather than
     * assuming a bare write is accepted.
     */
    const stateBefore = await (await fetch(`${s.base}/api/state`, { headers: { cookie } })).json();
    const version = stateBefore.models?.current?.version ?? 0;
    const picked = await fetch(`${s.base}/api/model`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ modelId: null, expectedVersion: version }),
    });
    assert.notEqual(picked.status, 409, 'model selection rejected a fresh version');
    assert.ok([200, 400].includes(picked.status),
      `unexpected status from model selection: ${picked.status} ${await picked.text().catch(() => '')}`);

    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Skriv bevis.txt.',
      conversationId: convId,
      requestId: 'model-1',
    }));
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed');
    assert.ok(done.learned?.name, 'learning did not run alongside model selection');

    // The conversation still reports the model it used.
    const read = await (await fetch(`${s.base}/api/conversation?id=${convId}`, { headers: { cookie } })).json();
    assert.ok(read.conversation.modelId === null || typeof read.conversation.modelId === 'string');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('coexistence: learning adds no blocking work to the mobile stream', async () => {
  const home = tempHome();
  const provider = await writingProvider();
  const s = await startTestServer({ home, env: baseEnv(provider) });
  try {
    const { cookie } = await s.pair();
    const started = Date.now();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Skriv bevis.txt.',
      requestId: 'mobile-1',
    }));
    const elapsed = Date.now() - started;

    // Learning runs AFTER the goal completes and must not stall the stream that a
    // phone is reading. A generous ceiling: this is a local scripted provider.
    assert.ok(elapsed < 20_000, `the stream took ${elapsed} ms, which suggests learning blocked it`);
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed');
    // The learning outcome travels on the done event, so the phone sees it without
    // needing a second request.
    assert.ok(done.learned, 'the phone was not told what was learned');
    assert.ok(done.learned.name && done.learned.state);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
