import assert from 'node:assert/strict';
import test from 'node:test';
import { playNarratorStream } from '../../src/v4/ui/voice.js';
import { localNarratorStream, voiceCapabilities } from '../../src/v4/voice.js';
import { startTestServer } from './helpers.mjs';

const wav = Buffer.alloc(48);
wav.write('RIFF'); wav.write('WAVE', 8);
const segment = (sequence = 0) => ({ type: 'audio', sequence, data: wav.toString('base64') });
function fixture(frames, mode = 'end') {
  let cancelled = false, paused = 0;
  const revoked = [], urls = [], starts = [];
  const response = new Response(new ReadableStream({
    start(controller) { for (const f of frames) controller.enqueue(new TextEncoder().encode(JSON.stringify(f) + '\n')); },
    pull(controller) { if (mode !== 'wait') controller.close(); },
    cancel() { cancelled = true; },
  }));
  const audio = {
    pause() { paused++; },
    play() {
      if (mode === 'throw') throw new Error('permission denied');
      if (mode !== 'wait') setImmediate(() => audio.onended?.());
      return Promise.resolve();
    },
  };
  const controller = new AbortController();
  const scope = { Blob, atob, URL: {
    createObjectURL() { const url = `blob:${urls.length}`; urls.push(url); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  } };
  const run = () => playNarratorStream({ response, audio, signal: controller.signal, scope, onStart: (n) => starts.push(n) });
  return { run, controller, audio, urls, revoked, starts, state: () => ({ cancelled, paused }) };
}

test('narrator stream plays ordered segments and releases all object URLs', async () => {
  const f = fixture([segment(), segment(1), { type: 'done', chunks: 2 }]);
  assert.deepEqual(await f.run(), { chunks: 2 });
  assert.deepEqual(f.starts, [0, 1]);
  assert.deepEqual(f.revoked, f.urls);
  assert.equal(f.audio.onended, null);
});

test('narrator stream rejects truncated, reordered and invalid audio', async () => {
  for (const frames of [[segment()], [segment(1)], [{ ...segment(), data: 'bm90IHdhdg==' }], [segment(), { type: 'done', chunks: 2 }]]) {
    const f = fixture(frames);
    await assert.rejects(f.run(), /Incomplete|Invalid/);
    assert.deepEqual(f.revoked, f.urls);
  }
});

test('narrator abort stops playback and cancels pending network input', async () => {
  const f = fixture([segment()], 'wait');
  const pending = f.run();
  await new Promise((r) => setImmediate(r));
  f.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.state(), { cancelled: true, paused: 1 });
  assert.deepEqual(f.revoked, f.urls);
  assert.equal(f.audio.onended, null);
});

test('synchronous Safari playback rejection cleans up handlers and URL', async () => {
  const f = fixture([segment()], 'throw');
  await assert.rejects(f.run(), /permission denied/);
  assert.equal(f.audio.onended, null);
  assert.deepEqual(f.revoked, f.urls);
});

test('stream upstream is fixed loopback, bounded and rejects non-NDJSON responses', async () => {
  let request;
  const result = await localNarratorStream({ text: 'hello', fetchImpl: async (url, options) => {
    request = { url, options }; return new Response('{}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  assert.equal(request.url, 'http://127.0.0.1:18765/speak-stream');
  assert.equal(request.options.body, '{"text":"hello"}');
  assert.ok(request.options.signal instanceof AbortSignal);
  await result.body.cancel();
  await assert.rejects(localNarratorStream({ text: 'hello', fetchImpl: async () => new Response('wrong') }), /unavailable/);
  assert.equal(voiceCapabilities({ MAJIN_V4_STREAM_TTS: '1' }).streamingTts.available, false);
  assert.equal(voiceCapabilities({ MAJIN_V4_STREAM_TTS: '1', MAJIN_V4_TTS_COMMAND: 'configured' }).streamingTts.available, true);
});

test('stream HTTP requires existing session and CSRF and stays explicitly disabled by default', async () => {
  const old = process.env.MAJIN_V4_STREAM_TTS;
  delete process.env.MAJIN_V4_STREAM_TTS;
  const s = await startTestServer();
  try {
    const post = (headers) => fetch(`${s.base}/api/voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base, ...headers }, body: JSON.stringify({ text: 'hello', stream: true }) });
    assert.equal((await post({ 'x-majin-csrf': '1' })).status, 401);
    const { cookie } = await s.pair();
    assert.equal((await post({ cookie })).status, 403);
    const disabled = await post({ cookie, 'x-majin-csrf': '1' });
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).error.code, 'VOICE_STREAM_DISABLED');
  } finally {
    await s.close();
    if (old === undefined) delete process.env.MAJIN_V4_STREAM_TTS; else process.env.MAJIN_V4_STREAM_TTS = old;
  }
});
