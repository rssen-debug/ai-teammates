import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLog } from '@studdy/agent-core';
import { runOmegaSelfTest, importOmegaReport, summarizeOmega } from '@studdy/core';

/**
 * The Omega bridge runs the *real* Python suite in a child process and trusts
 * only the JSON report it writes. These tests prove the contract both ways:
 * a genuine suite run is imported faithfully, and a suite that cannot run or
 * cannot report is BLOCKED — never a guessed pass.
 */

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const omegaScript = join(root, 'omega', 'buddy.py');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-omega-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('omega bridge', () => {
  it('runs the real self-test and keeps PASS, BLOCKED and NOT TESTED distinct', async () => {
    const run = await runOmegaSelfTest({ script: omegaScript, timeoutMs: 240_000 });

    if (run.blocked?.code === 'PYTHON_MISSING') {
      // The host has no Python; the bridge must say so rather than invent a pass.
      expect(run.ok).toBe(false);
      expect(run.reported).toBe(false);
      expect(run.summary.total).toBe(0);
      return;
    }

    expect(run.blocked).toBeNull();
    expect(run.reported).toBe(true);
    expect(run.report).not.toBeNull();
    expect(run.summary.total).toBeGreaterThan(10);
    expect(run.summary.pass).toBeGreaterThan(0);
    // No FAIL is allowed to be swallowed.
    expect(run.summary.fail).toBe(0);
    expect(run.ok).toBe(true);

    const byId = new Map(run.report!.results.map((r) => [r.id, r]));
    // The verification-gate check (Omega's rule K) must have really passed.
    expect(byId.get('K')?.status).toBe('PASS');
    expect(byId.get('K')?.detail).toContain('verified_after_readback=True');
    // Windows-only checks are blocked here and must stay blocked.
    expect(byId.get('J1')?.status).toBe('BLOCKED');
    expect(byId.get('D')?.status).toBe('BLOCKED');

    const derived = summarizeOmega(run.report!.results);
    expect(derived.pass + derived.fail + derived.blocked + derived.notTested).toBe(derived.total);
  }, 260_000);

  it('reports BLOCKED when the script does not exist', async () => {
    const run = await runOmegaSelfTest({ script: join(dir, 'nope.py') });
    expect(run.ok).toBe(false);
    expect(run.reported).toBe(false);
    expect(run.blocked?.code).toBe('OMEGA_SCRIPT_MISSING');
  });

  it('reports BLOCKED when python is not available', async () => {
    const run = await runOmegaSelfTest({ script: omegaScript, python: 'python-that-does-not-exist-xyz', timeoutMs: 20_000 });
    expect(run.ok).toBe(false);
    expect(run.reported).toBe(false);
    expect(run.blocked?.code).toBe('PYTHON_MISSING');
  });

  it('reports BLOCKED when a suite runs but writes no report', async () => {
    const fake = join(dir, 'fake_buddy.py');
    writeFileSync(fake, 'import sys\nprint("pretending")\nsys.exit(0)\n');
    const run = await runOmegaSelfTest({ script: fake, timeoutMs: 30_000 });
    expect(run.ok).toBe(false);
    expect(run.reported).toBe(false);
    expect(run.blocked?.code).toBe('OMEGA_NO_REPORT');
  });

  it('imports verdicts into the kernel log without upgrading them', () => {
    const logDir = join(dir, 'events');
    const log = new EventLog(logDir);
    const summary = importOmegaReport(log, {
      when: new Date().toISOString(),
      platform: 'linux',
      results: [
        { id: 'T1', name: 'tool discovery', status: 'PASS', detail: '61 tools registered' },
        { id: 'T2', name: 'vault', status: 'PASS', detail: '' },
        { id: 'J1', name: 'accessibility (real Windows)', status: 'BLOCKED', detail: 'running on linux' },
        { id: 'A', name: 'interactive chatgpt scenario', status: 'NOT TESTED', detail: 'run on Windows' },
        { id: 'X', name: 'broken thing', status: 'FAIL', detail: 'rc=1' },
      ],
    });
    expect(summary).toEqual({ imported: 5, verified: 2, blocked: 2, failed: 1 });

    const events = log.read({ limit: 100 });
    // Only a PASS that carries real detail becomes evidence; a bare PASS does not.
    const verified = events.filter((e) => e.type === 'buddy.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0]?.data.claim).toBe('tool discovery');
    expect(verified[0]?.data.evidenceKind).toBe('command-output');

    const blocked = events.filter((e) => e.type === 'buddy.blocked');
    expect(blocked.map((e) => e.data.code).sort()).toEqual(['OMEGA_BLOCKED', 'OMEGA_NOT_TESTED', 'OMEGA_TEST_FAILED']);
    expect(existsSync(join(logDir, 'events.jsonl'))).toBe(true);
  });
});
