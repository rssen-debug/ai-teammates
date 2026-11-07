/**
 * Server-side voice: the V2 voice lane wired to HTTP.
 *
 * The offline `buffer` provider is used so the pipeline is deterministic. It
 * produces a valid WAV, which proves the adapter, the consent path, the file
 * verifier and the HTTP surface — NOT that MAJIN has a Swedish voice. The
 * external `edge-tts` path needs network to Microsoft and is asserted to be
 * gated, not silently attempted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, tempHome } from './helpers.mjs';

function isWav(buf) {
  return buf.length > 44 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE';
}

async function speak(s, cookie, body) {
  const res = await fetch(`${s.base}/api/voice/speak`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
    body: JSON.stringify(body),
  });
  return res;
}

test('voice: requires a session, and a CSRF header once paired', async () => {
  const s = await startTestServer();
  try {
    const anon = await fetch(`${s.base}/api/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ text: 'hej' }),
    });
    assert.equal(anon.status, 401);

    const { cookie } = await s.pair();
    const noCsrf = await fetch(`${s.base}/api/voice/speak`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ text: 'hej' }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

test('voice: the offline provider returns a real, verified WAV and says it is synthetic', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await speak(s, cookie, { text: 'Hej från MAJIN', mode: 'buffer' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(res.headers.get('x-majin-tts-provider'), 'buffer');
    assert.equal(res.headers.get('x-majin-tts-verified'), 'true', 'the V2 file verifier accepted it');
    assert.equal(res.headers.get('x-majin-tts-synthetic'), 'true', 'no false claim of a real voice');

    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(isWav(buf), 'a structurally valid WAV');
    assert.ok(buf.length > 44);
  } finally {
    await s.close();
  }
});

test('voice: the temp audio file is removed after it has been sent', async () => {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const res = await speak(s, cookie, { text: 'städa', mode: 'buffer' });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const dir = `${home}/v4/voice`;
    const fs = await import('node:fs');
    const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(left, [], 'no leftover audio on disk');
  } finally {
    await s.close();
  }
});

test('voice: empty and oversized text is refused before synthesis', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    assert.equal((await speak(s, cookie, { text: '   ', mode: 'buffer' })).status, 400);
    assert.equal((await speak(s, cookie, { text: 'x'.repeat(2000), mode: 'buffer' })).status, 413);
  } finally {
    await s.close();
  }
});

test('voice: an unknown mode falls back to auto instead of crashing', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await speak(s, cookie, { text: 'hej', mode: 'evil-mode' });
    // auto = edge-tts, which has no network here: a classified failure, never a fake success
    assert.ok([200, 502, 409].includes(res.status), `got ${res.status}`);
    if (res.status !== 200) {
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.ok(body.error.code, 'the failure is classified');
    }
  } finally {
    await s.close();
  }
});

test('voice: capabilities are reported honestly', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await fetch(`${s.base}/api/voice`, { headers: { cookie } });
    const body = await res.json();
    assert.deepEqual(body.modes, ['auto', 'buffer', 'edge-tts', 'command']);
    assert.match(body.serverSide.note, /not a voice/i);
    assert.ok(body.clientEngine.includes('SpeechSynthesis'));
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------------- local command lane -- */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, transcribe, voiceCapabilities, makeTtsProvider } from '../../src/v4/voice.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/v4/voice-fixture.mjs');
const ttsTemplate = () => `"${process.execPath}" "${FIXTURE}" tts {OUT} {TEXT}`;
// STT uses the same shell-free, quoted argv parser as the TTS command lane.
const sttTemplate = () => `"${process.execPath}" "${FIXTURE}" stt {WAV}`;

test('voice/command: a real local binary is spawned without a shell and its audio is verified', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-tts-cmd-'));
  const dir = path.join(parent, 'fresh-voice-directory');
  assert.equal(fs.existsSync(dir), false);
  const result = await synthesize({ text: 'tre ord här', mode: 'command', command: ttsTemplate(), dir });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'command');
  assert.equal(result.verified, true, 'the V2 file verifier accepted the produced WAV');
  assert.equal(result.synthetic, false, 'a real subprocess produced it');
  assert.ok(result.bytes > 44);
  assert.ok(fs.existsSync(result.audioPath));
  fs.rmSync(parent, { recursive: true, force: true });
});

test('voice/command: longer text produces a longer file (the text really reaches the binary)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-tts-len-'));
  const short = await synthesize({ text: 'ett', mode: 'command', command: ttsTemplate(), dir });
  const long = await synthesize({ text: 'ett två tre fyra fem sex sju åtta nio tio elva tolv', mode: 'command', command: ttsTemplate(), dir });
  assert.ok(long.bytes > short.bytes, `${long.bytes} should exceed ${short.bytes}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice/command: a shell pipeline in the template never runs', async () => {
  // safe-exec has no shell, so the pipeline is refused at tokenise time and
  // surfaces as a classified failure — not as a silent partial run.
  const result = await synthesize({ text: 'hej', mode: 'command', command: 'sh -c "echo pwned" | tee /tmp/majin-pwned.txt', dir: '/tmp' });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'PERMISSION_DENIED');
  const fs = await import('node:fs');
  assert.equal(fs.existsSync('/tmp/majin-pwned.txt'), false, 'the pipeline did not execute');
});

test('voice/command: a missing binary fails honestly instead of pretending', async () => {
  const result = await synthesize({ text: 'hej', mode: 'command', command: '/nonexistent/tts-bin {OUT}', dir: '/tmp' });
  assert.equal(result.ok, false);
  assert.ok(result.errorClass, 'the failure is classified');
  assert.notEqual(result.verified, true);
});

test('voice/command: command mode without a configured template is refused, not silently swapped', () => {
  assert.throws(() => makeTtsProvider({ mode: 'command' }), /MAJIN_V4_TTS_COMMAND/);
});

test('voice/stt: the local command lane returns a transcript, and an empty one stays inconclusive', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-stt-'));
  const wav = path.join(dir, 'in.wav');
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.from('MAJINSTT:öppna rapporten')]));

  const heard = await transcribe({ audioPath: wav, command: sttTemplate() });
  assert.equal(heard.ok, true, JSON.stringify(heard));
  assert.equal(heard.verdict, 'capture');
  assert.equal(heard.transcript, 'öppna rapporten');
  assert.equal(heard.synthetic, false);
  const structured = await transcribe({ audioPath: wav, command: sttTemplate().replace(' stt ', ' stt-json ') });
  assert.equal(structured.transcript, heard.transcript);
  assert.equal(structured.language, 'en', 'recognized language reaches the client instead of forcing phone locale');

  const quiet = path.join(dir, 'quiet.wav');
  fs.writeFileSync(quiet, Buffer.alloc(64));
  const empty = await transcribe({ audioPath: quiet, command: sttTemplate() });
  assert.equal(empty.ok, false, 'an empty transcript is not a success');
  assert.equal(empty.verdict, 'inconclusive');
  assert.equal(empty.transcript, '');
  const structuredEmpty = await transcribe({ audioPath: quiet, command: sttTemplate().replace(' stt ', ' stt-json ') });
  assert.equal(structuredEmpty.ok, false, 'JSON metadata with an empty transcript is not recognition');
  assert.equal(structuredEmpty.verdict, 'inconclusive');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice: capabilities name every lane and mark what is configured', () => {
  const caps = voiceCapabilities({});
  assert.deepEqual(caps.tts.map((c) => c.mode), ['buffer', 'command', 'edge-tts']);
  assert.equal(caps.tts.find((c) => c.mode === 'command').available, false);
  const configured = voiceCapabilities({ MAJIN_V4_TTS_COMMAND: 'piper {OUT}', MAJIN_V4_STT_COMMAND: 'whisper {WAV}' });
  assert.equal(configured.tts.find((c) => c.mode === 'command').available, true);
  assert.equal(configured.stt.find((c) => c.mode === 'command').available, true);
});
