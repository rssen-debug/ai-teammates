/**
 * MAJIN — verktygsregister.
 * Allt på: inga enable/disable-knappar. Varje verktyg har ett riskvärde och
 * guarden avgör om det behöver ett "OK". Resten är bara körning.
 */
import { bus } from '../log.js';
import { check } from '../guard.js';
import { capText } from '../context.js';

export function def({ name, group, desc, params = {}, risk = 'read', examples = [], required = null, run }) {
  const schema = toSchema(params, run);
  if (Array.isArray(required)) {
    schema.required = required.filter((k) => k in params);
    for (const k of Object.keys(params)) if (!schema.required.includes(k)) delete schema.properties[k].const;
  }
  return { name, group, desc, risk, examples, parameters: schema, raw: params, run };
}

/**
 * Vilka parametrar som verkligen krävs: de som saknar default i run()-destrukturen.
 * Ger små modeller en ärlig chans i stället för "saknar parameter"-krig.
 */
export function requiredFromRun(run) {
  const src = typeof run === 'function' ? run.toString() : '';
  const start = src.indexOf('{');
  if (start < 0 || start > 60) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]'.includes(c)) {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const body = src.slice(start + 1, end);
  const out = [];
  for (const part of splitTop(body)) {
    const item = part.trim();
    if (!item || item.includes('...')) continue;
    const eq = topIndex(item, '=');
    const head = (eq >= 0 ? item.slice(0, eq) : item).trim();
    const colon = topIndex(head, ':');
    const key = (colon >= 0 ? head.slice(0, colon) : head).trim().replace(/[[\]]/g, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    if (eq < 0) out.push(key);
  }
  return out;
}

const QUOTE = /['`\\]/;

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let q = null;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (QUOTE.test(c)) {
      q = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    if (')]'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function topIndex(s, ch) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (QUOTE.test(c)) {
      q = c;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    if (')]'.includes(c)) depth -= 1;
    if (depth === 0 && c === ch && s[i + 1] !== '=' && s[i - 1] !== '=') return i;
  }
  return -1;
}

/** Kortfattad schemabeskrivning → riktig JSON Schema. */
export function toSchema(params, run = null) {
  const properties = {};
  const required = [];
  /* BUNDLE-PROOF (R1, real-world audit 2026-10-20): required-ness is derived
     ONLY from the declaration markers (? / (optional) / default: / valfritt…).
     run.toString() survives neither bundling nor native code — the installed
     exe reported nonsense required-lists (shell.run → [], fs.write → append).
     requiredFromRun stays exported for diagnostics/tests of the SOURCE shape
     but is never consulted here. `run` remains an accepted (ignored) argument
     so existing def() calls compile unchanged. */
  void run;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') {
      const m = /^(\w+)(\?)?:\s*(.+?)(?:\s+\[(.+)\])?$/s.exec(v.trim());
      const type = (m?.[1] === 'n' || /count|index/.test(m?.[4] || '') ? 'number' : null) || guess(v);
      properties[k] = { type, description: (m?.[3] || v).trim() };
      if (m?.[4]) properties[k].enum = m[4].split('|').map((x) => x.trim());
      const optional = m?.[2] === '?' || /\?\s*:|\(valfritt\)|\(optional\)|\boptional\b|default:|standard:|endast om|om det anges|valfritt/i.test(v);
      if (!optional) required.push(k);
    } else {
      properties[k] = v;
      if (v.required === true || (v.optional !== true && v.required !== false)) required.push(k);
    }
  }
  return { type: 'object', properties, required: required.filter(Boolean), additionalProperties: false };
}

function guess(desc) {
  if (/\bantal\b|\bbyte\b|\boffset\b|\b(0x)?[0-9a-f]{4,}\b.*hex|index|\bsize\b|\bsekund|\bsida\b|\bfrån\b.*\btil\b/i.test(desc)) return 'number';
  if (/\[\]|lista|array|filnamn\[\]|sökvägar\[\]|strängar\[\]/i.test(desc)) return 'array';
  if (/\bsant\b|\bosant\b|boolean|true\/false|bool/i.test(desc)) return 'boolean';
  if (/\{\}|objekt|json-objekt/i.test(desc)) return 'object';
  return 'string';
}

/*
 * GENESIS OMEGA fas 1 — capability-kontrakt + dynamisk verktygskoppling.
 * Verktygen ÄR redan capabilityn; detta lager märker dem bara maskinläsbart
 * (samma pipeline som list()/schemas() — ingen andra sanningar) och gör
 * träffsärkningen som hittat rätt segment av 100+ verktyg utan ett enda
 * modellanrop. Determiniskt = billigt = GENESIS ZERO:s zero-token-regel.
 */
export const CAP_CONTRACT = 'cap/1';

export const RISK_SIDEEFFECTS = {
  read: 'none',
  write: 'local',
  exec: 'process',
  destructive: 'destructive',
};

export function capabilityTags(t) {
  return [...new Set([t.group, ...String(t.name).split(/[._-]/), ...(t.tags || [])]
    .map((x) => String(x).toLowerCase())
    .filter(Boolean))];
}

export function capabilityOf(t) {
  return {
    contract: CAP_CONTRACT,
    id: t.name,
    group: t.group,
    desc: t.desc,
    sideEffects: RISK_SIDEEFFECTS[t.risk] || 'none',
    tags: capabilityTags(t),
    inputs: t.parameters,
  };
}

/* Tokeniserar både punkt-separerade namn och löptext — engelska i kärnan,
   svenska accenttecken tillåts så frågan kan låta som användaren låter. */
const TOKENS = /[a-z0-9åäöéü]+/g;

export function capabilityScore(t, tokens) {
  const tags = capabilityTags(t);
  const nameSegs = tags.slice(1);
  const group = String(t.group).toLowerCase();
  const nameText = String(t.name).toLowerCase();
  const descText = String(t.desc).toLowerCase();
  let named = 0, desc = 0;
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    /* namn/tag/grupp är "seed"-träffar: en description-stava aldrig ensam
       fram ett verktyg (annars drunknar träfflistan i löst prat) */
    if (nameSegs.includes(tok)) named += 6;
    else if (nameSegs.some((seg) => (seg.length >= 5 && tok.length >= 5 && seg.slice(0, 5) === tok.slice(0, 5)) || (seg.length >= 4 && tok.length >= 4 && (seg.startsWith(tok) || tok.startsWith(seg))))) named += 3;
    if (tags.includes(tok)) named += 4;
    if (group === tok) named += 3;
    if (new RegExp(`(^|[^a-z])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(descText)) desc += 1;
  }
  if (tokens.join(' ') && tokens.join(' ').length >= 5 && nameText.includes(tokens.join(' '))) named += 10;
  if (named === 0) return 0;
  return named + desc;
}

export class Registry {
  constructor(tools, ctx) {
    this.ctx = ctx;
    this.tools = tools;
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  get allow() {
    const a = this.ctx.cfg.get('tools.allow');
    return a === '*' || !Array.isArray(a) ? null : a;
  }

  /**
   * readOnly är för bakgrundsturer: en schemalagd uppgift som bara ska titta kan också
   * vägras skriva, så att ett löpande jobb aldrig ändrar något ingen godkänt.
   */
  visible({ readOnly = false } = {}) {
    const allow = this.allow;
    let out = allow ? this.tools.filter((t) => allow.includes(t.name) || allow.includes(t.group)) : this.tools;
    if (readOnly) out = out.filter((t) => t.risk === 'read');
    return out;
  }

  schemas(opts = {}) {
    return this.visible(opts).map((t) => ({ name: t.name, description: `${t.desc}${t.examples.length ? `  Example: ${t.examples.join(' | ')}` : ''}`, parameters: t.parameters }));
  }

  list(opts = {}) {
    return this.visible(opts).map((t) => ({ name: t.name, group: t.group, risk: t.risk, desc: t.desc }));
  }

  groups(opts = {}) {
    const out = {};
    for (const t of this.visible(opts)) (out[t.group] ||= []).push({ name: t.name, risk: t.risk, desc: t.desc });
    return out;
  }

  has(name) {
    return this.byName.has(name);
  }

  register(tool) {
    if (!tool?.name || this.byName.has(tool.name)) throw new Error(`tool already exists or has no name: ${tool?.name || '(missing)'}`);
    this.tools.push(tool);
    this.byName.set(tool.name, tool);
    return tool;
  }

  unregister(name) {
    const tool = this.byName.get(name);
    if (!tool) return false;
    this.byName.delete(name);
    this.tools = this.tools.filter((item) => item.name !== name);
    return true;
  }

  /** Typade kontrakt för allt som är synligt i just denna yta. */
  capabilities(opts = {}) {
    return this.visible(opts).map(capabilityOf);
  }

  /*
   * Dynamisk verktygsplockning ("dynamic tool retrieval"): den generella sökvägen
   * in i hela kapacitetsregistret. Deterministisk = noll tokens, samma ranking
   * varje gång (bevisbart i test). Återlämnar manifests + score, inget annat.
   */
  search(q, { limit = 6, readOnly = false } = {}) {
    const tokens = String(q || '').toLowerCase().match(TOKENS) || [];
    if (!tokens.length) return [];
    const out = [];
    for (const t of this.visible({ readOnly })) {
      const score = capabilityScore(t, tokens);
      if (score > 0) out.push({ ...capabilityOf(t), score });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, Math.max(1, Number(limit) || 6));
  }

  async exec(name, args = {}, { session = 'desktop', step = 0, readOnly = false } = {}) {
    const t = this.byName.get(name);
    if (!t) {
      const near = fuzzy(name, [...this.byName.keys()])[0];
      return { ok: false, tool: name, error: { code: 'unknown_tool', message: `tool "${name}" does not exist`, hint: near ? `did you mean ${near}?` : `available: ${[...this.byName.keys()].slice(0, 12).join(', ')}…` } };
    }
    if (readOnly && t.risk !== 'read')
      return { ok: false, tool: name, error: { code: 'read_only', message: `this turn is read-only, so ${name} is refused`, hint: 'the job was scheduled with readOnly:true — set readOnly:false on the job to let it write' } };
    const parsed = coerce(t, args);
    if (parsed.error) return { ok: false, tool: name, error: { code: 'bad_args', message: parsed.error, hint: `parameters: ${Object.keys(t.raw).join(', ')}` } };
    const verdict = await check(name, parsed.args, this.ctx.cfg, { session, defRisk: t.risk, timeoutMs: this.ctx.cfg.get('tasks.approvalTimeoutMs') || 0 });
    if (verdict.wait) {
      const decision = await verdict.wait;
      if (!decision?.approved) {
        bus.warn('tool.denied', { tool: name, session, why: decision?.why || 'declined by the user' });
        return { ok: false, tool: name, error: { code: 'denied', message: `the user said no: ${decision?.note || decision?.why || 'no explanation'}`, hint: 'ask for an exception, or have the user approve in the window' }, denied: true };
      }
      bus.info('tool.approved', { tool: name, approvalId: verdict.id });
    } else if (!verdict.run) {
      return { ok: false, tool: name, error: { code: 'blocked', message: verdict.why, hint: 'guard.neverOn / askOn i config' }, denied: true };
    }

    const t0 = Date.now();
    this.ctx.emit?.({ type: 'tool:start', tool: name, step, args: preview(parsed.args) });
    try {
      // Bridge the per-session plan setter so tools never see the runtime's 3-arg shape.
      const setPlan = this.ctx.setPlan ? (plan, note) => this.ctx.setPlan(session, plan, note) : this.ctx.setPlan;
      const getPlan = this.ctx.getPlan ? () => this.ctx.getPlan(session) : () => this.ctx.plan || [];
      const out = await t.run(parsed.args, { ...this.ctx, session, step, emit: this.ctx.emit, setPlan, getPlan });
      const res = normalize(out);
      const cap = this.ctx.cfg.get('tools.maxOutputChars') || 12000;
      const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? res, null, 1);
      const capped = capText(text, cap);
      this.ctx.emit?.({ type: 'tool:done', tool: name, step, ms: Date.now() - t0, ok: res.ok !== false, bytes: text.length, clipped: capped.clipped, summary: firstLine(res.summary || capped.text) });
      bus.info('tool.done', { tool: name, ms: Date.now() - t0, chars: text.length });
      return {
        ok: res.ok !== false,
        tool: name,
        result: capped.text,
        spilled: capped.spilled || null,
        meta: res.meta || null,
        ms: Date.now() - t0,
        ...(res.ok === false && res.error ? { error: typeof res.error === 'string' ? { code: 'tool_error', message: res.error } : res.error } : {}),
      };
    } catch (err) {
      const e = { code: err.code || 'tool_error', message: err.message || String(err), hint: err.hint || null };
      this.ctx.emit?.({ type: 'tool:error', tool: name, step, ms: Date.now() - t0, error: e.message });
      bus.warn('tool.error', { tool: name, error: e.message, code: e.code });
      return { ok: false, tool: name, error: e };
    }
  }
}

function normalize(out) {
  if (out && typeof out === 'object' && ('result' in out || 'ok' in out || 'error' in out)) return out;
  return { ok: true, result: out };
}

function firstLine(s) {
  return String(s || '').replace(/\s+/g, ' ').slice(0, 160);
}

function preview(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 200)}…`;
    else if (Array.isArray(v) && v.length > 8) out[k] = [...v.slice(0, 8), `+${v.length - 8}`];
    else out[k] = v;
  }
  return out;
}

const NUMISH = /^\s*-?\d+(\.\d+)?\s*$/;
const BOOLISH = /^(true|false|yes|no|ja|nej)$/i;

/** Små modeller skickar "3" istället för 3. Reparer tyst, kasta aldrig. */
function coerce(tool, args) {
  const out = {};
  const props = tool.parameters.properties || {};
  for (const [k, v] of Object.entries(args || {})) {
    if (!props[k]) {
      if (/^(confirm|yes)$/i.test(k)) continue;
      out[k] = v;
      continue;
    }
    const want = props[k].type;
    if (v == null) continue;
    if (want === 'number' && typeof v !== 'number') {
      const n = Number(String(v).replace(/[,_\s]/g, ''));
      if (Number.isFinite(n)) out[k] = n;
      else if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v.trim())) out[k] = parseInt(v.trim(), 16);
      else return { error: `${k} must be a number, got "${String(v).slice(0, 40)}"` };
    } else if (want === 'integer' && typeof v !== 'number') {
      const n = parseInt(String(v), 10);
      if (Number.isFinite(n)) out[k] = n;
      else return { error: `${k} must be an integer` };
    } else if (want === 'boolean' && typeof v !== 'boolean') {
      if (BOOLISH.test(String(v))) out[k] = /^(true|yes|ja|1)$/i.test(String(v));
      else out[k] = Boolean(v);
    } else if (want === 'array' && !Array.isArray(v)) {
      out[k] = typeof v === 'string' ? (NUMISH.test(v) ? [Number(v)] : v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)) : [v];
    } else if (want === 'string' && typeof v !== 'string') {
      out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    } else if (want === 'object' && typeof v !== 'object') {
      try {
        out[k] = JSON.parse(String(v));
      } catch {
        out[k] = { value: v };
      }
    } else out[k] = v;
  }
  for (const [k, spec] of Object.entries(tool.raw || {})) {
    if (out[k] === undefined && typeof spec === 'object' && spec.default !== undefined) out[k] = spec.default;
  }
  const missing = (tool.parameters.required || []).filter((k) => out[k] === undefined || out[k] === '');
  if (missing.length) return { error: `missing parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` };
  return { args: out };
}

export function fuzzy(needle, list) {
  const n = String(needle).toLowerCase();
  const scored = list
    .map((c) => {
      const s = c.toLowerCase();
      let score = 0;
      if (s.includes(n) || n.includes(s)) score += 40;
      for (const ch of new Set(n)) if (s.includes(ch)) score += 1;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 4).map((x) => x.c);
}
