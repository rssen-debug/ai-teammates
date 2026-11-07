/**
 * V2 voice speak() — the gated entry (master brief PHASE 6 + section 22 independence).
 *
 * An external TTS call is an EXTERNAL ACTION: it goes through the same consent
 * layers as shell commands. Proof-of-speech is the produced file verified by
 * the file verifier, not the provider's claim.
 */
import { EdgeTtsProvider, BufferTtsProvider, CommandTtsProvider } from './tts.js';
import { verifyFile } from '../runtime/verifiers.js';

export const voiceProviders = { EdgeTtsProvider, BufferTtsProvider, CommandTtsProvider };

/**
 * speak(text, { provider, approvals, telemetry, events, outPath }) -> receipt
 * Consent: provider.kind === 'external' -> approvals.check('voice:external');
 * kind 'local' -> read-tier needed? none (preflight inside command provider).
 */
export async function speak(text, { provider, approvals = null, telemetry = null, events = null, outPath = null, verify = true } = {}) {
  if (!provider) throw new Error('speak() requires a provider');
  const t0 = Date.now();
  if (provider.kind === 'external') {
    if (!approvals) throw new Error('external TTS requires the approvals layer (consent path)');
    const c = approvals.check('voice:external', { preflightReason: `external voice synthesis via ${provider.name}` });
    if (c.decision !== 'allow') {
      telemetry?.append('consent', { scope: 'voice:external', decision: 'waiting', mode: 'voice' });
      return { ok: false, decision: 'waiting', pendingScope: 'voice:external', reason: c.note || 'consent pending', provider: provider.name };
    }
    telemetry?.append('consent', { scope: 'voice:external', decision: 'used', mode: 'voice' });
  }
  const res = await provider.speech(text, { outPath });
  let verified = null;
  if (verify && res.audioPath) {
    const v = verifyFile({ path: res.audioPath, minBytes: 44 });
    verified = v.verified;
    telemetry?.append('verification', { kind: 'file', verified, durationMs: Date.now() - t0 });
  }
  events?.emit('task.updated', { taskId: `voice:${provider.name}`, to: 'done', durationMs: Date.now() - t0 });
  return { ok: true, decision: 'done', ...res, verified, durationMs: Date.now() - t0 };
}
