/**
 * V2 provider profiles (opencode connection) — REUSED from V1's live-proven
 * preset table (src/core/presets.js, which has run these gateways for real),
 * plus opencode docs 2026-10-22. Key V1 operational facts carried over:
 *
 *   - Go gateway REFUSES requests without `x-opencode-session` + user-agent
 *     (400 MissingSessionID) — headers below are not decoration
 *   - "Catalog listing does not prove inference access": free models may
 *     return FreeTierError depending on account — we never claim live access
 *     from a list, only from a verified run (honesty rule)
 *   - Zen and Go have SEPARATE access rules
 *
 * Secrets rule (standing): API keys arrive via ENVIRONMENT ONLY — never CLI
 * args, never the repo. Resolution is honest: a profile needing a key
 * refuses to resolve without it (no silent unauthenticated traffic).
 * keyHash = sha256(key).slice(0,8) — attribution without leakage.
 */
import crypto from 'node:crypto';
import { ModelError } from './provider.js';

export const PROVIDER_PROFILES = Object.freeze({
  'opencode-go': Object.freeze({
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyEnv: 'OPENCODE_API_KEY',
    defaultModel: 'glm-5.3-flash',
    // from V1's live-proven preset (src/core/presets.js), not from a catalog scrape
    chatCompletionsModels: ['glm-5.3-flash', 'qwen3.8-flash', 'deepseek-v4.1-flash', 'mimo-v2.6-flash', 'beam-free', 'longcat-2.5-preview-free', 'kimi-k2.6', 'grok-4.6'],
    extraHeaders: Object.freeze({ 'x-opencode-session': 'majin', 'user-agent': 'MAJIN-coding-agent/1.0' }),
    note: 'OpenCode Go subscription. Free models may return FreeTierError per account — catalog listing is NOT proof of inference access. grok/responses-family models may need payloads our chat/completions adapter does not send; the listed models are the ones V1 reached.',
  }),
  'opencode-zen': Object.freeze({
    baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: 'OPENCODE_API_KEY',
    defaultModel: 'nemotron-3-ultra-free',
    chatCompletionsModels: ['nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'ling-3.0-flash-fin-free'],
    extraHeaders: Object.freeze({ 'user-agent': 'MAJIN-coding-agent/1.0' }),
    note: 'OpenCode Zen pay-per-request, separate access rules from Go (per V1 preset notes and docs).',
  }),
  'opencode-local': Object.freeze({
    baseUrl: 'http://127.0.0.1:4096/v1',
    keyEnv: null,
    defaultModel: 'default',
    chatCompletionsModels: [],
    extraHeaders: null,
    note: '`opencode serve` on this machine — no key, loopback only',
  }),
});

/**
 * resolveProfile(name, { env, baseUrl, model }): explicit overrides beat the
 * profile table. Throws ModelError(PROFILE_KEY_MISSING | UNKNOWN_PROFILE).
 * keyRef identifies the ENV VAR (for logs) — never the secret.
 */
export function resolveProfile(name, { env = process.env, baseUrl = null, model = null } = {}) {
  const profile = PROVIDER_PROFILES[name];
  if (!profile) {
    throw new ModelError('UNKNOWN_PROFILE', `unknown provider profile '${name}' — known: ${Object.keys(PROVIDER_PROFILES).join(', ')}`);
  }
  let apiKey = null;
  let keyRef = null;
  if (profile.keyEnv) {
    keyRef = profile.keyEnv;
    apiKey = env[profile.keyEnv] || null;
    if (!apiKey) {
      throw new ModelError(
        'PROFILE_KEY_MISSING',
        `profile '${name}' requires ${profile.keyEnv} in the environment — refusing to send unauthenticated traffic (set it on YOUR machine; keys never enter the repo or CLI args)`,
        { profile: name, keyEnv: profile.keyEnv }
      );
    }
  }
  return Object.freeze({
    name,
    baseUrl: baseUrl || profile.baseUrl,
    model: model || profile.defaultModel,
    apiKey,
    keyRef,
    keyHash: apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8) : null,
    extraHeaders: profile.extraHeaders || null,
    note: profile.note,
  });
}
