/**
 * V2 voice-listen contracts: consent gating for external STT, honest bounded
 * verdicts (empty transcript = inconclusive capture, never fabricated),
 * command provider preflight blocks, and deterministic offline fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandSttProvider, BufferSttProvider } from '../src/v2/voice/stt.js';
import { listen } from '../src/v2/voice/listen.js';
import { BufferTtsProvider } from '../src/v2/voice/tts.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';

async function makeWav(dir, name = 'sample.wav') {
  const p = path.join(dir, name);
  await new BufferTtsProvider().speech('transkribations-kontroll', { outPath: p });
  return p;
}

test('listen(): round-trip — our synthesized wav -> deterministic fixture -> capture verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-'));
  const wav = await makeWav(dir);
  const provider = new BufferSttProvider({ 'sample.wav': 'detta är ett majin-test' });
  const r = await listen(wav, { provider });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'capture');
  assert.match(r.transcript, /majin-test/);
});

test('listen(): silence/unknown fixture -> honest inconclusive (never fabricates words)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-'));
  const wav = await makeWav(dir);
  const provider = new BufferSttProvider({}); // no fixture: sound exists but model finds nothing
  const r = await listen(wav, { provider });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.transcript, '');
});

test('listen(): missing audio -> DEPENDENCY_MISSING (classified, not thrown raw)', async () => {
  const p = new BufferSttProvider({});
  const r = listen('/definitely/not/here.wav', { provider: p });
  await assert.rejects(r, (e) => e.cls === 'DEPENDENCY_MISSING');
});

test('listen(): external STT requires approvals layer + consent flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-'));
  const wav = await makeWav(dir);
  const fake = { name: 'cloud-stt', kind: 'external', transcribe: async (p) => new BufferSttProvider({ 'sample.wav': 'cloud words' }).transcribe(p) };
  await assert.rejects(() => listen(wav, { provider: fake }), /approvals layer/);
  const approvals = new Approvals(new EventBus());
  const wait = await listen(wav, { provider: fake, approvals });
  assert.equal(wait.decision, 'waiting');
  approvals.grant(wait.pendingScope, { user: 'owner' });
  const ok = await listen(wav, { provider: fake, approvals });
  assert.equal(ok.ok, true);
  assert.equal(ok.transcript, 'cloud words');
});

test('command STT: preflight blocks tier-no templates; missing template classified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-'));
  const wav = await makeWav(dir);
  await assert.rejects(() => new CommandSttProvider({ commandTemplate: 'rm -rf /' }).transcribe(wav), (e) => e.cls === 'PERMISSION_DENIED');
  await assert.rejects(() => new CommandSttProvider({}).transcribe(wav), (e) => e.cls === 'DEPENDENCY_MISSING');
});

test('command STT: real host command (echo as stand-in whisper-cli) executes honestly through the adapter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-'));
  const wav = await makeWav(dir);
  const p = new CommandSttProvider({ commandTemplate: `node -e "console.log('transcript-fra-det-rosta')"` });
  const r = await p.transcribe(wav);
  assert.match(r.transcript, /transcript-fra-det-rosta/);
});

test('listen(): telemetry rows written from the gated entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-stt-tele-'));
  const tele = new TelemetryLedger(dir);
  const wav = path.join(dir, 'w.wav');
  await new BufferTtsProvider().speech('x', { outPath: wav });
  const r = await listen(wav, { provider: new BufferSttProvider({ 'w.wav': 'något' }), telemetry: tele });
  assert.equal(r.ok, true);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.endsWith('.jsonl')));
});
