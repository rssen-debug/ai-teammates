/**
 * V2 voice listen() — the gated STT entry (PHASE 6 + section 22).
 * Proof chain: produced transcript gets an HONEST verdict — non-empty is
 * evidence of capture, empty is surfaced as an inconclusive listening
 * (never fabricated). External providers pass the consent layer like speak().
 */
export async function listen(wavPath, { provider, approvals = null, telemetry = null, events = null } = {}) {
  if (!provider) throw new Error('listen() requires a provider');
  if (!wavPath) throw new Error('listen() requires wavPath');
  if (provider.kind === 'external') {
    if (!approvals) throw new Error('external STT requires the approvals layer (consent path)');
    const c = approvals.check('voice:external', { preflightReason: `external speech recognition via ${provider.name}` });
    if (c.decision !== 'allow') {
      telemetry?.append('consent', { scope: 'voice:external', decision: 'waiting', mode: 'voice' });
      return { ok: false, decision: 'waiting', pendingScope: 'voice:external', reason: c.note || 'consent pending' };
    }
  }
  const t0 = Date.now();
  const res = await provider.transcribe(wavPath);
  const verdict = res.transcript && res.transcript.trim().length > 0 ? 'capture' : 'inconclusive';
  telemetry?.append('task.result', { taskId: `voice-stt:${provider.name}`, action: 'listen', durationMs: Date.now() - t0, result: verdict === 'capture' ? 'success' : 'failure', errorCls: verdict === 'capture' ? null : 'VERIFICATION_FAILURE', attempt: 1 });
  events?.emit('task.updated', { taskId: `voice-stt:${provider.name}`, to: verdict === 'capture' ? 'done' : 'inconclusive' });
  return { ok: verdict === 'capture', decision: 'done', verdict, ...res, durationMs: Date.now() - t0 };
}
