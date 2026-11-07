/**
 * MAJIN V4 — server-side voice.
 *
 * Reuses the V2 voice lane verbatim (`src/v2/voice/speak.js`, `listen.js`,
 * `tts.js`, `stt.js`): the same consent path, the same kernel error classes and
 * the same "the produced file is the proof" rule. V4 adds only two things:
 *
 *   - a provider choice that depends on what is actually available
 *     (`buffer` is deterministic offline; `edge-tts` needs network to Microsoft)
 *   - an HTTP surface that streams the produced audio back and reports the
 *     verification result instead of claiming success
 *
 * The browser's own SpeechSynthesis stays the default in the UI. This exists so
 * that a phone without a Swedish voice — or a future server-side pipeline — has
 * a proven path, not so that MAJIN can advertise a voice it has not measured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { speak } from '../v2/voice/speak.js';
import { listen } from '../v2/voice/listen.js';
import { EdgeTtsProvider, BufferTtsProvider, CommandTtsProvider } from '../v2/voice/tts.js';
import { BufferSttProvider, CommandSttProvider } from '../v2/voice/stt.js';

export const VOICE_MODES = Object.freeze(['auto', 'buffer', 'edge-tts', 'command']);

/**
 * The local-command lane is operator-supplied and therefore gated exactly like
 * every other shell path in V2: preflight first, argv-only spawn (no shell),
 * scrubbed environment, mandatory timeout. The template comes from config, never
 * from a chat message or an HTTP body.
 */
export function commandTemplateFromEnv(env = process.env) {
  return env.MAJIN_V4_TTS_COMMAND || null;
}

export function sttTemplateFromEnv(env = process.env) {
  return env.MAJIN_V4_STT_COMMAND || null;
}

/**
 * Pick a provider. `auto` prefers the real engine and falls back to the offline
 * one; it never pretends the offline one is speech synthesis of a real voice.
 */
export function makeTtsProvider({ mode = 'auto', voice = null, command = null } = {}) {
  if (mode === 'buffer') return new BufferTtsProvider();
  if (mode === 'command') {
    if (!command) throw new Error('command mode needs MAJIN_V4_TTS_COMMAND (a {OUT}/{TEXT} template)');
    return new CommandTtsProvider({ commandTemplate: command });
  }
  if (mode === 'edge-tts') return new EdgeTtsProvider(voice ? { defaultVoice: voice } : {});
  // auto: a configured local command wins over a network engine
  if (command) return new CommandTtsProvider({ commandTemplate: command });
  return new EdgeTtsProvider(voice ? { defaultVoice: voice } : {});
}

export function makeSttProvider({ command = null } = {}) {
  return command ? new CommandSttProvider({ commandTemplate: command }) : new BufferSttProvider({});
}

/** Which lanes are actually available on this host, without pretending. */
export function voiceCapabilities(env = process.env) {
  return {
    streamingTts: { available: env.MAJIN_V4_STREAM_TTS === '1' && Boolean(commandTemplateFromEnv(env)), format: 'wav-ndjson', provider: 'kokoro-onnx' },
    tts: [
      { mode: 'buffer', kind: 'offline', description: 'Deterministic silent WAV. Proves the pipeline, not a voice.' },
      { mode: 'command', kind: 'local', available: Boolean(commandTemplateFromEnv(env)), description: 'Operator-configured local binary (piper, kokoro, …). Preflight-gated.' },
      { mode: 'edge-tts', kind: 'network', available: true, description: 'Microsoft Edge TTS. Needs network; real voice.' },
    ],
    stt: [
      { mode: 'buffer', kind: 'offline', description: 'Fixture mapping. Deterministic, not recognition.' },
      { mode: 'command', kind: 'local', available: Boolean(sttTemplateFromEnv(env)), description: 'Local whisper-style CLI. Preflight-gated.' },
    ],
  };
}

/** The explicitly enabled, host-local narrator. No client-supplied URL/command. */
export async function localNarratorStream({ text, signal, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl('http://127.0.0.1:18765/speak-stream', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.any([signal, AbortSignal.timeout(90000)].filter(Boolean)),
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) {
    await response.body?.cancel();
    throw new Error('Local narrator stream unavailable');
  }
  return response;
}

/**
 * Synthesize into a private temp dir and return the bytes plus the V2 verdict.
 * The caller decides what to do with a failed verification; nothing here turns
 * a failure into a success.
 */
export async function synthesize({ text, mode = 'auto', voice = null, approvals, dir, command = null }) {
  const provider = makeTtsProvider({ mode, voice, command: command || commandTemplateFromEnv() });
  const target = path.join(dir || fs.mkdtempSync(path.join(os.tmpdir(), 'majin-tts-')), `speech-${Date.now()}.${provider.name === 'edge-tts' ? 'mp3' : 'wav'}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let result;
  try {
    result = await speak(text, { provider, approvals, outPath: target });
  } catch (err) {
    return {
      ok: false,
      provider: provider.name,
      errorClass: err?.cls || 'MODEL_FAILURE',
      message: String(err?.message || err),
      elapsedMs: Date.now() - started,
    };
  }
  if (result.ok === false && result.decision === 'waiting') {
    return { ok: false, provider: provider.name, pendingConsent: true, scope: result.pendingScope, message: result.reason };
  }
  const audioPath = result.audioPath || target;
  let bytes = 0;
  try {
    bytes = fs.statSync(audioPath).size;
  } catch {
    bytes = 0;
  }
  return {
    ok: Boolean(result.ok) && bytes > 0,
    provider: provider.name,
    format: provider.name === 'edge-tts' ? 'mp3' : 'wav',
    bytes,
    verified: result.verified === true,
    audioPath,
    elapsedMs: Date.now() - started,
    // A buffer provider produces a valid but silent WAV: it proves the pipeline,
    // not the voice. Say which one happened.
    synthetic: provider.name === 'buffer',
    engine: provider.name,
  };
}

export async function transcribe({ audioPath, command = null }) {
  const provider = makeSttProvider({ command: command || sttTemplateFromEnv() });
  const started = Date.now();
  try {
    const result = await listen(audioPath, { provider });
    // Warm local recognizers may also return a detected language. Generic V2
    // command providers still accept plain text; parse only this explicit shape.
    let transcript = result.transcript || '';
    let language = null;
    try {
      const structured = JSON.parse(transcript);
      if (typeof structured.transcript === 'string' && /^[a-z]{2,3}$/.test(structured.language)) {
        transcript = structured.transcript;
        language = structured.language;
      }
    } catch { /* plain transcript */ }
    return {
      ok: Boolean(result.ok) && Boolean(transcript.trim()),
      verdict: transcript.trim() ? (result.verdict || 'capture') : 'inconclusive',
      transcript,
      language,
      provider: provider.name,
      elapsedMs: Date.now() - started,
      synthetic: provider.name === 'buffer',
    };
  } catch (err) {
    return {
      ok: false,
      verdict: 'failed',
      transcript: '',
      errorClass: err?.cls || 'MODEL_FAILURE',
      message: String(err?.message || err),
      provider: provider.name,
      elapsedMs: Date.now() - started,
    };
  }
}

export { CommandTtsProvider, BufferTtsProvider };
