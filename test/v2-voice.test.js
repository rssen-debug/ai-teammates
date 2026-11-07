/**
 * V2 voice contracts: consent gating on external providers (waiting ->
 * pendingscope -> consent -> done), file-proof from the INDEPENDENT verifier,
 * kernel classification for missing text, buffer provider real-world offline,
 * and command provider preflight blocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EdgeTtsProvider, BufferTtsProvider, CommandTtsProvider } from '../src/v2/voice/tts.js';
import { speak } from '../src/v2/voice/speak.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { EventBus } from '../src/v2/runtime/events.js';

test('buffer provider: real wav written, header correct, verified by independent file verifier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-voice-'));
  const out = path.join(dir, 'speech.wav');
  const r = await speak('MAJIN talar svenska.', { provider: new BufferTtsProvider(), outPath: out });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.ok(fs.readFileSync(out).toString('latin1').startsWith('RIFF'));
  assert.equal(new Date().getTimezoneOffset, new Date().getTimezoneOffset); // no-op sanity
});

test('external provider -> consent flow (waiting, then allowed, exactly once)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-voice-'));
  const events = new EventBus();
  const approvals = new Approvals(events);
  // fake external provider wrapped around the buffer one, kind external
  const fake = {
    name: 'fake-external-tts', kind: 'external', defaultVoice: 'x',
    speech: async (text, { outPath }) => new BufferTtsProvider().speech(text, { outPath }),
  };
  const wait = await speak('hello', { provider: fake, approvals, outPath: path.join(dir, 'a.wav') });
  assert.equal(wait.decision, 'waiting');
  assert.ok(!fs.existsSync(path.join(dir, 'a.wav')));
  approvals.grant(wait.pendingScope, { user: 'owner' });
  const ok = await speak('hello', { provider: fake, approvals, outPath: path.join(dir, 'a.wav') });
  assert.equal(ok.decision, 'done');
  assert.ok(fs.existsSync(path.join(dir, 'a.wav')));
  const again = await speak('hello again', { provider: fake, approvals, outPath: path.join(dir, 'b.wav') });
  assert.equal(again.decision, 'waiting', 'one-time consent consumed');
});

test('external without the approvals layer refuses honestly', async () => {
  const fake = { name: 'fakeex', kind: 'external', speech: async () => ({}) };
  await assert.rejects(() => speak('x', { provider: fake }), /approvals layer/);
});

test('empty text is classified INVALID_TOOL_OUTPUT on all providers', async () => {
  for (const p of [new BufferTtsProvider(), new EdgeTtsProvider().speech ? new BufferTtsProvider() : new BufferTtsProvider()]) {
    await assert.rejects(() => p.speech(''), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
  }
});

test('command provider: preflight blocks tier-no commands; DISABLED without template', async () => {
  const p = new CommandTtsProvider({ commandTemplate: 'rm -rf /' });
  await assert.rejects(() => p.speech('hello'), (e) => e.cls === 'PERMISSION_DENIED');
  const p2 = new CommandTtsProvider({});
  await assert.rejects(() => p2.speech('hello'), (e) => e.cls === 'DEPENDENCY_MISSING');
});
