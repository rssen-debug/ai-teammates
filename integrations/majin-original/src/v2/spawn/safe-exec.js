/**
 * SAFE EXEC — the one and only way V2 runs operator-supplied command templates.
 *
 * History lesson (why this exists): a shell `exec(template)` with
 * JSON.stringify quoting is NOT safe — the shell still expands $(...) / $VAR
 * inside double quotes. Any adapter text containing `$` would have been
 * evaluated. This module removes the shell from the loop entirely.
 *
 * Hard rules, enforced here (not documented):
 *  1. NEVER a shell — tokenize the template ourselves, spawn argv-style.
 *  2. Shell control operators (&& || ; | < > ` $( ) [unquoted]) in the
 *     TEMPLATE are refused: they express shell semantics we do not provide.
 *     Refusal class SAFE_REFUSED with the offending token in the reason.
 *  3. Placeholders {NAME} substitute as ARGV DATA — literal bytes, never
 *     re-parsed, never re-interpreted. Proven by the echo fixture test.
 *  4. env passed to the child is a SCRUBBED allowlist (PATH, SystemRoot, HOME,
 *     TEMP, TMP, LANG, LC_x, NO_COLOR, TERM) — names ending _KEY, _TOKEN,
 *     _SECRET, _PASSWORD or _CREDENTIAL never cross the boundary.
 *  5. timeout is mandatory (default 30s, hard ceiling 120s) → TIMEOUT error
 *     with elapsed evidence; output capped at maxBuffer, overflow reported
 *     honestly via truncated:true (no silent loss).
 */
import { execFile } from 'node:child_process';

const ENV_ALLOW = [/^PATH$/, /^SystemRoot$/, /^windir$/, /^SystemDrive$/, /^HOME$/, /^USERPROFILE$/, /^TEMP$/, /^TMP$/, /^TMPDIR$/, /^LANG$/, /^LC_/, /^NO_COLOR$/, /^TERM$/];
const ENV_DENY = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)$/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export class SafeExecError extends Error {
  constructor(cls, message, extra = {}) { super(message); this.cls = cls; Object.assign(this, extra); }
}

/** tokenize a template into argv segments; throws SafeExecError SAFE_REFUSED on control tokens */
export function tokenize(template) {
  const out = [];
  let cur = '';
  let quote = null; // null | "'" | '"'
  let has = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) { quote = null; } else { cur += ch; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    if (ch === '\\' && i + 1 < template.length) { cur += template[++i]; has = true; continue; }
    // control operators are refused AT SCAN TIME so quoted text stays pure data
    const two = ch + (template[i + 1] ?? '');
    if (two === '&&' || two === '||' || two === '$(' || two === '${') {
      throw new SafeExecError('SAFE_REFUSED', `shell control operator "${two}" refused — safe-exec provides argv semantics, not a shell (split the pipeline, or ask for a native lane)`);
    }
    if (ch === ';' || ch === '|' || ch === '<' || ch === '>' || ch === '`') {
      throw new SafeExecError('SAFE_REFUSED', `shell control operator "${ch}" refused — safe-exec provides argv semantics, not a shell (split the pipeline, or ask for a native lane)`);
    }
    cur += ch; has = true;
  }
  if (quote) throw new SafeExecError('SAFE_REFUSED', `unterminated ${quote} quote in command template`);
  if (has || cur) out.push(cur);
  if (out.length === 0) throw new SafeExecError('SAFE_REFUSED', 'empty command template');
  return out;
}

/** substitute {NAME} placeholders (argv-data semantics); unknown placeholders refused explicitly */
export function substitute(argv, map) {
  return argv.map((seg) => seg.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (m, name) => {
    if (!(name in map)) throw new SafeExecError('SAFE_REFUSED', `unknown placeholder {${name}} — refusing rather than guessing`);
    return String(map[name]);
  }));
}

export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_DENY.test(k)) continue;
    if (ENV_ALLOW.some((re) => re.test(k))) out[k] = v;
  }
  return out;
}

/**
 * runSafe(template, map, opts): → { code, stdout, stderr, truncated, elapsedMs, argv }
 * errors: SafeExecError SAFE_REFUSED | TIMEOUT | SPAWN | EXIT (with code+stderr evidence)
 */
export function runSafe(template, map = {}, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  cwd = undefined,
  execImpl = execFile,
  env = process.env,
  input = null,
} = {}) {
  const argv = substitute(tokenize(template), map);
  const budget = Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execImpl(argv[0], argv.slice(1), {
      timeout: budget, maxBuffer, cwd, windowsHide: true, env: scrubEnv(env),
    }, (err, stdout, stderr) => {
      const elapsedMs = Date.now() - started;
      const truncated = !!(err && /maxBuffer/i.test(String(err.message)));
      if (err && (err.killed || err.signal === 'SIGTERM') && elapsedMs >= budget) {
        return reject(new SafeExecError('TIMEOUT', `killed after ${elapsedMs}ms (budget ${budgetMs(budget)}ms) — no silent hang, no partial OK`, { elapsedMs, argv }));
      }
      if (err && err.code === 'ENOENT') {
        return reject(new SafeExecError('SPAWN', `executable not found: ${argv[0]} (dependency missing — install it or gate the lane)`, { argv }));
      }
      if (err && !truncated) {
        return reject(new SafeExecError('EXIT', `exit code ${err.code ?? 'unknown'} — ${String(stderr).slice(0, 300) || err.message}`, { code: err.code, stderr: String(stderr), elapsedMs, argv }));
      }
      resolve({ code: err ? (err.code ?? null) : 0, stdout: String(stdout), stderr: String(stderr), truncated, elapsedMs, argv });
    });
  });
}
function budgetMs(b) { return b; }
