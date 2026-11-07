#!/usr/bin/env node
/**
 * OpenCode Go / GLM bridge health probe — one 2-second answer:
 *  - REACHABLE + AUTHORIZED → live-lane gate OPENS (closeout possible)
 *  - REACHABLE + 401 → provider says the key is expired/invalid (exact reason
 *    printed; never masked as a network problem)
 *  - UNREACHABLE → transport problem (DNS/TLS), retry online
 * Sends a minimal 20-token completion to $OPENCODE_GO_BASE (default GLM coding).
 * Reads the key from env, NEVER logs it.
 *
 * usage: OPENCODE_GO_KEY=oc_sk_xxx node scripts/verify-glm-bridge.mjs
 */
export function classify({ httpCode = 0, body = '' } = {}) {
  if (httpCode === 200) return { open: true, verdict: 'OPEN — live lane reachable and authorized' };
  if (httpCode === 401 || httpCode === 403) {
    const expired = /expired|不正确|令牌|invalid/i.test(body);
    return { open: false, verdict: `BLOCKED: provider rejects the key (${expired ? 'expired/invalid token' : 'forbidden'}) — rotate the key, then re-run. This is an AUTH answer, never a network failure.` };
  }
  if (httpCode === 0) return { open: false, verdict: 'UNREACHABLE: transport-layer failure (DNS/TLS/timeout) — check connectivity' };
  return { open: false, verdict: `UNKNOWN: HTTP ${httpCode} — inspect manually` };
}

if (process.argv[1] && process.argv[1].endsWith('verify-glm-bridge.mjs')) {
  const key = process.env.OPENCODE_GO_KEY || process.env.GLM_API_KEY || '';
  const base = process.env.OPENCODE_GO_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
  if (!key) { console.error('PROBE REFUSED: set OPENCODE_GO_KEY in env first (the probe never reads from argv or files — argv keys land in shell history and file keys land in git)'); process.exit(2); }
  let httpCode = 0, body = '';
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Reply with exactly: MAJIN-LIVE-OK' }], max_tokens: 20 }),
      signal: AbortSignal.timeout(15000),
    });
    httpCode = res.status;
    body = await res.text().catch(() => '');
  } catch { /* network-layer answer: stays 0 */ }
  const c = classify({ httpCode, body });
  console.log(`GLM-bridge probe (${base})`);
  console.log(`  HTTP: ${httpCode || 'no transport'}`);
  console.log(`  verdict: ${c.verdict}`);
  process.exit(c.open ? 0 : 1);
}
