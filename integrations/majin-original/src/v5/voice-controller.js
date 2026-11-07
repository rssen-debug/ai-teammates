/**
 * MAJIN V5 — Voice, Barge-In & Latency Telemetry Controller (Section 11).
 *
 * Reuses V4/V2 voice adapters (`src/v4/voice.js`) while enforcing:
 *  - Voice starts ONLY when explicitly activated by the user (`userInitiated === true`).
 *  - Clear microphone status (`idle`, `listening`, `processing`, `speaking`, `muted`, `unsupported`).
 *  - Immediate speech interruption (barge-in) with measured `interruptionLatencyMs`.
 *  - Measured `responseLatencyMs` and `timeToFirstStatusMs`.
 *  - Explicit honesty about unverified hardware claims (echo, TV-noise, speaker-ID).
 */
import { VOICE_MODES, voiceCapabilities } from '../v4/voice.js';

export const MIC_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  MUTED: 'muted',
  UNSUPPORTED: 'unsupported',
});

export class VoiceController {
  constructor({ env = process.env, now = () => performance.now() } = {}) {
    this.env = env;
    this.now = now;
    this.micState = MIC_STATES.IDLE;
    this.userActivated = false;
    this.speakingSessionId = null;
    this.speakingAbortController = null;
    this.metrics = {
      samples: 0,
      lastTimeToFirstStatusMs: null,
      lastResponseLatencyMs: null,
      lastInterruptionLatencyMs: null,
      history: [],
    };
  }

  /**
   * Voice may ONLY start when the user explicitly activates it (`userInitiated: true`).
   * Background tasks, model outputs or pages can never turn on the microphone.
   */
  activateMicrophone({ userInitiated = false } = {}) {
    if (userInitiated !== true) {
      return {
        ok: false,
        code: 'VOICE_REQUIRES_USER_ACTIVATION',
        micState: this.micState,
        message: 'Microphone only starts when explicitly activated by the user.',
      };
    }
    this.userActivated = true;
    // If TTS is currently speaking, barge-in interrupts it immediately
    if (this.micState === MIC_STATES.SPEAKING) {
      this.interruptSpeech({ reason: 'user_mic_barge_in' });
    }
    this.micState = MIC_STATES.LISTENING;
    return {
      ok: true,
      micState: this.micState,
      userActivated: this.userActivated,
    };
  }

  deactivateMicrophone() {
    this.userActivated = false;
    if (this.micState === MIC_STATES.LISTENING) {
      this.micState = MIC_STATES.IDLE;
    }
    return { ok: true, micState: this.micState };
  }

  /** Start speaking a response so barge-in can interrupt it cleanly. */
  startSpeaking({ sessionId = `tts-${Date.now()}` } = {}) {
    if (this.speakingAbortController) {
      try { this.speakingAbortController.abort(); } catch { /* ignore */ }
    }
    this.speakingSessionId = sessionId;
    this.speakingAbortController = new AbortController();
    this.micState = MIC_STATES.SPEAKING;
    return {
      ok: true,
      sessionId,
      micState: this.micState,
      signal: this.speakingAbortController.signal,
    };
  }

  /** Interrupt active TTS playback immediately and record actual interruption latency. */
  interruptSpeech({ reason = 'user_barge_in', requestedAt = this.now() } = {}) {
    const wasSpeaking = this.micState === MIC_STATES.SPEAKING;
    if (this.speakingAbortController) {
      try {
        this.speakingAbortController.abort(new Error(reason));
      } catch { /* ignore */ }
      this.speakingAbortController = null;
    }
    this.speakingSessionId = null;
    this.micState = this.userActivated ? MIC_STATES.LISTENING : MIC_STATES.IDLE;
    const finishedAt = this.now();
    const interruptionLatencyMs = Math.max(0, Number((finishedAt - requestedAt).toFixed(2)));
    this.metrics.lastInterruptionLatencyMs = interruptionLatencyMs;
    this.#recordMetric({ kind: 'interruption', interruptionLatencyMs, wasSpeaking, reason });
    return {
      ok: true,
      interrupted: wasSpeaking,
      micState: this.micState,
      interruptionLatencyMs,
    };
  }

  /** Record measured turn latency (`timeToFirstStatusMs` and `responseLatencyMs`). */
  recordTurnTiming({ startedAt, firstStatusAt, completedAt } = {}) {
    const t0 = Number(startedAt) || 0;
    const tStatus = Number(firstStatusAt) || t0;
    const tEnd = Number(completedAt) || tStatus;
    const timeToFirstStatusMs = Math.max(0, Number((tStatus - t0).toFixed(2)));
    const responseLatencyMs = Math.max(0, Number((tEnd - t0).toFixed(2)));

    this.metrics.samples += 1;
    this.metrics.lastTimeToFirstStatusMs = timeToFirstStatusMs;
    this.metrics.lastResponseLatencyMs = responseLatencyMs;
    this.#recordMetric({
      kind: 'turn_timing',
      timeToFirstStatusMs,
      responseLatencyMs,
    });
    return { timeToFirstStatusMs, responseLatencyMs };
  }

  #recordMetric(entry) {
    this.metrics.history.push({ ...entry, at: new Date().toISOString() });
    if (this.metrics.history.length > 50) {
      this.metrics.history.shift();
    }
  }

  describeStatus() {
    const hostCaps = voiceCapabilities(this.env);
    return {
      micState: this.micState,
      userActivated: this.userActivated,
      optInOnly: true,
      bargeInSupported: true,
      modes: VOICE_MODES,
      hostCapabilities: hostCaps,
      metrics: {
        samples: this.metrics.samples,
        lastTimeToFirstStatusMs: this.metrics.lastTimeToFirstStatusMs,
        lastResponseLatencyMs: this.metrics.lastResponseLatencyMs,
        lastInterruptionLatencyMs: this.metrics.lastInterruptionLatencyMs,
      },
      // Honest hardware verification statement (Section 11):
      hardwareVerification: {
        acousticEchoVerifiedOnDevice: false,
        tvBackgroundNoiseRejectionVerifiedOnDevice: false,
        speakerBiometricIdVerifiedOnDevice: false,
        note: 'Hardware echo cancellation, TV-noise rejection and speaker identification are NOT claimed without physical device evidence.',
      },
    };
  }
}
