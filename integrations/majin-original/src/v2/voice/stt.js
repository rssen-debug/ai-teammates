/**
 * V2 voice lane: STT adapters (PHASE 6). Same discipline as TTS: consent for
 * external providers, file/input proof chains, kernel-classified failures.
 *
 * Providers:
 *  - 'command': host-whisper CLI (whisper.cpp / faster-whisper) — offline
 *    local execution; preflight-gated like every shell path in V2.
 *  - 'buffer' : deterministic offline wordmap for tests/CI.
 * External cloud STT intentionally not wired yet (consent gate exists but no
 * provider adopted — logged in the dependency matrix).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSafe } from '../spawn/safe-exec.js';
import { preflight } from '../safety/command-preflight.js';
import { ModelError } from '../model/provider.js';

export class CommandSttProvider {
  /** commandTemplate e.g. 'whisper-cli -m model.bin -f {WAV} --output-txt --no-prints' */
  constructor({ commandTemplate, wavDependency = 'ffmpeg or wav input', timeoutMs = 120_000 } = {}) {
    this.name = 'command';
    this.kind = 'local';
    this.commandTemplate = commandTemplate;
    this.wavDependency = wavDependency;
    this.timeoutMs = timeoutMs;
  }

  async transcribe(wavPath) {
    if (!this.commandTemplate) throw new ModelError('DEPENDENCY_MISSING', 'stt command has no template');
    if (!fs.existsSync(wavPath)) throw new ModelError('DEPENDENCY_MISSING', `audio missing: ${wavPath}`);
    const tier = preflight(this.commandTemplate);
    if (tier.tier === 'no') throw new ModelError('PERMISSION_DENIED', `stt command blocked by preflight: ${tier.reason}`, { provider: this.name });
    const t0 = Date.now();
    try {
      const result = await runSafe(this.commandTemplate, { WAV: wavPath }, { timeoutMs: this.timeoutMs });
      if (result.truncated) throw new ModelError('MODEL_FAILURE', 'stt transcript exceeded the output limit', { provider: this.name });
      return { transcript: result.stdout.trim(), provider: this.name, elapsedMs: Date.now() - t0 };
    } catch (err) {
      const cls = err.cls === 'TIMEOUT' ? 'TIMEOUT' : err.cls === 'SPAWN' ? 'DEPENDENCY_MISSING'
        : err.cls === 'SAFE_REFUSED' ? 'PERMISSION_DENIED' : 'MODEL_FAILURE';
      throw new ModelError(cls, `stt command failed: ${err.message}`, { provider: this.name });
    }
  }
}

/** deterministic offline: maps known fixtures; everything else = empty transcript */
export class BufferSttProvider {
  constructor(fixtures = {}) { this.name = 'buffer'; this.kind = 'offline'; this.fixtures = fixtures; }
  async transcribe(wavPath) {
    if (!fs.existsSync(wavPath)) throw new ModelError('DEPENDENCY_MISSING', `audio missing: ${wavPath}`);
    const mapped = this.fixtures[path.basename(wavPath)];
    return { transcript: mapped || '', provider: this.name, elapsedMs: 0 };
  }
}
