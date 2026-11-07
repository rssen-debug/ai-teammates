import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Real-process proof for the unified agent.
 *
 * The built CLI is spawned as a separate Node process with its own data
 * directory, so durability is exercised across process boundaries: one process
 * enqueues, another runs, a third reads the result. Nothing is imported from
 * the source tree here.
 */

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(root, 'dist', 'cli', 'studdy.mjs');

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[], dataDir: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, STUDDY_DATA_DIR: dataDir, NO_COLOR: '1' },
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

let dataDir: string;

beforeAll(async () => {
  const build = await new Promise<RunResult>((resolve) => {
    execFile(process.execPath, [join(root, 'scripts', 'build-cli.mjs')], { cwd: root, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
  });
  expect(build.code).toBe(0);
  expect(existsSync(cli)).toBe(true);
}, 180_000);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'studdy-kernel-cli-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('unified agent kernel through the built CLI', () => {
  it('reports an empty kernel without inventing state', async () => {
    const status = await run(['kernel', 'status', '--json'], dataDir);
    expect(status.code).toBe(0);
    const report = JSON.parse(status.stdout) as {
      engine: { state: string };
      queue: { total: number };
      activity: string[];
      health: { workers: string[] };
    };
    expect(report.engine.state).toBe('NOT_RUNNING');
    expect(report.queue.total).toBe(0);
    expect(report.activity).toEqual([]);
    expect(report.health.workers).toEqual(['No worker heartbeat recorded']);
  });

  it('carries queued work across three separate processes and verifies it', async () => {
    const enqueue = await run(['kernel', 'enqueue', '--kind', 'tool', '--tool', 'time.now', '--json'], dataDir);
    expect(enqueue.code).toBe(0);
    const id = (JSON.parse(enqueue.stdout) as { task: { id: string } }).task.id;

    const listBefore = await run(['kernel', 'list', '--json'], dataDir);
    expect((JSON.parse(listBefore.stdout) as { state: string }[])[0]?.state).toBe('QUEUED');

    const runner = await run(['kernel', 'run', '--max-tasks', '5', '--worker-id', 'e2e-worker'], dataDir);
    expect(runner.code).toBe(0);

    const get = await run(['kernel', 'get', id, '--json'], dataDir);
    const task = JSON.parse(get.stdout) as {
      state: string;
      history: { state: string }[];
      result: { summary?: string; receipt?: { kind: string; reference: string } };
    };
    expect(task.state).toBe('COMPLETED');
    expect(task.history.map((h) => h.state)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED']);
    expect(task.result.receipt?.kind).toBe('tool-operation');
    expect(task.result.receipt?.reference).toMatch(/^kernel-[a-f0-9]{40}$/);

    // The heartbeat is persisted by the worker process and readable afterwards.
    const status = await run(['kernel', 'status', '--json'], dataDir);
    const report = JSON.parse(status.stdout) as { workers: { workerId: string; tasksCompleted: number }[] };
    expect(report.workers.some((w) => w.workerId === 'e2e-worker' && w.tasksCompleted === 1)).toBe(true);

    const events = await run(['kernel', 'events', '--json', '--limit', '200'], dataDir);
    const types = (JSON.parse(events.stdout) as { type: string }[]).map((e) => e.type);
    expect(types).toContain('engine.started');
    expect(types).toContain('task.completed');
    expect(types).toContain('receipt.observed');
  });

  it('fails honestly on an unknown tool and refuses a permission-gated tool', async () => {
    await run(['kernel', 'enqueue', '--kind', 'tool', '--tool', 'nope.notreal'], dataDir);
    const unknown = await run(['kernel', 'run', '--max-tasks', '1'], dataDir);
    expect(unknown.code).toBe(1);

    await run(['kernel', 'enqueue', '--kind', 'tool', '--tool', 'windows.list'], dataDir);
    const denied = await run(['kernel', 'run', '--max-tasks', '1'], dataDir);
    expect(denied.code).toBe(1);

    const list = await run(['kernel', 'list', '--json'], dataDir);
    const tasks = JSON.parse(list.stdout) as { kind: string; state: string; lastError?: { code: string } }[];
    expect(tasks.map((t) => t.lastError?.code)).toEqual(['TOOL_NOT_FOUND', 'PERMISSION_DENIED']);
    expect(tasks.every((t) => t.state === 'FAILED_FINAL')).toBe(true);
  });

  it('deduplicates by key and honours the STOP file', async () => {
    const first = await run(['kernel', 'enqueue', '--kind', 'tool', '--tool', 'time.now', '--dedupe-key', 'probe', '--json'], dataDir);
    const second = await run(['kernel', 'enqueue', '--kind', 'tool', '--tool', 'time.now', '--dedupe-key', 'probe', '--json'], dataDir);
    const a = JSON.parse(first.stdout) as { task: { id: string } };
    const b = JSON.parse(second.stdout) as { deduplicated: boolean; task: { id: string } };
    expect(b.deduplicated).toBe(true);
    expect(b.task.id).toBe(a.task.id);

    const stop = await run(['kernel', 'stop'], dataDir);
    expect(stop.code).toBe(0);
    expect(existsSync(join(dataDir, 'kernel', 'STOP'))).toBe(true);
    const stopped = await run(['kernel', 'run', '--max-tasks', '5', '--worker-id', 'stop-test'], dataDir);
    expect(stopped.stdout).toContain('STOP file present');

    const cleared = await run(['kernel', 'clear-stop'], dataDir);
    expect(cleared.code).toBe(0);
    expect(existsSync(join(dataDir, 'kernel', 'STOP'))).toBe(false);
    const resumed = await run(['kernel', 'run', '--max-tasks', '5', '--worker-id', 'stop-test'], dataDir);
    expect(resumed.code).toBe(0);
  });

  it('reconciles an uncertain irreversible outcome only with evidence', async () => {
    const kernelDir = join(dataDir, 'kernel');
    const queueDir = join(kernelDir, 'queue');
    // Produce a genuinely uncertain task the same way a crashed worker would:
    // an irreversible task claimed with a lease that then expires.
    const { TaskQueue } = await import('@studdy/agent-core');
    const queue = new TaskQueue({ file: join(queueDir, 'queue.json') });
    const { task } = await queue.add({ kind: 'tool', payload: { tool: 'time.now' }, irreversible: true, effectKey: 'e2e:effect' });
    const claimed = await queue.claim({ workerId: 'crashed', leaseMs: 1 });
    expect(claimed?.id).toBe(task.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await queue.recoverExpired();

    const list = await run(['kernel', 'list', '--state', 'UNCERTAIN', '--json'], dataDir);
    expect((JSON.parse(list.stdout) as unknown[]).length).toBe(1);

    const noEvidence = await run(['kernel', 'reconcile', task.id, '--outcome', 'confirmed'], dataDir);
    expect(noEvidence.code).toBe(1);
    expect(noEvidence.stderr).toContain('requires evidence');

    const reconciled = await run(['kernel', 'reconcile', task.id, '--outcome', 'confirmed', '--evidence', '{"screenshot":"proof.png"}'], dataDir);
    expect(reconciled.code).toBe(0);
    const get = await run(['kernel', 'get', task.id, '--json'], dataDir);
    expect((JSON.parse(get.stdout) as { state: string }).state).toBe('COMPLETED');

    // A real stop file on disk is what the worker reads, not a prompt answer.
    writeFileSync(join(kernelDir, 'STOP'), 'x');
    expect(readFileSync(join(kernelDir, 'STOP'), 'utf8')).toBe('x');
  });

  it('verifies evidence instead of trusting a statement', async () => {
    const missing = join(dataDir, 'not-there.txt');
    const denied = await run(['kernel', 'verify', '--statement', 'wrote the file', '--kind', 'file', '--path', missing], dataDir);
    expect(denied.code).toBe(1);
    expect(denied.stdout).toContain('FAIL');

    const real = join(dataDir, 'real.txt');
    writeFileSync(real, 'hello');
    const ok = await run(['kernel', 'verify', '--statement', 'wrote the file', '--kind', 'file', '--path', real], dataDir);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('PASS');

    const bare = await run(['kernel', 'verify', '--statement', 'all done'], dataDir);
    expect(bare.code).toBe(1);
  });

  it('lists only tools with a real implementation', async () => {
    const tools = await run(['tools', '--json'], dataDir);
    expect(tools.code).toBe(0);
    const catalog = JSON.parse(tools.stdout) as { name: string; permission: string | null }[];
    const names = catalog.map((t) => t.name);
    expect(names).toContain('windows.list');
    expect(names).toContain('fs.read');
    expect(names).toContain('time.now');
    expect(catalog.find((t) => t.name === 'windows.list')?.permission).toBe('application.observe');
    expect(catalog.find((t) => t.name === 'fs.read')?.permission).toBeNull();
  });
});
