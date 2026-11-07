/**
 * V2 voice lane: TTS adapter + registry (master brief PHASE 6).
 *
 * Providers are adapters behind one honest contract: speech(text, opts) ->
 * { audioPath?, bytes, format, provider }. Any provider flagged 'external'
 * must pass the SAME consent path as any other external action (approvals;
 * failure classes are the kernel classes). A provider that dies returns the
 * kernel classification, never a promise of success.
 *
 * Builtins:
 *  - edge-tts (online, MIT, 100+ voices, Swedish native) — needs network
 *  - command (any local binary writing a wav) — e.g. piper/kokoro CLI on host
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { preflight } from '../safety/command-preflight.js';
import { ModelError } from '../model/provider.js';

export const VOICE_PROVIDERS = Object.freeze(['edge-tts', 'command', 'buffer']);

export class EdgeTtsProvider {
  constructor({ defaultVoice = 'sv-SE-SofieNeural', timeoutMs = 30_000 } = {}) {
    this.name = 'edge-tts';
    this.kind = 'external'; // network to Microsoft — consent path applies
    this.defaultVoice = defaultVoice;
    this.timeoutMs = timeoutMs;
  }

  async speech(text, { voice = null, outPath = null } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new ModelError('INVALID_TOOL_OUTPUT', 'tts requires non-empty text');
    const mod = await import('node-edge-tts');
    const EdgeTTS = mod.EdgeTTS || mod.default?.EdgeTTS || mod.default;
    const t = new EdgeTTS({ voice: voice || this.defaultVoice, timeout: this.timeoutMs });
    const out = outPath || `speech-${Date.now()}.mp3`;
    try {
      await t.ttsPromise(text, out); // resolves void; file itself is the contract
      const st = fs.statSync(out);
      if (!st.size) throw new Error('edge-tts produced an empty file');
      return { audioPath: out, bytes: st.size, format: 'mp3', provider: this.name };
    } catch (err) {
      const msg = String(err.message || err);
      const cls = /ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(msg) ? 'NETWORK_FAILURE' : 'MODEL_FAILURE';
      throw new ModelError(cls, `edge-tts failed: ${msg}`, { provider: this.name });
    }
  }
}

/** generic local TTS command writing a wav file: preflight-gated before spawn */
export class CommandTtsProvider {
  constructor({ commandTemplate, timeoutMs = 30_000, executableName = null } = {}) {
    // commandTemplate e.g. 'piper -m swe_nancy.onnx -f {OUT} <<< {TEXT}'
    this.name = 'command';
    this.kind = 'local';
    this.commandTemplate = commandTemplate;
    this.executableName = executableName;
    this.timeoutMs = timeoutMs;
  }

  async speech(text, { outPath = null } = {}) {
    if (!this.commandTemplate) throw new ModelError('DEPENDENCY_MISSING', 'command tts has no template');
    const out = outPath || `speech-${Date.now()}.wav`;
    // two gates, different jobs:
    //  1) preflight scans the TEMPLATE (consent tier) — 'rm -rf /' dies here
    //  2) runSafe executes argv-style with NO SHELL — text is literal data;
    //     a `$` in the text can never be evaluated (see src/v2/spawn/safe-exec.js)
    const tier = preflight(this.commandTemplate);
    if (tier.tier === 'no') throw new ModelError('PERMISSION_DENIED', `tts command blocked by preflight: ${tier.reason}`, { provider: this.name });
    const { runSafe, SafeExecError } = await import('../spawn/safe-exec.js');
    try {
      await runSafe(this.commandTemplate, { OUT: out, TEXT: text }, { timeoutMs: this.timeoutMs });
    } catch (e) {
      if (e instanceof SafeExecError) {
        const cls = e.cls === 'SPAWN' ? 'DEPENDENCY_MISSING' : e.cls === 'SAFE_REFUSED' ? 'PERMISSION_DENIED' : 'MODEL_FAILURE';
        throw new ModelError(cls, `command tts failed honestly: ${e.cls} — ${e.message}`, { provider: this.name });
      }
      throw e;
    }
    const st = fs.statSync(out);
    return { audioPath: out, bytes: st.size, format: 'wav', provider: this.name };
  }
}

/** deterministic offline provider for tests: synthesizes a minimal WAV header+silence */
export class BufferTtsProvider {
  constructor() { this.name = 'buffer'; this.kind = 'offline'; }
  async speech(text, { outPath = null, seconds = 0.25 } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new ModelError('INVALID_TOOL_OUTPUT', 'tts requires non-empty text');
    const rate = 8000;
    const n = Math.max(1, Math.floor(rate * seconds));
    const header = Buffer.alloc(44 + n);
    header.write('RIFF', 0); header.writeUInt32LE(36 + n, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(8, 34);
    header.write('data', 36); header.writeUInt32LE(n, 40);
    // silence stays 0
    if (outPath) { fs.mkdirSync(path.dirname(outPath) || '.', { recursive: true }); fs.writeFileSync(outPath, header); }
    return { audioPath: outPath || null, bytes: header.length, format: 'wav', provider: this.name, buffer: outPath ? undefined : header };
  }
}
