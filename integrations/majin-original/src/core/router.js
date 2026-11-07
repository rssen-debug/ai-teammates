/**
 * MAJIN — router.
 * Decides which job a turn is, which model handles it, and when to escalate.
 * Rules first (user-authored, free), cheap heuristics second, one tiny LLM call
 * as tiebreak only when the two are close. Never blocks a turn.
 */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bus } from './log.js';
import { complete } from './provider/chat.js';

/* Header-byte signatures (raw bytes, ingen endian-förvirring). */
const RE_MAGIC = [
  [[0x4d, 0x5a], 'pe'],
  [[0x7f, 0x45, 0x4c, 0x46], 'elf'],
  [[0xfe, 0xed, 0xfa, 0xce], 'macho'],
  [[0xfe, 0xed, 0xfa, 0xcf], 'macho'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'macho'],
  [[0xce, 0xfa, 0xed, 0xfe], 'macho'],
  [[0xca, 0xfe, 0xba, 0xbe], 'class'],
  [[0x50, 0x4b, 0x03, 0x04], 'zip'],
  [[0x50, 0x4b, 0x05, 0x06], 'zip'],
  [[0x1f, 0x8b], 'gz'],
  [[0x42, 0x5a, 0x68], 'bz2'],
  [[0x25, 0x53, 0x56, 0x47], 'pdf'],
  [[0x4d, 0x53, 0x43, 0x46], 'cab'],
  [[0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01], 'elf'],
];



const JOB_HINTS = [
  { job: 're', weight: 0.75, re: /(ghidra|ida pro|rizin|radare2|r2\b|objdump|frida|x64dbg|disassembl|decompil|unpack|packer|upx\b|shellcode|malware|virus|virusscan|imphash|yara|pe header|imports?\b|section table|firmware|binwalk|reverse|reversing)/i },
  { job: 're', weight: 0.6, re: /\.(exe|dll|ocx|sys|cpl|ax|apk|dex|so|dylib|bin|elf|o|a|lib|pdb|dmp|pcap|cap|ipa|aab|jar|class|wasm|efi|sys$)\b/i },
  { job: 'code', weight: 0.7, re: /(```|\bfunction\b|\bdef \w+\(|=>|import \w|require\(|\basync\b|stack ?trace|exception|traceback|typescript|node|python|npm|git |pytest|compile|build|error\(?TS|\bbugg?\b|krascher|felmedd)/i },
  { job: 'code', weight: 0.45, re: /(^|\n)[ \t]{2,}\S/ },
  { job: 'research', weight: 0.6, re: /(s[oö]k|googl|webb|hitta|research|nyheter|k[aä]llor|vad kostar|priset|j[aä]mf[oö]r (med )?modell|latest|version of|docs)/i },
  { job: 'plan', weight: 0.55, re: /(plan|arkitektur|designa|hur b[oä]r|strategi|v[aä]lj|tradeoff|steg f[oö]r steg|scaffolds?|b[oö]rja|roadmap)/i },
  { job: 'tasks', weight: 0.6, re: /\b(create|write|edit|update|delete|remove|move|copy|rename|make|save|install|run|execute)\b/i },
  { job: 'tasks', weight: 0.5, re: /(fil|mapp|katalog|d[oö]p om|rename|flytta|kopiera|ta bort|rensa|st[aä]da|batch|zip|packa|omorganisera|sortera|backup)/i },
  { job: 'analysis', weight: 0.5, re: /(analysera|rapport|sammanfatt|statistik|m[aä]t|benchmark|logga|json-data|csv|excel)/i },
  { job: 'chat', weight: 0.4, re: /^(tack|okej|ok|ja|nej|jo|nah|hej|hall[aå]|hmm|lol|test)\b[\s.!]*$/i },
];

const ACTION_VERB = /(g[oö]r|skapa|fixa|k[oö]r|lista|vis[ao]|hj[aä]lp|ändra|uppdatera|installera|starta|stänga|öppna|skriv|läs|bygg|testa|paira|koppla|analysera|sök|check)/i;

export function classify(text, opts = {}) {
  const { cfg, attachments = [], history = [] } = opts;
  const t = String(text || '').trim();
  const reasons = [];
  const scores = new Map();
  const bump = (job, w, why) => {
    scores.set(job, (scores.get(job) || 0) + w);
    if (why) reasons.push(why);
  };

  if (!t && !attachments.length) return { job: 'chat', confidence: 0.5, reasons: ['tomt inmatning'], rules: [] };

  for (const r of cfg.rules ? cfg.rules() : []) {
    if (r.re && r.re.test(t)) {
      bump(r.job, 1.4, `regel:${r.id || r.job}`);
      reasons.push(`match: ${r.match}`);
    }
  }
  for (const h of JOB_HINTS) if (h.re.test(t)) bump(h.job, h.weight, `hint:${h.job}`);

  for (const a of attachments) {
    const name = String(a.name || '');
    const kind = String(a.kind || '').toLowerCase();
    const binaryish = ['pe', 'elf', 'macho', 'class', 'zip', 'dex', 'apk', 'cab', 'pcap'].includes(kind) || /x-dosexec|x-pe|vnd\.android\.archive|executable|x-elf|octet-stream$/i.test(kind);
    const extHit = /\.(exe|dll|sys|ocx|scr|cab|msi|apk|jar|class|dex|so|dylib|node|pyd|elf|pe|bin|dat|raw|dmp|pcap|pcapng|a|o|lib|ko|ax|efi)$/i.test(name);
    let magic = null;
    if (a.head) {
      try {
        magic = isBinaryMagic(Buffer.from(a.head, 'base64'));
      } catch {
        magic = null;
      }
    }
    if (binaryish || extHit || magic) bump('re', 2.4, `bilaga:${magic || kind || path.extname(name) || 'bin'}`);
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name) || /^image\//i.test(kind)) bump('vision', 0.8, 'bild');
    if (a.size > 2000000 && !magic && !extHit) bump('analysis', 0.3, 'large attachment');
  }

  const hadToolResult = history.some((m) => m.role === 'tool');
  if (hadToolResult) bump('tools', 0.55, 'verktygssvar i historik');
  if (ACTION_VERB.test(t)) bump('tools', 0.35, 'handlingsverb');
  if (t.length > 900) bump('analysis', 0.25, 'long text');
  if (t.length < 60 && !scores.size) bump('chat', 0.55, 'kort');

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topJob, topScore] = ranked[0] || ['tools', 0.5];
  const runnerUp = ranked[1]?.[1] ?? 0;
  const secondJob = ranked[1]?.[0] || null;
  let confidence = Math.max(0.05, Math.min(1, topScore / (topScore + runnerUp || 1) + (topScore > 1 ? 0.15 : 0)));

  return {
    job: topJob,
    alt: secondJob,
    confidence: Number(confidence.toFixed(2)),
    scores: Object.fromEntries(ranked),
    reasons: reasons.slice(0, 4),
    ambiguous: confidence < (cfg.get('routing.llmTiebreakAbove') ?? 0.45),
    needsLlm: Boolean(cfg.get('routing.llmTiebreak') && cfg.get('routing.auto') !== false && confidence < (cfg.get('routing.llmTiebreakAbove') ?? 0.45) && !ranked.some(([, s]) => s > 1.2)),
  };
}

/** Ask a tiny model to pick the job when heuristics are unsure. Best-effort. */
export async function llmClassify(text, { cfg, candidates = ['code', 're', 'tasks', 'research', 'analysis', 'chat'] }) {
  if (cfg.get('routing.llmTiebreak') === false) return null;
  const route = safeResolve(cfg, 'router');
  if (!route) return null;
  try {
    const res = await complete({
      route,
      job: 'router',
      stream: false,
      maxTokens: 12,
      temperature: 0,
      messages: [
        { role: 'system', content: `Pick exactly one job for the following user turn. Answer with only one of: ${candidates.join(', ')}.` },
        { role: 'user', content: String(text).slice(0, 1200) },
      ],
    });
    const pick = candidates.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(res.text || ''));
    if (pick) bus.debug('router.llm', { pick });
    return pick || null;
  } catch (err) {
    bus.debug('router.llm.skip', { error: err.message });
    return null;
  }
}

// OpenCode Go requires a stable, conversation-specific header. Never send raw
// conversation IDs or expose them to the gateway. Auxiliary routes within the
// same conversation reuse this ID for consistent routing and prompt caching.
const noSessionId = 'ses_' + randomUUID().replaceAll('-', '');
function attachGoSession(route, session) {
  if (route?.providerName !== 'opencode') return route;
  const id = session ? 'ses_' + createHash('sha256').update(String(session)).digest('hex').slice(0, 32) : noSessionId;
  return { ...route, extraHeaders: { ...(route.extraHeaders || {}), 'x-opencode-session': id, 'user-agent': 'MAJIN-coding-agent/1.0' } };
}

/** route ref for a job, with key availability respected. */
export function routeFor(cfg, job, opts = {}) {
  /* P0 (UI-agent handover 2026-10-19): a chat may PIN its own route so a
     provider switch in chat A never reroutes chat B. Session routes live at
     models.sessionRoutes = { <sessionId>: { <job>: "provider/model" } } and
     are an EXPLICIT user choice — no silent fallback when the key is missing;
     the missing-key error surfaces in that chat instead. */
  const session = opts.session ? String(opts.session) : null;
  if (session) {
    const bound = (cfg.get('models.sessionRoutes') || {})[session] || {};
    const bref = bound[job] || bound.tasks;
    if (bref) {
      const r = safeResolve(cfg, job, bref);
      if (r) return attachGoSession(r, session);
      bus.warn('route.session-bad', { session, job, ref: bref, why: 'unresolvable — falling back to the global table' });
    }
  }
  const routes = cfg.get('models.routes') || {};
  const ref = routes[job] || routes.tasks || routes.chat;
  const r = safeResolve(cfg, job, ref);
  if (r && r.apiKey) return attachGoSession(r, session);
  // Explicit OpenCode Go / Zen selection must NEVER silently reroute to
  // DeepSeek or the demo model because its key is missing. Preserve the
  // intended provider so the user sees the correct authentication error.
  // This also covers global (non-session) selections from the model picker.
  if (r && (r.providerName === 'opencode' || r.providerName === 'opencodezen')) return attachGoSession(r, session);
  const fb = fallback(cfg, job);
  if (fb) {
    bus.warn('route.fallback', { job, wanted: ref, used: fb.ref, why: 'no key for the requested provider' });
    return attachGoSession(fb, session);
  }
  return attachGoSession(r, session);
}

function safeResolve(cfg, job, ref) {
  try {
    return cfg.resolveModel(ref, job);
  } catch (err) {
    bus.warn('route.bad', { job, ref, error: err.message });
    return null;
  }
}

function fallback(cfg, job) {
  const order = cfg.get('models.fallbackOrder') || Object.keys(cfg.get('providers') || {});
  for (const name of order) {
    const p = cfg.get(`providers.${name}`);
    if (!p) continue;
    const ready = p.kind === 'mock' || Boolean(p.apiKey);
    if (!ready) continue;
    const model = (p.models || [])[0];
    if (!model) continue;
    const r = safeResolve(cfg, job, `${name}/${model}`);
    if (r) return r;
  }
  return null;
}

/** Which provider/model actually serves this turn, plus escalation state. */
export function plan(cfg, decision, opts = {}) {
  const job = decision.job;
  /* P1: the TURN-level plan must see the same per-chat binding the loop
     does — otherwise the route event, MOA routing and served-route tracking
     all describe a different model than the one actually serving the chat. */
  const route = routeFor(cfg, job, opts);
  const finalRoute = routeFor(cfg, 'final', opts);
  const moa = cfg.moaConfig();
  const useMoa = moa.enabled && (moa.policy === 'always' || moa.hardJobs.includes(job));
  const width = useMoa ? moaWidth(moa, job) : 1;
  return {
    job,
    confidence: decision.confidence,
    route: route ? { ref: route.ref, provider: route.providerName, model: route.model, kind: route.kind } : null,
    finalRef: finalRoute?.ref || null,
    moa: useMoa ? { enabled: true, width, references: moa.references.slice(0, width), aggregator: moa.aggregator } : { enabled: false, width: 0 },
    escalateTo: cfg.get('routing.escalateJob') || 'analysis',
  };
}

function moaWidth(moa, job) {
  if (job === 'chat') return Math.min(2, moa.references.length);
  return Math.max(1, Math.min(moa.width || moa.references.length, moa.references.length));
}

/** Snabb filtyp från huvudet — räcker för att väga jobbvalet, inte för att vara detaljerad. */
export function isBinaryMagic(buf) {
  if (!buf || buf.length < 2) return null;
  for (const [sig, kind] of RE_MAGIC) {
    if (sig.length > buf.length) continue;
    let ok = true;
    for (let i = 0; i < sig.length; i += 1) {
      if (buf[i] !== sig[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return kind;
  }
  return null;
}

export { RE_MAGIC };
