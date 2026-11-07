/**
 * MAJIN V4 — configuration and platform contract.
 *
 * One place decides where data lives, which model route is active, and which
 * safety limits apply. Everything is explicit, env-overridable and testable;
 * nothing here reads a secret into a log line.
 *
 * Provider resolution order (first complete route wins):
 *   1. MAJIN_V4_PROVIDER + MAJIN_V4_BASE_URL + MAJIN_V4_API_KEY + MAJIN_V4_MODEL
 *   2. The V1 config file ($MAJIN_HOME/config.json or ~/.majin/config.json)
 *      models.routes.chat -> "provider/model", using providers[provider]
 *   3. demo — a deterministic local brain. Clearly labelled in the UI and in
 *      every API response as `demo: true`. It is not a language model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFlags } from './kernel.js';
export const V4_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const V4_MIN_NODE = '22.0.0';

export function isNodeSupported(version = process.versions.node) {
  const m = String(version).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  return Number(m[1]) >= 22;
}

export function assertNodeSupported(version = process.versions.node) {
  if (!isNodeSupported(version)) {
    throw new Error(`MAJIN V4 requires Node.js >=${V4_MIN_NODE}; detected ${version || 'unknown'}.`);
  }
}

const bool = (v, d = false) => {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};
const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

/** ~/.majin on POSIX, %LOCALAPPDATA%\\MAJIN on Windows (same rule as V1). */
export function dataDirFor(env = process.env, platform = process.platform) {
  if (env.MAJIN_HOME) return path.resolve(env.MAJIN_HOME);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'MAJIN');
  }
  return path.join(os.homedir(), '.majin');
}

export function v4Paths({ env = process.env, platform = process.platform } = {}) {
  const home = dataDirFor(env, platform);
  const root = path.join(home, 'v4');
  return {
    home,
    root,
    sessions: path.join(root, 'sessions'),
    conversations: path.join(root, 'conversations'),
    goals: path.join(root, 'goals'),
    memory: path.join(root, 'memory'),
    logs: path.join(root, 'logs'),
    secret: path.join(root, 'secret.key'),
    pairing: path.join(root, 'pairing.json'),
    serverState: path.join(root, 'sessions.json'),
    plugins: path.join(root, 'plugins'),
    workspace: env.MAJIN_V4_WORKSPACE
      ? path.resolve(env.MAJIN_V4_WORKSPACE)
      : path.join(home, 'workspace'),
  };
}

/** Expand V1's "{env:NAME}" indirection without ever echoing the value. */
export function expandEnvValue(raw, env = process.env) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^\{env:([A-Z0-9_]+)\}$/i);
  if (m) return env[m[1]] || null;
  if (raw === '' || raw === 'null') return null;
  return raw;
}

/** Read existing outbound credentials at call time; never expose or rewrite them. */
export function channelConfigFromV1({home, env = process.env}) {
  const file = env.MAJIN_CONFIG || path.join(home, 'config.json');
  const allowed = new Set(['discord.token', 'discord.channelId', 'slack.token', 'slack.channel',
    'matrix.token', 'matrix.homeserver', 'matrix.room', 'email.relayUrl', 'email.apiKey',
    'email.from', 'webhook.url', 'webhook.secret']);
  return Object.freeze({get(key) {
    if (typeof key !== 'string' || !key.startsWith('channels.') || !allowed.has(key.slice(9))) return undefined;
    let value;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      value = key.split('.').reduce((obj, part) => obj && Object.hasOwn(obj, part) ? obj[part] : undefined, data);
    } catch { return undefined; }
    return expandEnvValue(value, env) ?? undefined;
  }});
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the active chat route from the V1 config file, if one exists.
 * Deliberately narrow: only models.routes.chat and the provider it names.
 */
export function routeFromV1Config({ home, env = process.env } = {}) {
  const file = env.MAJIN_CONFIG || path.join(home, 'config.json');
  const cfg = readJson(file);
  if (!cfg || typeof cfg !== 'object') return null;
  const ref = cfg.models?.routes?.chat || cfg.models?.routes?.tasks;
  if (typeof ref !== 'string' || !ref.includes('/')) return null;
  const idx = ref.indexOf('/');
  const providerName = ref.slice(0, idx);
  const model = ref.slice(idx + 1);
  const provider = cfg.providers?.[providerName];
  if (!provider || !provider.baseUrl) return null;
  const apiKey = expandEnvValue(provider.apiKey, env);
  if (!apiKey) return null;
  const kind = ['anthropic', 'responses', 'mock', 'openai'].includes(provider.kind) ? provider.kind : 'openai';
  return {
    kind,
    providerName,
    label: provider.label || providerName,
    baseUrl: String(provider.baseUrl).replace(/\/+$/, ''),
    apiKey,
    model,
    extraHeaders: provider.headers || null,
    source: `config:${file}`,
  };
}

/**
 * Resolve the model route. Returns {kind:'demo'} when nothing usable is
 * configured — never a silent fallback to a paid endpoint the user did not pick.
 */
export function resolveModelRoute({ env = process.env, home } = {}) {
  const explicit = (env.MAJIN_V4_PROVIDER || '').toLowerCase();
  const baseUrl = env.MAJIN_V4_BASE_URL ? String(env.MAJIN_V4_BASE_URL).replace(/\/+$/, '') : null;
  const apiKey = env.MAJIN_V4_API_KEY || null;
  const model = env.MAJIN_V4_MODEL || null;

  if (explicit === 'demo' || explicit === 'none') return { kind: 'demo', providerName: 'demo', label: 'Demo' };

  if (baseUrl && model && (apiKey || explicit === 'openai-local')) {
    // Some gateways require identifying headers (OpenCode Go refuses a request
    // that does not look like it comes from its own client). They are supplied as
    // JSON and are never logged: they are identity headers, not secrets.
    let extraHeaders = null;
    if (env.MAJIN_V4_EXTRA_HEADERS) {
      try {
        const parsed = JSON.parse(env.MAJIN_V4_EXTRA_HEADERS);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          extraHeaders = Object.fromEntries(
            Object.entries(parsed)
              .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
              .slice(0, 12),
          );
        }
      } catch {
        extraHeaders = null; // a malformed value must not silently change routing
      }
    }
    return {
      kind: ['anthropic', 'responses'].includes(explicit) ? explicit : 'openai',
      providerName: env.MAJIN_V4_PROVIDER_NAME || explicit || 'custom',
      label: env.MAJIN_V4_PROVIDER_LABEL || 'Custom provider',
      baseUrl,
      apiKey: apiKey || 'local',
      model,
      ...(extraHeaders && Object.keys(extraHeaders).length ? { extraHeaders } : {}),
      maxTokens: int(env.MAJIN_V4_MAX_TOKENS, 2048),
      temperature: Number(env.MAJIN_V4_TEMPERATURE ?? 0.4),
      source: 'env:MAJIN_V4_*',
    };
  }

  const fromConfig = home ? routeFromV1Config({ home, env }) : null;
  if (fromConfig && fromConfig.kind !== 'mock') {
    return { ...fromConfig, maxTokens: int(env.MAJIN_V4_MAX_TOKENS, 2048), temperature: Number(env.MAJIN_V4_TEMPERATURE ?? 0.4) };
  }

  return { kind: 'demo', providerName: 'demo', label: 'Demo' };
}

function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Full V4 config. `origin` is the public HTTPS origin when the host runs
 * behind a tunnel; it is used for cookie and CSRF decisions, never trusted
 * blindly for authorization.
 */
export function loadConfig({ env = process.env, argv = [], platform = process.platform } = {}) {
  const paths = v4Paths({ env, platform });
  const argPort = (() => {
    const i = argv.indexOf('--port');
    return i >= 0 ? int(argv[i + 1], null) : null;
  })();
  const argHost = (() => {
    const i = argv.indexOf('--host');
    return i >= 0 ? argv[i + 1] : null;
  })();

  const publicOrigin = env.MAJIN_V4_PUBLIC_ORIGIN ? new URL(env.MAJIN_V4_PUBLIC_ORIGIN).origin : null;
  const port = argPort ?? int(env.MAJIN_V4_PORT ?? env.PORT, 7373);
  const host = argHost || env.MAJIN_V4_HOST || '127.0.0.1';
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
    ...splitList(env.MAJIN_V4_ALLOWED_HOSTS),
  ]);

  const writePolicy = (env.MAJIN_V4_WRITE_POLICY || 'sandbox-auto').toLowerCase();

  return {
    version: V4_VERSION,
    node: process.versions.node,
    paths,
    channelConfig: channelConfigFromV1({home: paths.home, env}),
    host,
    port,
    publicOrigin,
    allowedHosts,
    trustProxy: bool(env.MAJIN_V4_TRUST_PROXY, false),
    frameAncestors: env.MAJIN_V4_FRAME_ANCESTORS || "'none'",
    workspaceDir: paths.workspace,
    demo: bool(env.MAJIN_V4_DEMO, false),
    model: resolveModelRoute({ env, home: paths.home }),
    auth: {
      sessionTtlMs: int(env.MAJIN_V4_SESSION_TTL_MS, 1000 * 60 * 60 * 24 * 30),
      cookieName: 'majin_v4',
      // Secure is decided per request from the actual protocol / proxy header.
      allowInsecureCookie: bool(env.MAJIN_V4_ALLOW_INSECURE_COOKIE, false),
    },
    limits: {
      maxBodyBytes: int(env.MAJIN_V4_MAX_BODY_BYTES, 64 * 1024),
      maxMessageChars: int(env.MAJIN_V4_MAX_MESSAGE_CHARS, 8000),
      // A real task is not one round: read a document, open a browser, search,
      // read results, fill a form, verify. Four rounds ended such a task
      // mid-flight ("model round budget exhausted"), which looked like a bug to
      // the owner. Still bounded — the brief requires bounded attempts — but
      // bounded at a number that matches real work.
      maxModelRounds: int(env.MAJIN_V4_MAX_MODEL_ROUNDS, 16),
      // Conversation history sent to the model, in estimated tokens. Over this,
      // the oldest turns are dropped instead of failing the whole request.
      maxContextTokens: int(env.MAJIN_V4_MAX_CONTEXT_TOKENS, 8000),
      maxToolCallsPerTurn: int(env.MAJIN_V4_MAX_TOOL_CALLS, 24),
      // Tools sent to the model per request. Everything beyond this is still
      // reachable through tools_search + tools_activate; the model is told so.
      maxVisibleTools: int(env.MAJIN_V4_MAX_VISIBLE_TOOLS, 64),
      toolTimeoutMs: int(env.MAJIN_V4_TOOL_TIMEOUT_MS, 20_000),
      modelTimeoutMs: int(env.MAJIN_V4_MODEL_TIMEOUT_MS, 120_000),
      rate: {
        windowMs: int(env.MAJIN_V4_RATE_WINDOW_MS, 60_000),
        requests: int(env.MAJIN_V4_RATE_REQUESTS, 60),
        turns: int(env.MAJIN_V4_RATE_TURNS, 20),
        pairing: int(env.MAJIN_V4_RATE_PAIRING, 5),
      },
      maxStoredMessages: int(env.MAJIN_V4_MAX_STORED_MESSAGES, 400),
    },
    approvals: {
      // Workspace writes are create-only inside a sandbox and verify after the
      // fact; `strict` turns every write into an explicit human confirmation.
      policy: writePolicy === 'strict' ? 'strict' : 'sandbox-auto',
    },
    platform: {
      features: parseFlags(env.MAJIN_V4_FLAGS),
      pluginsEnabled: bool(env.MAJIN_V4_PLUGINS, false),
      pluginAllowlist: splitList(env.MAJIN_V4_PLUGIN_ALLOW),
      // Host tools (V1's Windows/files/shell lanes) are OFF by default. Turning
      // them on is an owner decision, and the allowlist narrows it further.
      hostTools: bool(env.MAJIN_V4_HOST_TOOLS, false),
      hostToolAllow: splitList(env.MAJIN_V4_HOST_TOOL_ALLOW),
      pluginsDir: path.join(paths.root, 'plugins'),
      pluginQuarantineDir: path.join(paths.root, 'plugins-quarantine'),
      // Process isolation is the default; MAJIN_V4_PLUGIN_ISOLATE=0 keeps a
      // plugin in-process for debugging. Isolation is not a security sandbox.
      pluginIsolate: bool(env.MAJIN_V4_PLUGIN_ISOLATE, true),
    },
  };
}
