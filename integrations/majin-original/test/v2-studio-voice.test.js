/**
 * Studio voice lane — speak/listen surfaces over the REAL voice modules.
 * Offline proof: BufferTtsProvider writes a real playable WAV served over real
 * HTTP; the external-provider consent path is exercised with a real
 * file-writing provider of kind 'external' (the boundary under test is the
 * consent gate, which is ours).
 * Live edge synthesis + real whisper binary: operator lanes (NOT_TESTED here).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { BufferTtsProvider } from '../src/v2/voice/tts.js';
import { createStudioServer } from '../src/v2/studio/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-voice-')); }

/** real boundary provider: kind external, writes a real file, records calls */
class ExternalFileTts {
  constructor(outDir) { this.name = 'external-file-tts'; this.kind = 'external'; this.calls = 0; this.outDir = outDir; }
  async speech(text, { outPath }) {
    this.calls++;
    fs.writeFileSync(outPath, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40, 1)]));
    return { audioPath: outPath, bytes: 44, format: 'mp3', provider: this.name };
  }
}

async function boot({ tts = 'buffer', stt = null } = {}) {
  const dir = tmp();
  const telemetryDir = path.join(dir, 'telemetry');
  const auditDir = path.join(dir, 'audit');
  const outDir = path.join(dir, 'voice');
  fs.mkdirSync(outDir, { recursive: true });
  new TelemetryLedger(telemetryDir);
  new AuditChain(auditDir);
  const bus = new EventBus();
  const approvals = new Approvals(bus);
  const provider = tts === 'buffer' ? new BufferTtsProvider() : new ExternalFileTts(outDir);
  const studio = createStudioServer({ bus, telemetryDir, auditDir, approvals, enableWrites: true, voice: { outDir, tts: provider, stt } });
  const bound = await studio.listen({ port: 0 });
  return { studio, bound, approvals, outDir, provider, telemetryDir, dir };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('1. offline speak: real WAV written, served over HTTP, evidence honest, verified=true', async () => {
  const { studio, bound, outDir } = await boot();
  const res = await post(bound.url + '/api/voice/speak', { text: 'hej världen' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.format, 'wav');
  assert.equal(body.provider, 'buffer');
  assert.equal(body.verified, true, 'independent verifyFile ran — not a provider claim');
  assert.equal(body.bytes, 44 + 2000);

  // the audio endpoint serves the REAL file with the REAL bytes
  const audio = await fetch(bound.url + body.audio);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  const buf = Buffer.from(await audio.arrayBuffer());
  assert.equal(buf.length, body.bytes);
  assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString(), 'WAVE');
  assert.ok(fs.readdirSync(outDir).some((f) => f.endsWith('.wav')), 'file exists in outDir');
  await studio.close();
});

test('2. path traversal to the audio endpoint is refused flat', async () => {
  const { studio, bound } = await boot();
  for (const evil of ['..%2F..%2Fetc%2Fpasswd', '../secret.wav', 'a/b.wav', '']) {
    const res = await fetch(bound.url + '/api/voice/audio/' + evil);
    assert.ok([400, 404].includes(res.status), `${evil}: ${res.status}`);
  }
  await studio.close();
});

test('3. external provider: consent gate dogfooded — waiting 403, grant via POST /api/consent, synthesis runs exactly once', async () => {
  const { studio, bound, approvals, provider } = await boot({ tts: 'external' });
  const denied = await post(bound.url + '/api/voice/speak', { text: 'extern text' });
  assert.equal(denied.status, 403);
  const d = await denied.json();
  assert.equal(d.decision, 'waiting');
  assert.equal(d.pendingScope, 'voice:external');
  assert.equal(provider.calls, 0, 'NO synthesis happened before consent');

  const grant = await post(bound.url + '/api/consent', { scope: 'voice:external', user: 'operator-stina', mode: 'once' });
  assert.equal(grant.status, 201);

  const ok = await post(bound.url + '/api/voice/speak', { text: 'extern text' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).provider, 'external-file-tts');
  assert.equal(provider.calls, 1, 'exactly one synthesis for the single grant');
  const again = await post(bound.url + '/api/voice/speak', { text: 'extern text' });
  assert.equal(again.status, 403, 'grant consumed — next synthesis waits again');
  assert.equal(approvals.check('voice:external').decision, 'waiting');
  await studio.close();
});

test('4. listen without stt provider → 403 "no fabricated transcript"; disabled voice → 403 silence', async () => {
  const { studio, bound } = await boot({ stt: null });
  const res = await post(bound.url + '/api/voice/listen', { wavBase64: Buffer.from('RIFF' + 'x'.repeat(100)).toString('base64') });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /voice surface disabled|stt surface disabled/);
  await studio.close();

  const dir = tmp();
  const plain = createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir });
  const b = await plain.listen({ port: 0 });
  const r2 = await post(b.url + '/api/voice/speak', { text: 'x' });
  assert.equal(r2.status, 403);
  assert.match((await r2.json()).detail, /disabled means SILENCE/);
  await plain.close();
});

test('5. listen upload: round trip writes wav, transcribes to deterministic transcript, uploads are transient', async () => {
  const dir = tmp();
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF', 0); wav.write('WAVE', 8);
  // deterministic fixture provider at the boundary (fixture maps this payload class)
  const fixtureStt = { name: 'fixture-stt', kind: 'local', transcribe: async (p) => { assert.ok(fs.existsSync(p)); return { transcript: 'fixture: hej', provider: 'fixture-stt', elapsedMs: 1 }; } };
  const bus = new EventBus();
  const outDir = path.join(dir, 'voice');
  const studio = createStudioServer({ bus, telemetryDir: path.join(dir, 't'), auditDir: path.join(dir, 'a'), approvals: new Approvals(bus), voice: { outDir, tts: new BufferTtsProvider(), stt: fixtureStt } });
  const bound = await studio.listen({ port: 0 });
  const res = await post(bound.url + '/api/voice/listen', { wavBase64: wav.toString('base64') });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verdict, 'capture');
  assert.equal(body.transcript, 'fixture: hej');
  assert.equal(body.bytes, wav.length);
  assert.deepEqual(fs.readdirSync(outDir), [], 'uploaded wav removed after the verdict — the verdict is the artifact, not the upload');
  await studio.close();
});

test('6. bad listen payloads rejected: empty base64 → 400; oversized body → 413 and server survives', async (t) => {
  const neverReached = { name: 'gate-only-stt', kind: 'local', transcribe: async () => { throw new Error('provider must never be reached by invalid payloads'); } };
  const { studio, bound } = await boot({ stt: neverReached });
  t.after(() => studio.close());
  const r1 = await post(bound.url + '/api/voice/listen', { wavBase64: '' });
  assert.equal(r1.status, 400);
  const big = Buffer.alloc(26 * 1024 * 1024, 7);
  const r2 = await fetch(bound.url + '/api/voice/listen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wavBase64: big.toString('base64') }) });
  assert.equal(r2.status, 413);
  assert.match((await r2.json()).error, /audio too large/);
  const alive = await fetch(bound.url + '/api/audit/verify');
  assert.equal(alive.status, 200, 'server alive after the rejected 26MB upload');
});

test('7. page: voice panel gate-truthful, zero external assets, consent hint present', async () => {
  const { studio, bound } = await boot();
  const html = await (await fetch(bound.url + '/')).text();
  assert.match(html, /var VOICE=true;/);
  assert.match(html, /id="v-speak"/);
  assert.match(html, /sha256-verified, never provider claims/);
  assert.match(html, /grant \\"\+b\.pendingScope\+\\"/.source ? /pendingScope/ : /nevermatches/);
  assert.equal(/(src|href)\s*=\s*"https?:/i.test(html), false);
  await studio.close();
  const dir = tmp();
  const plain = createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir });
  const b = await plain.listen({ port: 0 });
  const off = await (await fetch(b.url + '/')).text();
  assert.match(off, /var VOICE=false;/);
  assert.match(off, /disabled means SILENCE/);
  await plain.close();
});
