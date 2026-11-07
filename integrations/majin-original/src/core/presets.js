/**
 * MAJIN — provider presets.
 * A preset is just a base URL + auth shape. Providers use their documented protocols
 * because MAJIN talks OpenAI-compatible chat/completions and rewrites the URL for
 * the three providers that insist on their own dialect.
 */

/** kind: openai | anthropic | gemini | mock */
export const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
    notes: 'deepseek-flash = V4.1 Flash (cheap/fast). deepseek-v4-pro = heavy reasoning, 1M context.',
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/settings/keys',
    models: ['deepseek/deepseek-flash', 'anthropic/claude-sonnet-5', 'openai/gpt-5.2', 'x-ai/grok-4-fast'],
    notes: '200+ models, one key. Good for MOA references.',
  },
  kilocode: {
    label: 'Kilo Gateway',
    kind: 'openai',
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
    keyEnv: 'KILO_API_KEY',
    keyUrl: 'https://app.kilo.ai',
    models: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5.2',
      'google/gemini-3-pro',
      'mistralai/codestral-2508',
      'poolside/laguna-xs.2:free',
    ],
    notes:
      'One JWT key, ~400 models, OpenAI-compatible. Model ids keep the vendor prefix: kilocode/anthropic/claude-sonnet-4.5. Ids ending in :free cost nothing. GET /models needs no key.',
  },
  opencode: {
    label: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    /* Go-gatewayen vagrant utan session-header (400 MissingSessionID) — MAJIN
       bärgr den at dig, liksom nyckelhanteringen: bara klistra in nyckeln. */
    headers: { 'x-opencode-session': 'majin', 'user-agent': 'MAJIN-coding-agent/1.0' },
    keyEnv: 'OPENCODE_API_KEY',
    apiKey: null,
    models: ['glm-5.3-flash', 'qwen3.8-flash', 'deepseek-v4.1-flash', 'mimo-v2.6-flash', 'beam-free', 'longcat-2.5-preview-free', 'kimi-k2.6', 'grok-4.6'],
    keyUrl: 'https://opencode.ai/docs/go/',
    notes: 'Go and Zen have separate access rules. Free-model requests may work or return FreeTierError depending on account access. Choose a live model; a catalog listing alone does not verify inference access.',
  },
  opencodezen: {
    label: 'OpenCode Zen', kind: 'openai', baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: 'OPENCODE_API_KEY', keyUrl: 'https://opencode.ai/docs/zen/', models: [],
    notes: 'Pay-as-you-go API, separate from Go. A free model can still be restricted to the OpenCode app. Catalog listing does not prove inference access.',
  },
  qwen: {
    label: 'Qwen · Alibaba Cloud', kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY', keyUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key', models: [],
    notes: 'Use the endpoint matching your key region/workspace. Override the endpoint in connection options when needed.',
  },
  nous: {
    label: 'Nous Portal',
    kind: 'openai',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    keyEnv: 'NOUS_API_KEY',
    keyUrl: 'https://portal.nousresearch.com/',
    models: ['Hermes-4', 'Hermes-4-Thinking'],
    notes: 'Hermes 4 via Nous Portal.',
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    notes: 'Low latency — good for the tool loop and voice.',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.2', 'gpt-5.2-mini'],
  },
  anthropic: {
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5', 'claude-opus-4-6'],
    notes: 'The native messages API is translated internally, tools work as usual.',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-3-pro', 'gemini-3-flash'],
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    apiKey: 'ollama',
    models: ['qwen3-coder:30b', 'deepseek-r1:14b', 'llama3.2:3b'],
    notes: 'No key needed. Costs nothing — used as a fallback when the cloud misbehaves.',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyEnv: null,
    apiKey: 'lmstudio',
    models: ['local-model'],
  },
  mock: {
    label: 'Demo (no key)',
    kind: 'mock',
    baseUrl: 'mock://local',
    keyEnv: null,
    apiKey: 'mock',
    models: ['demo-fast', 'demo-pro'],
    notes: 'Scripted provider for testing the agent offline. No data leaves the machine.',
  },
};

/**
 * Behover den har leverantoren en nyckel, eller pratar den med en lokal server
 * utan? Anvands bade av verktyget och UI-rutinen, sa att "spara" aldrig kan
 * lycka med ett tomt falt men aldrig krava en nyckel for Ollama pa burken.
 */
export function keylessUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (['localhost', '[::1]', '0.0.0.0'].includes(host)) return true;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    const parts = host.split('.').map(Number);
    if (parts.some(n => n > 255)) return false;
    return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  } catch { return false; }
}

export function needsKeyFor(entry = {}, preset = null) {
  if ((entry.kind || preset?.kind || 'openai') === 'mock') return false;
  if (entry.apiKey || (preset && preset.apiKey)) return false;
  return !keylessUrl(entry.baseUrl || preset?.baseUrl || '');
}

export function presetCard(name, p) {
  return {
    name,
    label: p.label || name,
    baseUrl: p.baseUrl || '',
    keyUrl: p.keyUrl || null,
    needsKey: (p.kind || 'openai') !== 'mock' && !p.apiKey,
    models: p.models || [],
    notes: p.notes || '',
  };
}

export function presetNames() {
  return Object.keys(PRESETS);
}

/** Split "provider/model" or resolve a bare model name against known presets. */
export function splitModel(ref, cfg) {
  if (!ref) return null;
  const s = String(ref).trim();
  const providerFirst = s.includes('/') ? s.slice(0, s.indexOf('/')) : null;
  if (providerFirst && cfg?.providers?.[providerFirst]) {
    return { provider: providerFirst, model: s.slice(s.indexOf('/') + 1) };
  }
  const providers = cfg?.providers ? Object.keys(cfg.providers) : [];
  for (const p of providers) {
    const preset = PRESETS[p];
    if (preset?.models?.includes(s)) return { provider: p, model: s };
  }
  const def = cfg?.models?.provider || providers[0] || 'mock';
  return { provider: def, model: s };
}

/**
 * The Go model catalog mixes THREE incompatible HTTP protocols. Treating
 * every model as Chat Completions makes Qwen/Grok appear broken even with a
 * valid subscription. These families follow the published Go endpoint table;
 * unknown/new model IDs remain on the original compatible path until listed.
 */
export function goDialect(model) {
  const id = String(model || '').toLowerCase();
  if (/^(?:qwen3(?:[.-]|$)|minimax-|claude-)/.test(id)) return 'anthropic';
  if (/^(?:grok-|gpt-|muse-spark-)/.test(id)) return 'responses';
  return 'openai';
}

/** OpenAI-compatible chat endpoint for a provider. */
export function chatUrl(provider) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.kind === 'anthropic') return `${base}/messages`;
  if (provider.kind === 'responses') return `${base}/responses`;
  if (provider.kind === 'gemini') return `${base.replace(/\/openai$/, '')}/openai/chat/completions`;
  return `${base}/chat/completions`;
}

export function listModelsUrl(provider) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.kind === 'gemini') return `${base}/models`;
  if (/^https:\/\/[^/]+(?:aliyuncs\.com)(?:\/|$)/i.test(base) && /\/compatible-mode\/v1$/.test(base)) return `${base.replace(/\/compatible-mode\/v1$/, '')}/api/v1/models?capabilities=TG&capabilities=Reasoning&page_size=100`;
  return `${base}/models`;
}
