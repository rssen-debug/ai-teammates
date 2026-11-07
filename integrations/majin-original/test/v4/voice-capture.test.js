import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceActivity, VoiceCapture, recordingType } from '../../src/v4/ui/recorder.js';
import { startTestServer } from './helpers.mjs';

test('capture: AAC/MP4 is preferred when WebKit supports it; no unsupported forced codec', () => {
  assert.equal(recordingType({ isTypeSupported: (type) => type === 'audio/mp4' }), 'audio/mp4');
  assert.equal(recordingType({ isTypeSupported: (type) => type === 'audio/webm' }), 'audio/webm');
  assert.equal(recordingType({}), '');
});

test('capture: sustained speech interrupts once, brief noise does not; silence ends the utterance', () => {
  const vad = new VoiceActivity();
  assert.equal(vad.update(0.1, 100).onset, false);
  assert.equal(vad.update(0, 150).onset, false);
  assert.equal(vad.update(0.1, 200).onset, false);
  assert.equal(vad.update(0.1, 400).onset, true);
  assert.equal(vad.update(0.1, 500).onset, false);
  assert.equal(vad.update(0, 1400).end, true);
});

test('capture: permission denial is surfaced and closes the AudioContext without retries', async () => {
  let closed = 0, calls = 0; const errors = [];
  const scope = {
    AudioContext: class { resume() { return Promise.resolve(); } close() { closed++; return Promise.resolve(); } },
    navigator: { mediaDevices: { async getUserMedia() { calls++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } },
    clearInterval() {},
  };
  const capture = new VoiceCapture({ scope, onError: (e) => errors.push(e.name) });
  await capture.start();
  assert.equal(capture.active, false); assert.equal(closed, 1); assert.equal(calls, 1);
  assert.deepEqual(errors, ['NotAllowedError']);
});

test('capture: a late permission grant after stopping releases every track', async () => {
  let grant, stopped = 0;
  const scope = {
    AudioContext: class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise((r) => { grant = r; }) } }, clearInterval() {},
  };
  const capture = new VoiceCapture({ scope });
  const pending = capture.start(); capture.stop();
  grant({ getTracks: () => [{ stop() { stopped++; } }] }); await pending;
  assert.equal(stopped, 1); assert.equal(capture.active, false); assert.equal(capture.timer, null);
});

test('capture: stale transcription completion cannot rearm or stop a newly started session', async () => {
  let finish; let created = 0;
  const scope = { Blob, clearInterval() {}, navigator: {}, MediaRecorder: class {
    constructor() { created++; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.stopped = this.onstop?.(); }
  } };
  const capture = new VoiceCapture({ scope, onSegment: () => new Promise((resolve) => { finish = resolve; }) });
  capture.active = true; capture.activity = new VoiceActivity(); capture.record();
  const first = capture.recorder;
  capture.activity.speaking = true; first.ondataavailable({ data: new Blob(['audio']) }); first.stop();
  capture.stop(); capture.active = true; capture.record(); const second = capture.recorder;
  finish(); await first.stopped;
  assert.equal(created, 2); assert.equal(capture.recorder, second); assert.equal(capture.active, true);
  capture.stop();
});

test('STT HTTP: authenticated/CSRF protected, bounded, no configured engine fails honestly, audio is removed', async () => {
  const previous = process.env.MAJIN_V4_STT_COMMAND;
  delete process.env.MAJIN_V4_STT_COMMAND;
  const server = await startTestServer();
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('majin-stt-')));
  try {
    const { cookie } = await server.pair();
    const post = (body, headers = {}) => fetch(`${server.base}/api/voice/transcribe`, {
      method: 'POST', headers: { cookie, origin: server.base, 'content-type': 'application/json', 'x-majin-csrf': '1', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await post({}, { cookie: '' })).status, 401);
    assert.equal((await post({}, { 'x-majin-csrf': '' })).status, 403);
    assert.equal((await post({})).status, 503);
    process.env.MAJIN_V4_STT_COMMAND = `"${process.execPath}" "${path.resolve('scripts/v4/voice-fixture.mjs')}" stt {WAV}`;
    assert.equal((await post({ type: 'text/plain', data: 'AA==' })).status, 415);
    assert.equal((await post({ type: 'audio/mp4', data: '@invalid' })).status, 400);
    assert.equal((await post({ type: 'audio/mp4', data: '' })).status, 413);
    const data = Buffer.concat([Buffer.alloc(44), Buffer.from('MAJINSTT:hej från mikrofonen')]).toString('base64');
    const response = await post({ type: 'audio/mp4;codecs=mp4a.40.2', data });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).transcript, 'hej från mikrofonen');
    const empty = await post({ type: 'audio/webm', data: Buffer.alloc(64).toString('base64') });
    assert.equal(empty.status, 422);
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('majin-stt-') && !before.has(name));
    assert.deepEqual(after, [], 'no raw recordings retained');
  } finally {
    if (previous === undefined) delete process.env.MAJIN_V4_STT_COMMAND; else process.env.MAJIN_V4_STT_COMMAND = previous;
    await server.close();
  }
});
