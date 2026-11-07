/**
 * Omega bridge.
 *
 * Studdy Buddy Omega (`omega/buddy.py`) is a single-file Python companion with
 * its own acceptance suite. Rather than reimplementing that work in TypeScript
 * (which would be a second, unproven copy), this bridge *runs the real suite*
 * and imports its verdicts into the kernel event log.
 *
 * Two rules:
 *  - the child's own JSON report is the source of truth; if it is missing the
 *    bridge reports `BLOCKED`, never a guessed pass;
 *  - BLOCKED and NOT TESTED stay distinct from PASS and from each other, because
 *    "we could not check this here" is not "this works".
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventLog } from '@studdy/agent-core';

export type OmegaStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED';

export interface OmegaResult {
  id: string;
  name: string;
  status: OmegaStatus;
  detail: string;
}

export interface OmegaReport {
  when: string;
  platform: string;
  results: OmegaResult[];
}

export interface OmegaSummary {
  pass: number;
  fail: number;
  blocked: number;
  notTested: number;
  total: number;
}

export interface OmegaRun {
  ok: boolean;
  /** True when the suite actually produced a report file. */
  reported: boolean;
  report: OmegaReport | null;
  summary: OmegaSummary;
  exitCode: number | null;
  /** Set when the suite could not run at all (missing python, timeout, ...). */
  blocked: { code: string; reason: string } | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OmegaRunOptions {
  /** Path to `omega/buddy.py`. */
  script: string;
  python?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const VALID: readonly OmegaStatus[] = ['PASS', 'FAIL', 'BLOCKED', 'NOT TESTED'];

export function summarizeOmega(results: readonly OmegaResult[]): OmegaSummary {
  const count = (status: OmegaStatus): number => results.filter((r) => r.status === status).length;
  return {
    pass: count('PASS'),
    fail: count('FAIL'),
    blocked: count('BLOCKED'),
    notTested: count('NOT TESTED'),
    total: results.length,
  };
}

function parseReport(text: string): OmegaReport | null {
  try {
    const parsed = JSON.parse(text) as { when?: unknown; platform?: unknown; results?: unknown };
    if (!Array.isArray(parsed.results)) return null;
    const results: OmegaResult[] = [];
    for (const entry of parsed.results) {
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.name !== 'string') continue;
      const status = String(record.status ?? '') as OmegaStatus;
      if (!VALID.includes(status)) continue;
      results.push({
        id: record.id,
        name: record.name,
        status,
        detail: typeof record.detail === 'string' ? record.detail : '',
      });
    }
    return {
      when: typeof parsed.when === 'string' ? parsed.when : new Date(0).toISOString(),
      platform: typeof parsed.platform === 'string' ? parsed.platform : 'unknown',
      results,
    };
  } catch {
    return null;
  }
}

/**
 * Runs the real Omega self-test in a child process with an isolated data dir
 * and an explicit report path. Nothing is imported from the Python module; the
 * JSON report it writes is the only contract.
 */
export async function runOmegaSelfTest(options: OmegaRunOptions): Promise<OmegaRun> {
  const started = Date.now();
  const { script, python = process.env.STUDDY_PYTHON ?? 'python3', timeoutMs = 180_000, env = process.env } = options;
  const empty: OmegaSummary = { pass: 0, fail: 0, blocked: 0, notTested: 0, total: 0 };

  if (!existsSync(script)) {
    return {
      ok: false, reported: false, report: null, summary: empty, exitCode: null,
      blocked: { code: 'OMEGA_SCRIPT_MISSING', reason: `Not found: ${script}` },
      stdout: '', stderr: '', durationMs: 0,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'studdy-omega-'));
  // `--self-test` re-launches itself with an isolated home and writes
  // `<home>/last_selftest_report.json` there (see launch_isolated in buddy.py),
  // so the bridge reads the file it actually wrote instead of assuming a path.
  const childHome = join(dir, 'home');
  const reportPath = join(childHome, 'last_selftest_report.json');
  const childEnv = {
    ...env,
    // Keep the suite isolated from the owner's real companion data.
    BUDDY_HOME: childHome,
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
  };

  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; blocked: { code: string; reason: string } | null }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(python, [script, '--self-test'], { env: childEnv, cwd: join(script, '..', '..') });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        code: null, stdout, stderr,
        blocked: { code: 'OMEGA_TIMEOUT', reason: `The Omega suite exceeded ${Math.round(timeoutMs / 1000)}s` },
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 400_000) stdout = stdout.slice(-400_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null, stdout, stderr,
        blocked: error.code === 'ENOENT'
          ? { code: 'PYTHON_MISSING', reason: `Python interpreter not found: ${python}` }
          : { code: 'OMEGA_SPAWN_FAILED', reason: error.message },
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, blocked: null });
    });
  });

  let report: OmegaReport | null = null;
  if (existsSync(reportPath)) {
    try {
      report = parseReport(readFileSync(reportPath, 'utf8'));
    } catch {
      report = null;
    }
  }
  rmSync(dir, { recursive: true, force: true });

  const summary = report ? summarizeOmega(report.results) : empty;
  const blocked = outcome.blocked ?? (report
    ? null
    : { code: 'OMEGA_NO_REPORT', reason: 'The suite ran but wrote no report; its verdicts are unknown' });

  return {
    ok: Boolean(report) && summary.fail === 0 && !blocked,
    reported: report != null,
    report,
    summary,
    exitCode: outcome.code,
    blocked,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: Date.now() - started,
  };
}

export interface ImportSummary {
  imported: number;
  verified: number;
  blocked: number;
  failed: number;
}

/**
 * Records Omega's verdicts in the kernel event log.
 *
 * A PASS that carries real detail is recorded as `buddy.verified` with
 * command-output evidence (the suite's own observed detail), which is the only
 * claim kind the verification gate accepts for this data. Everything else is
 * recorded as its honest status.
 */
export function importOmegaReport(log: EventLog, report: OmegaReport): ImportSummary {
  let imported = 0;
  let verified = 0;
  let blocked = 0;
  let failed = 0;
  for (const result of report.results) {
    imported += 1;
    if (result.status === 'PASS') {
      verified += 1;
      log.append('buddy.probe', { subsystem: result.name, state: 'PASS', probeId: result.id });
      if (result.detail.trim()) {
        log.append('buddy.verified', {
          claim: result.name,
          evidenceKind: 'command-output',
          probeId: result.id,
          readback: result.detail.slice(0, 900),
        });
      }
      continue;
    }
    if (result.status === 'FAIL') {
      failed += 1;
      log.append('buddy.probe', { subsystem: result.name, state: 'FAIL', probeId: result.id });
      log.append('buddy.blocked', {
        code: 'OMEGA_TEST_FAILED',
        reason: `${result.id}: ${result.detail}`.slice(0, 400),
        probeId: result.id,
      });
      continue;
    }
    blocked += 1;
    log.append('buddy.blocked', {
      code: result.status === 'BLOCKED' ? 'OMEGA_BLOCKED' : 'OMEGA_NOT_TESTED',
      reason: `${result.id}: ${result.detail || result.status}`.slice(0, 400),
      probeId: result.id,
    });
  }
  return { imported, verified, blocked, failed };
}
