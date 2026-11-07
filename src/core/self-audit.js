/**
 * MAJIN W14 SELF-AUDIT — the system interrogates its own honesty.
 *
 * Rules inspect REAL STATE on disk: mock-mode sessions, unsupported claims
 * in shipped source, unfinished work markers, status-drift and recovery
 * readiness. Each finding is evidence-bearing (file + line + snippet) —
 * never "there seem to be issues". REUSE note: building this on simple
 * regex/line scanning is deliberate; a heavy dependency (semgrep etc) would
 * exceed the causal need and Windows-hygiene profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, dataDir, dirs } from './paths.js';

export const VERSION = 'majin-selfaudit/1';

export const RULES = [
  'unsupported-claims',
  'mock-mode-residue',
  'unfinished-markers',
  'status-drift',
  'recovery-readiness',
];

const CLAIM_RE = /(\b100\/100\b|fully verified|completely safe|human-proof|all bugs fixed|klar med allt)/i; /* deliberately NOT 'never fails': that phrase also appears INSIDE honesty diagnostics (as in re.js) — scanning it yields proof-less noise, which the auditor itself forbids */
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK|WIP:)/;

/* walk a directory tree deterministically (sorted), skipping noise */
function walk(dir, { ext = null, cap = 20000 } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length && out.length < cap) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.git') || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (!ext || ext.includes(path.extname(e.name))) out.push(p);
    }
  }
  return out;
}

function scanLines(file, re, { perFileCap = 20 } = {}) {
  const hits = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return hits; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < perFileCap; i++) {
    if (re.test(lines[i])) hits.push({ file, line: i + 1, snippet: lines[i].trim().slice(0, 140) });
  }
  return hits;
}

export function checkClaims(root = repoRoot) {
  /* unsupported claims in *shipped source* (src/), not policy docs where the
     words appear to forbid them */
  const files = walk(path.join(root, 'src'), { ext: ['.js', '.mjs'] });
  const findings = [];
  for (const f of files) for (const h of scanLines(f, CLAIM_RE)) {
    if (/CLAIM_RE|self-audit|unsupported claim/i.test(h.file) || /audit/i.test(h.file)) continue; // the auditor itself
    if (/test|spec/i.test(h.snippet)) continue;
    findings.push({ rule: 'unsupported-claims', severity: 'high', ...h, why: 'claim words in shipped source must be evidence-backed; this string is not' });
  }
  return findings;
}

export function checkMockResidue(home = dataDir()) {
  const findings = [];
  const candidates = [dirs.sessions, path.join(home, 'state', 'sessions'), path.join(home, 'sessions')];
  const seen = new Set();
  for (const raw of candidates) { if (!seen.has(raw) && fs.existsSync(raw)) seen.add(raw); }
  const roots = [...seen];
  if (!roots.length) return findings;
  for (const sdir of roots)
    for (const f of walk(sdir, { ext: ['.json'] }).slice(0, 500)) {
      if (path.basename(f).includes('audit')) continue; // avoid self-reference loop
      let rows;
      try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const rowsArr = Array.isArray(rows) ? rows : rows?.rows ? rows.rows : rows?.messages ? rows.messages : null;
      if (!rowsArr) continue;
      const mocked = rowsArr.find((r) => r?.meta?.mocked === true || r?.mocked === true);
      if (mocked) findings.push({ rule: 'mock-mode-residue', severity: 'critical', file: f, line: null, snippet: 'session contains rows with mocked:true', why: 'writing mock rows to REAL sessions is the exact behaviour the trust rules forbid — delete or mark the session as known-test' });
      if (/demo-user|unit-test-user/.test(f)) findings.push({ rule: 'mock-mode-residue', severity: 'low', file: f, line: null, snippet: 'known demo/test session file present', why: 'test artefacts in MAJIN_HOME are tolerated but should be purged by reset.plan before shipping' });
    }
  return findings;
}

const SELF_FILES = /self-audit\.js|tools\/audit\.js$/;
export function checkUnfinished(root = repoRoot) {
  const findings = [];
  for (const f of walk(path.join(root, 'src'), { ext: ['.js', '.mjs'] })) {
    if (SELF_FILES.test(f)) continue; // the auditor's own pattern literals are definitions, not debt
    for (const h of scanLines(f, MARKER_RE)) {
      const sev = /HACK|FIXME/.test(h.snippet) ? 'medium' : 'low';
      findings.push({ rule: 'unfinished-markers', severity: sev, ...h, why: 'open debt marker in shipped code' });
    }
  }
  return findings;
}

export function checkStatusDrift(root = repoRoot) {
  const findings = [];
  try {
    const status = fs.readFileSync(path.join(root, 'docs', 'MAJIN_100_STATUS.md'), 'utf8');
    const backlog = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'MAJIN_100_BACKLOG.json'), 'utf8'));
    const shown = Number(status.match(/\*\*(\d+)\/100\*\*/)?.[1]);
    const logged = Number(backlog.roundLog?.at(-1)?.percent);
    if (Number.isFinite(shown) && Number.isFinite(logged) && shown !== logged) {
      findings.push({ rule: 'status-drift', severity: 'medium', file: 'docs/MAJIN_100_STATUS.md', line: null, snippet: `STATUS shows ${shown}/100 but last roundLog entry claims ${logged}/100`, why: 'user-visible progress must equal logged progress, otherwise the status itself is a false claim' });
    }
  } catch (e) {
    findings.push({ rule: 'status-drift', severity: 'low', file: 'docs/MAJIN_100_STATUS.md', line: null, snippet: 'status file unreadable: ' + String(e.message), why: 'a status file that cannot be parsed cannot be verified' });
  }
  return findings;
}

export function checkRecoveryReadiness(plan) {
  /* takes a planRecovery() result — the plan is DRY-RUN only, no side effect */
  const findings = [];
  if (!plan) return findings;
  const stale = (plan.files || []).filter((f) => f.kind === 'stale-flow-state').length;
  if (stale > 0) findings.push({ rule: 'recovery-readiness', severity: 'low', file: 'majin:flows', line: null, snippet: `${stale} stale flow-state file(s) older than 3d (${plan.freedBytes} bytes recoverable overall)`, why: 'dead flow state inflates boot scans; recover with reset.apply when you intend it' });
  return findings;
}

export function runAudit({ root = repoRoot, home = majinRoot(), recoveryPlan = null, scopes = RULES } = {}) {
  const findings = [];
  if (scopes.includes('unsupported-claims')) findings.push(...checkClaims(root));
  if (scopes.includes('mock-mode-residue')) findings.push(...checkMockResidue(home));
  if (scopes.includes('unfinished-markers')) findings.push(...checkUnfinished(root));
  if (scopes.includes('status-drift')) findings.push(...checkStatusDrift(root));
  if (scopes.includes('recovery-readiness')) findings.push(...checkRecoveryReadiness(recoveryPlan));
  const bySev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  return { version: VERSION, scopes, findings, counts: bySev, verdict: bySev.critical || bySev.high ? 'ATTENTION REQUIRED' : findings.length ? 'notes only' : 'clean' };
}

export function renderAudit(report) {
  const head = `self-audit ${report.version} — verdict: ${report.verdict} | critical ${report.counts.critical} high ${report.counts.high} medium ${report.counts.medium} low ${report.counts.low}`;
  const lines = report.findings.slice(0, 25).map((f) => `- [${f.severity}] ${f.rule}: ${f.file}${f.line ? ':' + f.line : ''} — ${f.snippet}\n  why: ${f.why}`);
  const more = report.findings.length > 25 ? `\n… +${report.findings.length - 25} more findings (shown in meta JSON)` : '';
  return `${head}\n${lines.join('\n')}${more}`;
}
