/**
 * V2 config (sections 40-45): majin.json + majin.local.json override merge.
 * JSON-only loader — deliberate: no .js/.yaml configs means no code execution
 * at config time and no yaml dependency. Precedence: defaults < repo config
 * < local override. Trust gate: config in an untrusted repo can only TIGHTEN
 * safety (never flip a held tier into ok, never widen allowlists).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  schema: 'majin.v2.config/v1',
  approvals: { mode: 'balanced' },
  telemetry: { enabled: true, retainDays: 30 },
  model: { defaultProvider: null, allowModel: true, plannerWithModel: false },
  safety: { trustedRepo: false },
});

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(raw); } catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${err.message}`);
  }
}

/** shallow-trust merge: local wins, nested objects merged one level */
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] != null) {
      out[k] = merge(out[k], v);
    } else out[k] = v;
  }
  return out;
}

/** trust rules: untrusted configs may only tighten (never loosen) */
function enforceTrust(cfg, trusted) {
  if (trusted) return { ...cfg, safety: { ...cfg.safety, trustedRepo: true } };
  const tightened = { ...cfg };
  if (tightened.approvals?.mode === 'hands_off') tightened.approvals = { ...tightened.approvals, mode: 'auto' };
  if (tightened.safety?.trustedRepo === true) tightened.safety = { ...tightened.safety, trustedRepo: false };
  return tightened;
}

/**
 * loadConfig(repoRoot) -> { config, sources: {...}, warnings: [] }
 * sources records where each level came from (honest provenance).
 */
export function loadConfig(repoRoot) {
  if (!repoRoot) throw new Error('loadConfig requires repoRoot');
  const warnings = [];
  const sources = { defaults: true, repo: null, local: null };

  let cfg = DEFAULTS;
  const repoFile = path.join(repoRoot, 'majin.json');
  const r = readJsonSafe(repoFile);
  if (r) { sources.repo = repoFile; const validated = validate(r, warnings); cfg = merge(DEFAULTS, validated); }

  const localFile = path.join(repoRoot, 'majin.local.json');
  const l = readJsonSafe(localFile);
  if (l) { sources.local = localFile; const validated = validate(l, warnings); cfg = merge(cfg, validated); }

  cfg = enforceTrust(cfg, cfg.safety?.trustedRepo === true);
  return { config: cfg, sources, warnings };
}

const VALID_MODES = new Set(['guided', 'balanced', 'auto', 'hands_off']);

/** shallow validation with warnings (never crashes on partially-broken config) */
function validate(raw, warnings) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) { warnings.push('config root must be an object — ignored'); return {}; }
  const out = { ...raw };
  if (out.approvals?.mode && !VALID_MODES.has(out.approvals.mode)) {
    warnings.push(`unknown approvals.mode '${out.approvals.mode}' — ignoring`);
    delete out.approvals;
  }
  if (out.telemetry?.retainDays != null && (!Number.isInteger(out.telemetry.retainDays) || out.telemetry.retainDays < 1 || out.telemetry.retainDays > 365)) {
    warnings.push('telemetry.retainDays out of range [1..365] — ignoring');
    delete out.telemetry;
  }
  return out;
}
