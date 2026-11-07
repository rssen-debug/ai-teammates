/**
 * MAJIN — config.
 * One JSON file is the whole brain: providers, keys, routes, MOA, channels, guard.
 * The agent can read and write it itself (tool: majin.configure), which is why
 * every value here is plain JSON and every write is validated + backed up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, expand } from './paths.js';
import { PRESETS, presetNames, splitModel, chatUrl, goDialect } from './presets.js';

/** Model routing table keys. A "job" is any of these; a route is provider/model. */
export const JOBS = [
  'chat',
  'tools',
  'tasks',
  'summarize',
  'router',
  'vision',
  'code',
  're',
  'plan',
  'research',
  'analysis',
  'final',
  'aggregator',
];

export const DEFAULTS = {
  version: 1,
  name: 'MAJIN',
  workspace: null,
  /* browser-use: one window per agent task, a capped fleet for the whole machine */
  browser: { maxInstances: 3, rpcTimeoutMs: 20000 },
  persona: {
    identity:
      "MAJIN — a personal agent running directly on the user's own machine (Windows first). You talk briefly, in the language the user writes in, and you never explain what you are about to do before you have done it.",
    style:
      "Act first, report after. Short sentences. No fluff, no apologies. Numbers and paths before adjectives. If you are unsure, say exactly what is uncertain instead of saying sorry.",
    safety: "You have access to the whole machine. Verify before you destroy. Never delete something you did not create.",
  },
  providers: {
    /* Alla presets finns från början med tom nyckel — UI:t och "lägg till provider"
       ska visa vad som går att välja, och naturligt språk ("använd openrouter …") ska
       kunna peka en rutt på dem direkt. */
    ...Object.fromEntries(
      Object.entries(PRESETS)
        .filter(([name]) => name !== 'deepseek' && name !== 'mock')
        .map(([name, p]) => [name, { label: p.label, kind: p.kind, baseUrl: p.baseUrl, apiKey: null, models: [...(p.models || [])], keyEnv: p.keyEnv || null, keyUrl: p.keyUrl || null, ...(p.headers ? { headers: { ...p.headers } } : {}) }]),
    ),
    deepseek: {
      label: 'DeepSeek',
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '{env:DEEPSEEK_API_KEY}',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    },
    demo: { label: 'Demo (local)', kind: 'mock', baseUrl: 'mock://local', apiKey: 'demo', models: ['demo-fast', 'demo-pro'] },
  },
  models: {
    provider: 'deepseek',
    fallbackOrder: ['deepseek', 'demo'],
    routes: {
      chat: 'deepseek/deepseek-flash',
      tasks: 'deepseek/deepseek-flash',
      tools: 'deepseek/deepseek-flash',
      summarize: 'deepseek/deepseek-flash',
      router: 'deepseek/deepseek-flash',
      vision: 'deepseek/deepseek-flash',
      code: 'deepseek/deepseek-v4-pro',
      re: 'deepseek/deepseek-v4-pro',
      analysis: 'deepseek/deepseek-v4-pro',
      plan: 'deepseek/deepseek-v4-pro',
      research: 'deepseek/deepseek-v4-pro',
      final: 'deepseek/deepseek-v4-pro',
      aggregator: 'deepseek/deepseek-v4-pro',
    },
    defaults: { temperature: 0.2, maxTokens: 4096 },
  },
  pricing: {
    'deepseek/deepseek-flash': { in: 0.14, out: 0.28 },
    'deepseek/deepseek-v4-pro': { in: 1.7, out: 8 },
  },
  /* provenance for prices that rode in from a provider's /models answer —
     populated by src/core/pricing.js, gaps only, never overwrites. */
  pricingMeta: {},
  routing: {
    auto: true,
    escalateAfterErrors: 2,
    escalateJob: 'analysis',
    llmTiebreak: true,
    llmTiebreakAbove: 0.45,
    escalateOnDisagreement: 0.35,
    escalateOnErrors: true,
    rules: [
      { id: 're', match: '/(reverse|ghidra|ida|rizin|binary|binär|exe|dll|malware|virus|packer|unpack|dump|disassembl|reversing|apk|firmware)/i', job: 're', note: 'reverse engineer-jobb → tung modell' },
      { id: 'code', match: '/(\\bcode\\b|kod(a|e)?\\b|bugg|bug|error|exception|typescript|python|js|refactor|test|build|compile)/i', job: 'code', note: 'code → heavy model' },
      { id: 'research', match: '/(sök|search|hitta|research|vad är|latest|nyaste|källa|webb)/i', job: 'research', note: 'web research' },
      { id: 'tasks', match: '/(fil|mapp|copy|flytta|sortera|batch|rename|döp om|rens(a|a)|zip|packa)/i', job: 'tasks', note: 'file chat → cheap fast model' },
      { id: 'chat', match: '/^(tack|okej|ok|ja|nej|hej|hmm|vet inte)\\b.{0,25}$/i', job: 'chat', note: 'prat → billigast' },
    ],
  },
  moa: {
    enabled: true,
    policy: 'off', /* VNEXT §3: multi-model spend is opt-in, never a default */
    hardJobs: ['re', 'code', 'analysis', 'plan', 'final', 'research'],
    width: 3,
    references: [
      { model: 'deepseek/deepseek-flash', temperature: 0.1 },
      { model: 'deepseek/deepseek-flash', temperature: 0.8 },
      { model: 'deepseek/deepseek-v4-pro', temperature: 0.3 },
    ],
    aggregator: 'deepseek/deepseek-v4-pro',
    referenceMaxTokens: 900,
    aggregatorMaxTokens: 3000,
    referenceTemperature: 0.5,
    disagreementFloor: 0.25,
  },
  tools: {
    allow: '*',
    maxOutputChars: 9000,
    shell: { timeoutSec: 150, maxOutputChars: 12000, requireApproval: 'dangerous', allowlist: [] },
    files: { maxReadBytes: 4000000, followSymlinks: false },
    web: { provider: 'auto', searxng: null, timeoutSec: 25, maxChars: 60000, fetchRetry: 1 },
    re: {
      maxFileBytes: 268435456,
      stringsMax: 20000,
      capstone: true,
      external: 'auto',
      yaraRules: [],
      ghidraProjectDir: null,
      headlessTimeoutSec: 900,
    },
    http: { allowPrivate: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MAJIN/1.0' },
  },
  guard: {
    mode: 'confirm',
    askOn: ['/(?<![a-z])(rm\\s+-[rf]{2,}|del\\s+/[sq]|format\\s+[a-z]:|diskpart|shutdown\\s+/[sr]|Remove-Item[^\\n]*(Recurse|Force)[^\\n]*(windows|system32)|reg\\s+delete|netsh\\s+advfirewall\\s+(set|delete)|cipher\\s+/w|vssadmin\\s+delete|rmdir\\s+/s)(?![a-z])/i'],
    neverOn: ['/\\b(mkfs|ntfsutil\\s+security\\s+query)\\b|:\\(\\)\\s*\\{[^}]*\\}\\s*;\\s*:/i', '/\\b(dd\\s+if=\\S+\\s+of=/dev/[a-z]{2,}|clean all)\\b/i'],
    protectedPaths: ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\boot', '/boot', '/etc'],
    pathWriteRoots: ['auto'],
  },
  memory: {
    dir: 'memory',
    auto: true,
    maxDigestChars: 2400,
    sessionCap: 400,
    facts: [
      'The user wants every tool on all the time — no enable/disable.',
      'The agent may change its own config when the user says things like "use X for Y always".',
    ],
  },
  skills: { dir: 'skills', auto: true, maxInPrompt: 12 },
  schedule: { enabled: true, timezone: 'local', maxConcurrent: 2, tickMs: 20000, readOnlyDefault: false },
  tasks: { concurrency: 3, approvalTimeoutMs: 180000 },
  channels: {
    telegram: { enabled: true, botToken: null, apiBase: 'https://api.telegram.org', allowedChatIds: [], pairingCode: null, pollTimeoutSec: 30, parseMode: 'HTML', proxy: null, reactions: true },
    whatsapp: {
      enabled: true,
      transport: 'baileys',
      baileys: { sessionDir: 'whatsapp', verbose: false },
      cloud: { accessToken: null, phoneNumberId: null, verifyToken: null, apiVersion: 'v23.0', appSecret: null, allowedNumbers: [] },
      allowedJids: [],
      replyPrefix: '',
      maxMessageChars: 4000,
    maxRetries: 6,                  // QR ingen skannar: backa och ge upp i stället för att spamma
    },
    shared: { forwardToChat: true, requirePairing: true, idleSessionCloseMin: 720, deliverTo: null, replyWhileStreaming: false },
    webhook: { enabled: false, host: '0.0.0.0', port: 8788, path: '/whatsapp', tunnel: 'none' },
  },
  agent: {
    /* facit: alls schemas varje turn. toolSubset: true = the loop skickar bara
       determiniskt utvalda verktyg (search(input) + alltid tools.search som
       flyktväg). Mätt-skick: flippa till true först när bench visar paritet
       + uträknat spar — se DECISIONS Öppna frågor. */
    toolSubset: true,
    toolSubsetLimit: 12,
    maxSteps: 60,
    parallel: true,
    contextTokens: 48000,
    keepRecent: 12,
    summarizeAbove: 20000,
    autoReflect: true,
    reflectEvery: 8,
    subagents: { enabled: true, maxParallel: 3, maxSteps: 14, shareMemory: true },
    retries: 2,
    timeoutMs: 120000,
    temperature: 0.2,
    maxTokens: 6000,
    historyInPrompt: 40,
    stepJob: 'same',
  },
  ui: {
    title: 'MAJIN',
    tagline: 'everything on — always ready',
    theme: 'jarvis',
    voice: { enabled: true, lang: 'sv-SE', wakeWord: '', requireWakeWord: false, foregroundGate: false, tts: true, ttsVoice: null, rate: 1.05, pitch: 0.95 },
    transparency: { showTools: 'verbose', showThinking: 'summary', showTokens: true },
    density: 'comfortable',
    autoOpen: true,
  },
  budget: { mode: 'track', monthlyUsd: 0, warnAt: 0.8, perTaskUsd: 0 },
  /* Del 4C: hard caps that code enforces on every mission run. 0 = off for the
     time/token caps; repairRounds is the verify->repair ceiling (never infinite). */
  mission: { limits: { repairRounds: 1, timeoutMs: 0, tokenBudget: 0, transientRetries: 1, replanRounds: 1 } },
  // Analysis-only Meta Ads integration. The access token stays local and
  // is always redacted by GET /api/config; use an env reference if preferred.
  marketing: {
    meta: { accountId: '', currency: '', accessToken: '{env:MAJIN_META_ACCESS_TOKEN}' },
    tiktok: { advertiserId:'', currency:'', accessToken:'{env:MAJIN_TIKTOK_ADS_ACCESS_TOKEN}' },
    google: { customerId:'', currency:'', accessToken:'{env:MAJIN_GOOGLE_ADS_ACCESS_TOKEN}', developerToken:'{env:MAJIN_GOOGLE_ADS_DEVELOPER_TOKEN}', loginCustomerId:'' },
    economics: { price: 0, cogs: 0, shipping: 0, fees: 0, refundRate: 0, targetProfit: 0, dailyCap: 0 },
  },
  // Spelas endast in när användaren uttryckligen bett om det. Uppladdning finns inte som
  // kodväg alls — export är ett medvetet steg, ingen tyst dataflöde från en privat maskin.
  dataset: {
    capture: false,                  // inget spelas in förrän användaren säger till
    dir: null,                       // null = <MAJIN_HOME>/dataset
    keepDays: 90,                    // gammalt tas bort, mappen växer för alltid
    include: { answer: true, toolArgs: true, plan: true },
    // ingen upload-nyckel alls — den som vill dela en uppsättning exporterar filen själv
  },
  logging: { level: 'info', keepDays: 14, jsonl: true },
  server: { host: '0.0.0.0', port: 8787, token: null, openBrowser: true, allowRemote: false, trustLocal: true },
  /* Update checks against GitHub Releases. `check: false` means no request is ever made;
     the rest is only ever written by src/core/update.js, never fetched from. */
  updates: {
    check: true,
    intervalHours: 24,
    repo: 'rssen-debug/MAJINCLI',
    channel: '',
    token: null,
    lastCheck: 0,
    latest: null,
    url: null,
    notes: null,
    asset: null,
    checkedVersion: null,
  },
};

const SECRET_KEYS = /(^|\.)(apikey|key|token|secret|bottoken|accesstoken|developertoken|password|appsecret|verifytoken)$/i;
const ENV_REF = /^\{env:([A-Z0-9_]+)\}$/i;

/* ------------------------------- utils ----------------------------------- */

export function clone(o) {
  return structuredClone(o);
}

export function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Plain data object (RegExp/Buffer/Map are NOT plain — never walk into them). */
export function isPlain(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/* Del 10E (CVE-class): keys that rewrite JS object identity. A config patch
   containing "__proto__"/"constructor"/"prototype" must NEVER reach a merge
   or a dotted-path write — sandbox-adversarial test 10E-V2 proved the naive
   merge made cfg.get('guard.pwned') reachable from payload __proto__. The
   defense: drop the segment ENTIRELY (not just neutralize the value). */
const DANGEROUS_SEGS = new Set(['__proto__', 'constructor', 'prototype']);

export function merge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || !isPlain(patch) || !isPlain(base)) return clone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (DANGEROUS_SEGS.has(k)) continue; // 10E: hostile identity keys vanish here
    if (v === undefined) delete out[k];
    else out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k], v) : clone(v);
  }
  return out;
}

/** Deep-merge that keeps user arrays intact but merges array-of-objects by identity key. */
export function smartMerge(base, patch) {
  return merge(base, patch);
}

export function getPath(obj, dotted) {
  return dotted.split('.').reduce((a, k) => {
    if (a == null || DANGEROUS_SEGS.has(k) || !Object.prototype.hasOwnProperty.call(a, k)) return undefined;
    return a[k];
  }, obj);
}

export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  if (keys.some((k) => DANGEROUS_SEGS.has(k))) return obj; // 10E: sabotage-segment write refused
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  return obj;
}

export function expandEnv(v) {
  if (typeof v === 'string') {
    const m = ENV_REF.exec(v);
    if (m) return process.env[m[1]] || '';
    return v;
  }
  if (Array.isArray(v)) return v.map(expandEnv);
  if (isPlain(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = expandEnv(val);
    return out;
  }
  return v;
}

export function redact(v, keyName = '') {
  if (typeof v === 'string') {
    if (!v) return '';
    if (SECRET_KEYS.test(keyName)) return `${v.slice(0, 2)}${'•'.repeat(Math.min(12, Math.max(3, v.length - 2)))}`;
    return v;
  }
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, keyName));
  if (isPlain(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redact(val, k);
    return out;
  }
  return v;
}

/* ------------------------------- store ------------------------------------- */

export class Config {
  constructor(data, file) {
    if (data && !data.workspace) data.workspace = dirs.workspace;
    this.data = data;
    this.file = file;
    this.subs = new Set();
    this.errors = [];
    /* paths denna process raderade med undefined i patch — skydd mot återuppståndelse */
    this.tombstones = new Set();
  }

  get(key) {
    /* callers must never mutate the live config silently past validation —
       hand out a live view ONLY through raw() */
    const v = key ? getPath(this.data, key) : this.data;
    return v && typeof v === 'object' ? structuredClone(v) : v;
  }

  raw() {
    return this.data;
  }

  json() {
    return clone(this.data);
  }

  redacted() {
    return redact(jsonable(clone(this.data)));
  }

  patch(obj, { dry = false, source = 'api' } = {}) {
    const errors = validatePatch(obj, this.data);
    const diff = flattenDiff(this.data, obj);
    if (errors.length) return { ok: false, errors, diff };
    if (dry) return { ok: true, errors: [], diff, preview: merge(this.data, obj) };
    /* Skivan är delad sanning: en annan process (CLI, andra servern) kan skriva
       medan vi är uppe. Applicera patchen ovanpå den färskaste filen — men
       respektera tombstones: nycklar som DENNA process medvetet raderade
       (undefined i patch) får aldrig återuppstå via en disc-merge med DEFAULTS
       (CI-bevisat: provider-remove väckte raderade providrar; en motriktning
       bevisad i run 39128429043: update-check raderade CLI-markören). */
    let base = this.data;
    try {
      if (this.file && fs.existsSync(this.file)) {
        const onDisk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (isPlain(onDisk)) {
          /* samma pipeline som load(): DEFAULTS fyller i, sedan expandEnv —
             annan blir '{env:X}'-literaler "sanna nycklar" i resolveModel
             och fallback-vägen dör (A/B-bevisat: turner 401:ade via literalen) */
          base = expandEnv(merge(clone(DEFAULTS), onDisk));
          for (const t of this.tombstones) {
            const parts = t.split('.');
            let node = base;
            for (let i = 0; i < parts.length - 1 && node; i++) node = node[parts[i]];
            if (node && Object.prototype.hasOwnProperty.call(node, parts.at(-1))) delete node[parts.at(-1)];
          }
        }
      }
    } catch { /* oläsbar disk → skriv det vi har */ }
    const prev = this.data;
    this.data = merge(base, obj);
    const walk = (node, prefix) => {
      if (!isPlain(node)) return;
      for (const [k, v] of Object.entries(node)) {
        const p = prefix ? prefix + '.' + k : k;
        if (v === undefined) this.tombstones.add(p);
        else if (isPlain(v)) walk(v, p);
      }
    };
    walk(obj, '');
    /* miljövariabler kör alltid före fil — en disk-merge med äldre värden får
       aldrig tyst riva MAJIN_PORT/MAJIN_TOKEN som processen startades med */
    if (process.env.MAJIN_TOKEN && String(process.env.MAJIN_TOKEN).trim()) this.data.server.token = String(process.env.MAJIN_TOKEN).trim();
    if (Number.isFinite(Number(process.env.MAJIN_PORT))) this.data.server.port = Number(process.env.MAJIN_PORT);
    this.errors = [];
    const persisted = this.save();
    for (const fn of this.subs) {
      try {
        fn({ patch: obj, source, prev });
      } catch (err) {
        void err;
      }
    }
    if (!persisted) {
      const err = this.lastSaveError || { message: 'unknown save failure', code: 'save_failed' };
      return { ok: false, errors: [{ path: '(config)' , msg: `disk save failed: ${err.message}`, code: 'save_failed' }], diff, applied: obj, persisted: false };
    }
    return { ok: true, errors: [], diff, applied: obj, persisted: true };
  }

  onChange(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** P0 (UI-agent handover 2026-10-19): atomic, honestly reported save.
      tmp-write → fsync → backup current → rename. A write failure leaves the
      PREVIOUS file intact on disk and returns { ok:false, error } — callers
      must propagate, never pretend. returns {ok:true} on success. */
  save() {
    const file = this.file || dirs.config;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify(jsonable(this.data), null, 2) + '\n';
      fs.writeFileSync(tmp, payload, 'utf8');
      try {
        const fd = fs.openSync(tmp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { /* fsync best-effort */ }
      try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: nope */ }
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch { /* backup is best-effort */ }
      }
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* Windows: nope */ }
      return true;
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* fine */ }
      this.lastSaveError = { message: String(err?.message || err), code: err?.code || 'save_failed', when: new Date().toISOString() };
      return false;
    }
  }

  /** provider + model + kind for a route reference like "deepseek/deepseek-flash". */
  resolveModel(ref, job) {
    const r = ref || (job && this.data.models.routes[job]) || this.data.models.routes.tools;
    const parsed = splitModel(r, this.data);
    const name = parsed.provider;
    const provider = { label: name, kind: 'openai', baseUrl: '', apiKey: '', ...(this.data.providers[name] || {}) };
    const pricing = this.data.pricing?.[`${name}/${parsed.model}`] || null;
    const kind = name === 'opencode' ? goDialect(parsed.model) : (provider.kind || PRESETS[provider.preset]?.kind || 'openai');
    return {
      ref: `${name}/${parsed.model}`,
      providerName: name,
      // etiketten med (DeepSeek, inte deepseek) sa att felmeddelanden namner
      // leverantoren pa samma sat som mannen kan lasa den i panelen
      label: provider.label || name,
      model: provider.kind === 'gemini' ? parsed.model.replace(/^models\//, '') : parsed.model,
      kind,
      baseUrl: provider.baseUrl,
      endpoint: provider.endpoint || chatUrl({ kind, baseUrl: provider.baseUrl }),
      // Environment keys remain in the process, never copied to config or UI.
      apiKey: provider.apiKey || (provider.keyEnv && process.env[provider.keyEnv]) || '',
      extraHeaders: provider.headers || {},
      pricing,
      /* GODLIKE V4 §7: per-provider quota (owner-configured) rides the route so
         the admission layer never needs a second config lookup. Absent →
         pass-through, no invented limits. */
      quota: this.data.limits?.[name] ? { ...this.data.limits[name] } : null,
      job,
    };
  }

  /** All routes as a flat table, with mock/unknown providers flagged. */
  routeTable() {
    const out = [];
    for (const [job, ref] of Object.entries(this.data.models.routes)) {
      const r = this.resolveModel(ref, job);
      out.push({ job, ref, provider: r.providerName, model: r.model, kind: r.kind, ready: hasKey(r) });
    }
    return out;
  }

  rules() {
    return this.compiled?.rules || compileRuntime(this).rules;
  }

  guardPatterns(kind) {
    return this.compiled?.[kind] || compileRuntime(this)[kind] || [];
  }

  moaConfig() {
    const m = this.data.moa;
    if (!m || !m.enabled || m.policy === 'off') return { enabled: false, references: [], policy: 'off' };
    return {
      enabled: true,
      policy: m.policy,
      hardJobs: m.hardJobs || [],
      width: m.width || m.references.length,
      references: (m.references || []).map((r) => ({ ...r, model: this.usableRef(r.model), maxTokens: r.maxTokens ?? m.referenceMaxTokens ?? 900 })),
      aggregator: this.usableRef(m.aggregator || this.data.models.routes.aggregator),
      aggregatorMaxTokens: m.aggregatorMaxTokens ?? 4096,
      disagreementFloor: m.disagreementFloor ?? 0.25,
    };
  }

  /** Sant när ingen riktig (icke-mock) provider har nyckel — demo räknas inte. */
  needsSetup() {
    const providers = Object.values(this.data.providers);
    return !providers.some((p) => hasKey(p) && (p.kind || PRESETS[p.preset]?.kind || 'openai') !== 'mock');
  }

  realProviders() {
    return this.providerStatus().filter((p) => p.kind !== 'mock');
  }

  /** Ref varsas ur en provider utan nyckel ersätts av det som faktiskt är igång. */
  usableRef(ref) {
    const want = String(ref || '');
    if (!want) return this.defaultRef();
    const [name] = want.split('/');
    const prov = this.data.providers[name];
    if (prov && hasKey(prov)) return want;
    const alt = this.defaultRef();
    return alt || want;
  }

  defaultRef() {
    const prim = this.data.models?.provider;
    const candidates = [prim && `${prim}/${this.data.models?.routes?.tools?.split('/')[1] || 'default'}`, this.data.models?.routes?.tools, this.data.models?.routes?.chat];
    for (const c of candidates) {
      if (!c) continue;
      const [name] = c.split('/');
      const prov = this.data.providers[name];
      if (prov && hasKey(prov)) return c;
    }
    const open = Object.entries(this.data.providers).find(([, p]) => hasKey(p));
    return open ? `${open[0]}/${open[1].models?.[0] || 'default'}` : null;
  }

  providerStatus() {
    return Object.entries(this.data.providers).map(([name, p]) => {
      const kind = p.kind || PRESETS[p.preset]?.kind || 'openai';
      return { name, label: p.label || name, kind, baseUrl: p.baseUrl || '', ready: kind === 'mock' ? true : hasKey(p), models: p.models || [], hasKey: hasKey(p) };
    });
  }
}

export function hasKey(provider) {
  if (!provider) return false;
  if (provider.kind === 'mock') return true;
  const raw = String(provider.apiKey || '').trim();
  // Detect environment-configured providers without persisting their secret.
  if (!raw && provider.keyEnv && String(process.env[provider.keyEnv] || '').trim()) return true;
  if (!raw) return false;
  if (/^\{env:[A-Z0-9_]+\}$/i.test(raw)) return Boolean(process.env[raw.slice(5, -1)]);
  return true;
}

function jsonable(v) {
  if (v instanceof RegExp) return { $re: v.source, flags: v.flags };
  if (Array.isArray(v)) return v.map(jsonable);
  if (isPlain(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonable(val);
    return out;
  }
  return v;
}

/* ------------------------------ validation -------------------------------- */

const ALLOWED = new Set(Object.keys(DEFAULTS));
const RE_STRING = /^\/(.+)\/([gimsuy]*)$/;

export function toRegex(spec) {
  if (spec instanceof RegExp) return spec;
  if (isPlain(spec) && typeof spec.$re === 'string') {
    try {
      return new RegExp(spec.$re, spec.flags || 'i');
    } catch {
      return null;
    }
  }
  if (!spec) return null;
  const m = RE_STRING.exec(String(spec).trim());
  if (m) {
    try {
      return new RegExp(m[1], m[2]);
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(String(spec).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch {
    return null;
  }
}

export function validatePatch(patch, current) {
  const errors = [];
  if (!isObj(patch)) return [{ path: '', msg: 'the patch must be an object' }];
  for (const key of Object.keys(patch)) {
    if (!ALLOWED.has(key)) errors.push({ path: key, msg: `unknown top-level key. Allowed: ${[...ALLOWED].join(', ')}` });
  }
  /* Dataset section is the only one holding training data, so a typo must not create a control.
     There is deliberately no upload key: MAJIN has no code path that sends anything anywhere. */
  if (isPlain(patch.dataset)) {
    const knownDataset = ['capture', 'dir', 'keepDays', 'include'];
    for (const k of Object.keys(patch.dataset)) {
      if (!knownDataset.includes(k)) errors.push({ path: `dataset.${k}`, msg: `unknown dataset key. Allowed: ${knownDataset.join(', ')} — there is no upload key by design` });
    }
    if (patch.dataset.include && isPlain(patch.dataset.include)) {
      for (const k of Object.keys(patch.dataset.include)) {
        if (!['answer', 'toolArgs', 'plan'].includes(k)) errors.push({ path: `dataset.include.${k}`, msg: 'unknown include key. Allowed: answer, toolArgs, plan' });
      }
    }
  }
  if (isPlain(patch.marketing)) {
    for (const k of Object.keys(patch.marketing)) {
      if (!['meta', 'economics', 'tiktok', 'google'].includes(k)) errors.push({ path: 'marketing.' + k, msg: 'unknown marketing key' });
    }
    if (isPlain(patch.marketing.meta)) {
      for (const k of Object.keys(patch.marketing.meta)) {
        if (!['accountId', 'currency', 'accessToken'].includes(k)) errors.push({ path: 'marketing.meta.' + k, msg: 'unknown Meta setting' });
      }
      const m = patch.marketing.meta;
      if (m.accountId !== undefined && m.accountId !== '' && !/^(act_)?[0-9]{3,25}$/.test(String(m.accountId))) errors.push({ path: 'marketing.meta.accountId', msg: 'enter a Meta ad account ID' });
      if (m.currency !== undefined && m.currency !== '' && !/^[A-Z]{3}$/.test(String(m.currency))) errors.push({ path: 'marketing.meta.currency', msg: 'use an uppercase ISO currency code' });
    }
    for (const platform of ['tiktok','google']) {
      if (!isPlain(patch.marketing[platform])) continue;
      const fields=platform==='tiktok'?['advertiserId','currency','accessToken']:['customerId','currency','accessToken','developerToken','loginCustomerId'];
      for (const [k,v] of Object.entries(patch.marketing[platform])) {
        if (!fields.includes(k)) errors.push({path:'marketing.'+platform+'.'+k,msg:'unknown marketing credential setting'});
        else if (k==='currency' && v!=='' && !/^[A-Z]{3}$/.test(String(v))) errors.push({path:'marketing.'+platform+'.currency',msg:'currency must be 3 uppercase letters'});
        else if (['advertiserId','customerId','loginCustomerId'].includes(k) && v!=='' && !/^[0-9]{3,25}$/.test(String(v))) errors.push({path:'marketing.'+platform+'.'+k,msg:'account ID must be numeric'});
        else if (['accessToken','developerToken'].includes(k) && typeof v!=='string') errors.push({path:'marketing.'+platform+'.'+k,msg:'token must be a string'});
      }
    }
    if (isPlain(patch.marketing.economics)) {
      for (const [k, v] of Object.entries(patch.marketing.economics)) {
        if (!['price','cogs','shipping','fees','refundRate','targetProfit','dailyCap'].includes(k)) errors.push({ path: 'marketing.economics.' + k, msg: 'unknown economics setting' });
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (k === 'refundRate' && v > 1)) errors.push({ path: 'marketing.economics.' + k, msg: 'must be a finite nonnegative number (refundRate 0..1)' });
      }
    }
  }
  const walk = (obj, prefix = '') => {
    if (!isPlain(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (p === 'models.routes' && isObj(v)) {
        for (const [job, ref] of Object.entries(v)) {
          if (!JOBS.includes(job)) errors.push({ path: `${p}.${job}`, msg: `unknown job route. Allowed: ${JOBS.join(', ')}` });
          if (typeof ref !== 'string' || !/^[a-z0-9._-]+\/[^\s]+$/i.test(ref)) errors.push({ path: `${p}.${job}`, msg: `"${ref}" — format provider/model` });
          else if (current && !current.providers[ref.split('/')[0]] && !(isObj(patch.providers) && isObj(patch.providers[ref.split('/')[0]]))) errors.push({ path: `${p}.${job}`, msg: `unknown provider "${ref.split('/')[0]}". Add it to providers first.` });
        }
      }
      if (p === 'providers' && isObj(v)) {
        for (const [name, prov] of Object.entries(v)) {
          /* undefined = explicit DELETE sentinel: the only way to actually
             remove a provider, since merge() deep-merges ordinary objects and
             could otherwise never drop a nested key (see merge()). */
          if (prov === undefined) continue;
          if (!isObj(prov)) errors.push({ path: `${p}.${name}`, msg: `provider "${name}" must be an object (or undefined to remove it)` });
          else {
            const cur = (current && current.providers && current.providers[name]) || {};
            const kind = prov.kind || cur.kind || PRESETS[prov.preset || cur.preset]?.kind || 'openai';
            const base = prov.baseUrl || cur.baseUrl || PRESETS[prov.preset]?.baseUrl || PRESETS[cur.preset]?.baseUrl;
            if (kind !== 'mock' && !base) errors.push({ path: `${p}.${name}.baseUrl`, msg: 'missing baseUrl (or pick a preset that has one)' });
            if (prov.kind && !['openai', 'anthropic', 'gemini', 'mock'].includes(prov.kind)) errors.push({ path: `${p}.${name}.kind`, msg: 'kind: openai | anthropic | gemini | mock' });
            if (prov.preset && !presetNames().includes(prov.preset)) errors.push({ path: `${p}.${name}.preset`, msg: `unknown preset "${prov.preset}" — use one of: ${presetNames().join(', ')}` });
            if (prov.models && !Array.isArray(prov.models)) errors.push({ path: `${p}.${name}.models`, msg: 'models must be an array' });
          }
        }
      }
      if (p === 'moa.references' && Array.isArray(v)) {
        v.forEach((r, i) => {
          if (!isObj(r) || typeof r.model !== 'string') errors.push({ path: `${p}[${i}]`, msg: 'every reference needs model "provider/model"' });
        });
        if (v.length < 2) errors.push({ path: p, msg: 'MOA needs at least 2 references' });
      }
      if (p === 'moa.policy' && !['always', 'hard', 'off'].includes(v)) errors.push({ path: p, msg: 'policy: always | hard | off' });
      if (p === 'guard.mode' && !['confirm', 'off', 'strict'].includes(v)) errors.push({ path: p, msg: 'mode: confirm | strict | off' });
      if (p === 'routing.rules' && Array.isArray(v)) {
        v.forEach((r, i) => {
          if (!isObj(r) || typeof r.match !== 'string' || !r.job) errors.push({ path: `${p}[${i}]`, msg: '{ match, job } required' });
          else {
            if (!toRegex(r.match)) errors.push({ path: `${p}[${i}].match`, msg: 'invalid regex pattern' });
            if (!JOBS.includes(r.job)) errors.push({ path: `${p}[${i}].job`, msg: `unknown job "${r.job}"` });
          }
        });
      }
      if (p === 'server.port' && (typeof v !== 'number' || v < 1 || v > 65535)) errors.push({ path: p, msg: 'port must be 1-65535' });
      if (p === 'channels.telegram.enabled' || p === 'channels.whatsapp.enabled') {
        if (typeof v !== 'boolean') errors.push({ path: p, msg: 'boolean expected' });
      }
      if (p === 'channels.telegram.botToken' && v && !/^\d+:[\w-]{30,}$/.test(String(v))) errors.push({ path: p, msg: 'does not look like a Telegram bot token (123456:ABC-DEF…)' });
      if (p === 'tools.allow' && v !== '*' && !Array.isArray(v)) errors.push({ path: p, msg: 'tools.allow: "*" or an array of tool names' });
      if (isPlain(v)) walk(v, p);
    }
  };
  walk(patch);
  void current;
  return errors;
}

function flattenDiff(base, patch, prefix = '', out = []) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v)) flattenDiff(getPath(base, k) ?? {}, v, p, out);
    else out.push({ path: p, from: getPath(base, k), to: v });
  }
  return out;
}

/* -------------------------------- loader ---------------------------------- */

/** Data stays pure JSON; compiled RegExps live beside it, rebuilt on every change. */
export function compileRuntime(cfg) {
  const data = cfg.data;
  const MODE = { ask: 'confirm', manual: 'confirm', auto: 'off', none: 'off', every: 'strict', all: 'strict', always: 'strict' };
  const want = String(data?.guard?.mode || 'confirm').toLowerCase();
  if (data?.guard) data.guard.mode = MODE[want] || (['confirm', 'strict', 'off'].includes(want) ? want : 'confirm');
  cfg.compiled = {
    rules: (data.routing.rules || [])
      .map((r) => ({ ...r, re: toRegex(r.match) }))
      .filter((r) => r.re && r.job),
    askOn: (data.guard.askOn || []).map(toRegex).filter(Boolean),
    neverOn: (data.guard.neverOn || []).map(toRegex).filter(Boolean),
  };
  return cfg.compiled;
}

export function configFile() {
  if (process.env.MAJIN_CONFIG) return path.resolve(expand(process.env.MAJIN_CONFIG));
  if (process.env.MAJIN_HOME) return path.join(path.resolve(expand(process.env.MAJIN_HOME)), 'config.json');
  if (fs.existsSync(dirs.devConfig)) return dirs.devConfig;
  return dirs.config;
}

export function load() {
  const file = configFile();
  let stored = {};
  let fresh = false;
  let recoveredFrom = null;
  const loadIssues = [];
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e1) {
    /* P0: corrupt is NOT the same as absent. Missing file (ENOENT) → fresh.
       Parse error → try the .bak backup; never auto-save over a file we
       could not read — that would overwrite the user's last working data.
       Every anomaly is left in the open via cfg.loadIssues. */
    if (e1 && e1.code === 'ENOENT') {
      fresh = true;
    } else {
      loadIssues.push({ kind: 'corrupt-main', message: String(e1?.message || e1) });
      try {
        stored = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
        recoveredFrom = 'bak';
        fresh = false;
      } catch (e2) {
        stored = {};
        fresh = false; // still NOT fresh: never auto-save over the corrupt file
        recoveredFrom = null;
        loadIssues.push({ kind: e2 && e2.code === 'ENOENT' ? 'no-backup' : 'corrupt-backup', message: String(e2?.message || e2) });
      }
    }
  }
  const data = expandEnv(merge(clone(DEFAULTS), stored));
  if (!data.server.token) data.server.token = genToken();
  // Env kör före filen: MAJIN_TOKEN/MAJIN_PORT är dokumenterade för planerare,
  // startmaterial och test — utan detta ignoreras de tyst (401 mot ett slumpat uuid).
  if (process.env.MAJIN_TOKEN && String(process.env.MAJIN_TOKEN).trim()) data.server.token = String(process.env.MAJIN_TOKEN).trim();
  if (Number.isFinite(Number(process.env.MAJIN_PORT))) data.server.port = Number(process.env.MAJIN_PORT);
  if (!data.workspace) data.workspace = dirs.workspace;
  const cfg = new Config(data, file);
  compileRuntime(cfg);
  cfg.onChange(() => compileRuntime(cfg));
  cfg.isFresh = fresh;
  if (recoveredFrom) cfg.recoveredFrom = recoveredFrom;
  if (loadIssues.length) cfg.loadIssues = loadIssues;
  if (fresh) cfg.save(); // fresh = no file existed; never auto-save over corrupt

  return cfg;
}

export function genToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export { PRESETS };
