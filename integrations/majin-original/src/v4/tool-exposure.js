/**
 * MAJIN V4 — which tools the model is told about, and how it finds the rest.
 *
 * The first V4 defect was a hardcoded five-tool list. The fix was "send the whole
 * registry". That is correct until the registry is universal: V1 alone carries
 * 139 tools, plus MCP servers, plugins and V4's own. Sending all of them on every
 * request costs tens of thousands of tokens and measurably degrades tool choice.
 *
 * The rule here is reachability, not hiding:
 *
 *   - the core tools are always in the list
 *   - anything the turn activated is in the list
 *   - everything else is in the list too, up to `maxVisible`
 *   - beyond that, `tools_search` finds a tool and `tools_activate` puts it in
 *     the NEXT model round's list
 *
 * A tool is never unreachable, and the model is told (system prompt) that the
 * list can be partial and how to extend it. What we do not do is silently
 * truncate the list and let the model guess.
 */

import { jsonSchemaFor } from './schema.js';
import { modelSchemaOf } from './mcp-tools.js';

/** Always offered: core work tools plus the safe browser/form workflow when granted. */
export const CORE_TOOL_NAMES = Object.freeze([
  'workspace_write',
  'workspace_read',
  'workspace_list',
  'document_read',
  'memory_save',
  'memory_search',
  'tools_search',
  'tools_activate',
  'agent_delegate',
  // Browser tools are often at the tail of the universal host registry. If a
  // user explicitly asks to operate a form, hiding these behind discovery costs
  // model rounds and makes shell/CDP workarounds more likely. The exposure only
  // pins names that are registered (i.e. granted and available on this host).
  'browser_open',
  'browser_read',
  'browser_form',
  'browser_form_fill',
  'browser_verify',
  'browser_click',
]);

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'with', 'you', 'your', 'jag', 'och', 'att', 'det',
  'som', 'den', 'med', 'for', 'till', 'kan', 'ska', 'vill', 'har',
]);

/**
 * Short forms that mean the same thing to a person. Kept deliberately small:
 * a large synonym table turns a deterministic search into a guessing engine.
 */
const ALIAS = Object.freeze({
  system: 'sys',
  systems: 'sys',
  information: 'info',
  details: 'info',
  files: 'file',
  folders: 'folder',
  directories: 'directory',
  commands: 'command',
  processes: 'process',
  screenshots: 'screen',
  screenshot: 'screen',
  pictures: 'image',
  images: 'image',
  execute: 'exec',
  running: 'run',
});

function canonical(token) {
  return ALIAS[token] || token;
}

export function queryTokens(query) {
  // Tool names are snake_case (`sys_info`) while people and models write
  // "system info" or the exact registered name. Normalising both separators
  // means searching for the name a model just saw always finds that tool.
  return String(query || '')
    .toLowerCase()
    .replace(/[_./-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map(canonical);
}

function scoreEntry(entry, tokens, phrase) {
  const nameTokens = String(entry.name || '').toLowerCase().replace(/[_./-]+/g, ' ').split(/\s+/).filter(Boolean);
  const name = nameTokens.join(' ');
  const desc = String(entry.description || '').toLowerCase();
  const lane = String(entry.lane || '').toLowerCase();
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    let hit = false;
    if (nameTokens.includes(token)) {
      score += 8;
      hit = true;
    } else if (name.includes(token)) {
      score += 4;
      hit = true;
    }
    if (lane.includes(token)) {
      score += 2;
      hit = true;
    }
    if (desc.includes(token)) {
      score += 1;
      hit = true;
    }
    if (hit) matched += 1;
  }
  // Covering more of what was asked for beats repeating one word. Without this
  // "system information cpu memory" ranked memory_save above sys_info.
  score += matched * matched * 2;
  if (phrase && phrase.length > 3) {
    if (name.includes(phrase)) score += 6;
    else if (desc.includes(phrase)) score += 3;
  }
  return score;
}

/**
 * Deterministic tool search. No model, no embeddings, no network: the same
 * query always returns the same list, which is what makes it testable and what
 * keeps a search from inventing a capability that does not exist.
 */
export function searchRegistry(registry, query, { limit = 8, exclude = [] } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const drop = new Set(exclude);
  const phrase = tokens.join(' ');
  const hits = [];
  for (const summary of registry.list()) {
    if (drop.has(summary.name)) continue;
    const def = registry.get(summary.name) || summary;
    const entry = { ...summary, lane: def.lane || null };
    const score = scoreEntry(entry, tokens, phrase);
    if (score > 0) hits.push({ ...entry, score });
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, Math.max(1, Number(limit) || 8)).map((h) => ({
    name: h.name,
    description: String(h.description || '').slice(0, 220),
    tier: h.tier || null,
    lane: h.lane || null,
    score: h.score,
  }));
}

/**
 * Per-turn exposure of a live registry.
 *
 * `registry` only has to provide `list()` and `get(name)`; a filtered facade
 * (the subagent's restricted view) works exactly like the real one.
 */
export function createToolExposure({ registry, maxVisible = 64, core = CORE_TOOL_NAMES } = {}) {
  const activated = new Set();

  function orderedNames() {
    const out = [];
    const seen = new Set();
    const push = (name) => {
      if (!name || seen.has(name)) return;
      if (!registry.get(name)) return;
      seen.add(name);
      out.push(name);
    };
    for (const name of core) push(name);
    for (const name of activated) push(name);
    for (const summary of registry.list()) push(summary.name);
    return out;
  }

  function schemaFor(name) {
    const def = registry.get(name);
    if (!def) return null;
    // MCP tools carry their own JSON Schema and must not be re-derived from zod
    // (that produced a second source of truth that drifted from the server).
    // MCP tools carry the server's JSON Schema on their input schema; zod
    // cannot express every MCP construct, so this must win when present.
    const carried = modelSchemaOf(def);
    let parameters = null;
    if (carried) {
      parameters = carried.type === 'object' ? carried : { type: 'object', properties: {} };
    } else {
      parameters = jsonSchemaFor(def.inputSchema);
    }
    if (!parameters) return null;
    return {
      name: def.name,
      description: String(def.description || def.name).slice(0, 400),
      parameters,
    };
  }

  const cache = new Map();

  /**
   * The tool list for the next model call.
   *
   * Core and explicitly activated tools are always included; everything else
   * fills the remaining budget. An activation is the model saying "I need this
   * now", so a small budget must never silently drop it — that would make
   * tools_activate look like it worked while the next call still failed.
   */
  function schemas() {
    const out = [];
    const seen = new Set();
    const mandatory = new Set([
      ...core.filter((n) => registry.get(n)),
      ...activated,
    ]);
    const budget = Math.max(Number.isFinite(maxVisible) && maxVisible > 0 ? maxVisible : 0, mandatory.size);
    for (const name of orderedNames()) {
      if (out.length >= budget) break;
      if (seen.has(name)) continue;
      let entry = cache.get(name);
      if (entry === undefined) {
        entry = schemaFor(name);
        cache.set(name, entry);
      }
      // A tool whose schema cannot be rendered must not consume a slot.
      if (!entry) continue;
      seen.add(name);
      out.push(entry);
    }
    return out;
  }

  /** Names that exist but are not in the current list. */
  function hidden() {
    const visible = new Set(schemas().map((s) => s.name));
    return registry.list().map((s) => s.name).filter((n) => !visible.has(n));
  }

  /**
   * Put tools into the next round's list. Returns what happened to every name —
   * an unknown name is reported, never silently dropped, because the model may
   * have guessed a tool from a V1 name or a typo.
   */
  function activate(names) {
    const wanted = (Array.isArray(names) ? names : [names])
      .map((n) => String(n || '').trim())
      .filter(Boolean);
    const result = { activated: [], already: [], unknown: [], total: 0 };
    const visible = new Set(schemas().map((s) => s.name));
    for (const raw of wanted) {
      const name = raw.includes('.') ? raw.toLowerCase().replace(/[^a-z0-9_]/g, '_') : raw;
      if (!registry.get(name)) {
        result.unknown.push(raw);
        continue;
      }
      if (visible.has(name) && !activated.has(name)) result.already.push(name);
      else if (!activated.has(name)) {
        activated.add(name);
        result.activated.push(name);
      } else result.already.push(name);
    }
    cache.clear();
    result.total = registry.list().length;
    return result;
  }

  function reset() {
    activated.clear();
    cache.clear();
  }

  return { registry, schemas, activate, hidden, reset, activated, maxVisible };
}
