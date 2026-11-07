import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCli } from '@studdy/cli';

/**
 * The unified agent, exercised end to end through the real CLI.
 *
 * The *provider* is a local response object (the same technique the existing
 * provider tests use), but everything else is production code: the real AI
 * router, the real durable queue on disk, the real supervisor, the real tool
 * invoker, the real permission gate and the real verification gate.
 *
 * The point of these tests is the honesty contract:
 *  - a plan naming a tool that does not exist is rejected, not executed
 *  - a step whose claim cannot be verified is not reported as achieved
 *  - a direct instruction works without any provider at all
 */

let dir: string;
let out: string[];
let err: string[];
const io = (stdin?: NodeJS.ReadableStream) => ({
  out: (t: string) => out.push(t),
  err: (t: string) => err.push(t),
  color: false,
  ...(stdin ? { stdin } : {}),
});

function planResponse(steps: unknown[]): Response {
  return new Response(JSON.stringify({
    model: 'plan-model',
    usage: { prompt_tokens: 40, completion_tokens: 60 },
    choices: [{
      message: { content: JSON.stringify({ steps }) },
      finish_reason: 'stop',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-agent-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function configureProvider(fetchImpl: typeof fetch): Promise<void> {
  expect(await runCli(['setup'], io(), { dataDir: dir })).toBe(0);
  out = [];
  expect(await runCli(['provider', 'set', 'kilo', '--key-stdin', '--json'], io(Readable.from(['test-key'])), { dataDir: dir, fetchImpl })).toBe(0);
  out = [];
}

describe('unified agent through the CLI', () => {
  it('plans with the model and executes a verified step', async () => {
    const fetchImpl = (async () => planResponse([
      { tool: 'time.now', arguments: {}, claim: 'read the clock', expect: null },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'what time is it right now', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(0);
    const result = JSON.parse(out[0]!) as {
      achieved: boolean;
      plan: { source: string; steps: { tool: string }[] };
      steps: { tool: string; state: string; verified: boolean; operationId: string | null }[];
    };
    expect(result.achieved).toBe(true);
    expect(result.plan.source).toBe('model');
    expect(result.plan.steps[0]?.tool).toBe('time.now');
    expect(result.steps[0]?.state).toBe('COMPLETED');
    expect(result.steps[0]?.verified).toBe(true);
    expect(result.steps[0]?.operationId).toMatch(/^kernel-[a-f0-9]{40}$/);
  });

  it('rejects a hallucinated tool instead of executing it', async () => {
    const fetchImpl = (async () => planResponse([
      { tool: 'os.format_disk', arguments: { disk: 'C:' }, claim: 'wiped the disk' },
      { tool: 'time.now', arguments: {}, claim: 'read the clock' },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'clean up my computer', '--json'], io(), { dataDir: dir, fetchImpl });
    // The remaining real step still runs and is verified; the invented one is gone.
    const result = JSON.parse(out[0]!) as { plan: { note: string | null; steps: { tool: string }[] } };
    expect(result.plan.steps.map((s) => s.tool)).toEqual(['time.now']);
    expect(result.plan.note).toContain('unknown tool: os.format_disk');
    expect(code).toBe(0);

    const events = out.join('');
    expect(events).not.toContain('wiped the disk');
  });

  it('refuses a permission-gated step when the owner never granted the scope', async () => {
    // No `studdy setup` here: the grant really is absent.
    const code = await runCli(['agent', 'run windows.list', '--json'], io(), { dataDir: dir });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]!) as {
      achieved: boolean;
      steps: { state: string; verified: boolean; detail: string }[];
    };
    expect(result.achieved).toBe(false);
    expect(result.steps[0]?.state).toBe('FAILED_FINAL');
    expect(result.steps[0]?.verified).toBe(false);
    expect(result.steps[0]?.detail).toContain('application.observe');
  });

  it('does not claim success when the granted scope still cannot reach the host', async () => {
    const fetchImpl = (async () => planResponse([
      { tool: 'windows.list', arguments: {}, claim: 'list every open window' },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'what windows do I have open', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]!) as {
      achieved: boolean;
      steps: { state: string; verified: boolean; detail: string }[];
    };
    expect(result.achieved).toBe(false);
    expect(result.steps[0]?.verified).toBe(false);
    // Whatever the host says, it must never be reported as completed, and the
    // detail must be the real adapter/host message rather than a generic pass.
    expect(result.steps[0]?.state).not.toBe('COMPLETED');
    expect(result.steps[0]?.detail.length).toBeGreaterThan(0);
  });

  it('contradicts a claim about a file the tool never wrote', async () => {
    const target = join(dir, 'agent-output.txt');
    const fetchImpl = (async () => planResponse([
      { tool: 'time.now', arguments: {}, claim: 'wrote the report', expect: { pathExists: target } },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'write a report to disk', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]!) as { achieved: boolean; steps: { detail: string; verified: boolean }[] };
    expect(result.achieved).toBe(false);
    expect(result.steps[0]?.verified).toBe(false);
    // The tool ran, but the claim is not proven and the report says exactly why.
    expect(result.steps[0]?.detail).toContain('contradicted');
    expect(result.steps[0]?.detail).toContain('does not exist');
  });

  it('verifies a step whose expected file really exists', async () => {
    const target = join(dir, 'real-report.txt');
    writeFileSync(target, 'content written by the test');
    const fetchImpl = (async () => planResponse([
      { tool: 'fs.stat', arguments: { path: target }, claim: 'confirmed the report exists', expect: { pathExists: target } },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'check that the report exists', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(0);
    const result = JSON.parse(out[0]!) as { achieved: boolean; steps: { verified: boolean }[] };
    expect(result.achieved).toBe(true);
    expect(result.steps[0]?.verified).toBe(true);
  });

  it('survives a provider that returns prose instead of a plan', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ message: { content: 'I would rather not.' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await configureProvider(fetchImpl);

    const code = await runCli(['agent', 'do something vague', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]!) as { achieved: boolean; reason: string; plan: { source: string } };
    expect(result.achieved).toBe(false);
    expect(result.plan.source).toBe('deterministic');
  });

  it('runs a direct instruction with no provider configured at all', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return planResponse([]); }) as unknown as typeof fetch;
    const code = await runCli(['agent', 'run time.now', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(0);
    expect(called).toBe(0);
    const result = JSON.parse(out[0]!) as { achieved: boolean; plan: { source: string } };
    expect(result.achieved).toBe(true);
    expect(result.plan.source).toBe('deterministic');
  });

  it('records every step in the durable kernel so status can be audited', async () => {
    const fetchImpl = (async () => planResponse([
      { tool: 'time.now', arguments: {}, claim: 'read the clock' },
    ])) as unknown as typeof fetch;
    await configureProvider(fetchImpl);
    out = [];
    await runCli(['agent', 'what time is it', '--json'], io(), { dataDir: dir, fetchImpl });

    out = [];
    const status = await runCli(['kernel', 'status', '--json'], io(), { dataDir: dir });
    expect(status).toBe(0);
    const report = JSON.parse(out[0]!) as { queue: { byState: Record<string, number> }; workers: unknown[]; activity: string[] };
    expect(report.queue.byState.COMPLETED).toBeGreaterThanOrEqual(1);
    expect(report.workers.length).toBeGreaterThanOrEqual(1);
    expect(report.activity.join('\n')).toContain('Task completed');
  });
});
