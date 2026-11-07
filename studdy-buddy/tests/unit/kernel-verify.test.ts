import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClaim, blockedVerification, outcomeForClaim, buildHandlers } from '@studdy/agent-core';

/**
 * The verification gate is Omega's rule K ("a lying model is never marked
 * complete") turned into reusable code. Every assertion here exists because a
 * real failure mode was observed: a model saying "done", a file that was never
 * written, a click that was never read back, a screenshot path that does not
 * exist.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-verify-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verification gate', () => {
  it('never marks a bare model statement as verified', () => {
    const result = verifyClaim({ statement: 'I created report.md' }, null);
    expect(result.state).toBe('unverified');
    expect(result.verified).toBe(false);
    expect(result.reasons.join(' ')).toContain('not evidence');

    const noKind = verifyClaim({ statement: 'done' }, { kind: 'none' });
    expect(noKind.state).toBe('unverified');
  });

  it('rejects a narrative where an operation id is required', () => {
    const result = verifyClaim(
      { statement: 'the tool ran' },
      { kind: 'tool-operation', operationId: 'looks like it worked' },
    );
    expect(result.state).toBe('unverified');
    expect(result.verified).toBe(false);

    const real = verifyClaim(
      { statement: 'read a file' },
      { kind: 'tool-operation', operationId: 'kernel-6f1c0a9d2b7e4f8a1c3d5e7f9a0b1c2d3e4f5a6b' },
    );
    expect(real.state).toBe('verified');
    expect(real.verified).toBe(true);
  });

  it('contradicts a claim about a file that does not exist', () => {
    const missing = join(dir, 'never-written.txt');
    const result = verifyClaim(
      { statement: 'wrote the file', expect: { pathExists: missing } },
      { kind: 'file', path: missing },
    );
    expect(result.state).toBe('contradicted');
    expect(result.verified).toBe(false);

    const real = join(dir, 'written.txt');
    writeFileSync(real, 'content');
    const ok = verifyClaim({ statement: 'wrote the file', expect: { pathExists: real } }, { kind: 'file', path: real });
    expect(ok.state).toBe('verified');
    expect(ok.reasons.join(' ')).toContain('File exists on disk');
  });

  it('verifies only a read-back that actually contains the expected text', () => {
    const wrong = verifyClaim(
      { statement: 'typed the note', expect: { readbackContains: 'HELLO-42' } },
      { kind: 'ui-readback', readback: 'HELLO-41' },
    );
    expect(wrong.state).toBe('contradicted');

    const empty = verifyClaim({ statement: 'typed the note' }, { kind: 'ui-readback', readback: '' });
    expect(empty.state).toBe('unverified');

    const right = verifyClaim(
      { statement: 'typed the note', expect: { readbackContains: 'HELLO-42' } },
      { kind: 'ui-readback', readback: 'Untitled - HELLO-42' },
    );
    expect(right.state).toBe('verified');
  });

  it('requires a real status code for HTTP evidence and real output for commands', () => {
    expect(verifyClaim({ statement: 'posted' }, { kind: 'http-response', detail: 'it worked' }).state).toBe('unverified');
    expect(verifyClaim({ statement: 'posted' }, { kind: 'http-response', detail: 'HTTP 201' }).state).toBe('verified');
    expect(verifyClaim({ statement: 'ran' }, { kind: 'command-output', readback: '' }).state).toBe('unverified');
    expect(verifyClaim({ statement: 'ran' }, { kind: 'command-output', readback: 'ok 1 - test' }).state).toBe('verified');
  });

  it('turns an unverified claim into a non-ok kernel outcome', () => {
    const { result, outcome } = outcomeForClaim({ statement: 'finished the job' }, null);
    expect(result.state).toBe('unverified');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.error.code).toBe('VERIFICATION_FAILED');

    const verified = outcomeForClaim(
      { statement: 'ran the probe' },
      { kind: 'tool-operation', operationId: 'kernel-abc123def456abc123def456abc123def456abcd' },
    );
    expect(verified.outcome.ok).toBe(true);
    if (verified.outcome.ok === true) {
      expect(verified.outcome.receipt.kind).toBe('verified-claim');
      expect(verified.outcome.summary).toContain('verified: tool-operation');
    }
  });

  it('reports a blocked verification as blocked, never as a pass', () => {
    const blocked = blockedVerification({ statement: 'typed in Notepad' }, 'No desktop session in this container');
    expect(blocked.state).toBe('blocked');
    expect(blocked.verified).toBe(false);
    expect(blocked.blocked).toBe(true);

    const { outcome } = outcomeForClaim({ statement: 'x' }, null);
    expect(outcome.ok).toBe(false);

    const blockedOutcome = outcomeForClaim({ statement: 'x' }, { kind: 'screenshot', path: '' });
    expect(blockedOutcome.result.state).toBe('unverified');
  });

  it('ships a default handler set that cannot claim success on a missing tool name', async () => {
    const handlers = buildHandlers();
    expect(Object.keys(handlers).sort()).toEqual(['health.delay', 'tool']);
    const tool = handlers.tool!;
    const context = {
      task: {
        schema: 'studdy.kernel.task/v1',
        id: 't1', kind: 'tool', title: 'tool', payload: {}, state: 'RUNNING' as const, priority: 0, deps: [],
        dedupeKey: null, effectKey: null, irreversible: false, attempts: 1, maxAttempts: 1, notBefore: '',
        lease: null, progress: null, lastError: null, blocked: null, result: null, history: [], createdAt: '', updatedAt: '',
      },
      workerId: 'w1', log: null, queue: null as never, heartbeat: null as never,
      progress: async () => {}, callTool: async () => ({}), signal: new AbortController().signal,
      clock: Date.now, limits: { maxTasks: 1, maxRuntimeMs: 1, maxToolCalls: 1, taskTimeoutMs: 1, stallMs: 1, leaseMs: 1, heartbeatIntervalMs: 1, pollMs: 1 },
    };
    const outcome = await tool(context);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('TOOL_NAME_REQUIRED');
  });
});
