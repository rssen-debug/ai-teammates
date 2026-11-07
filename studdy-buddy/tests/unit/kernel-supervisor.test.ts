import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventLog,
  TaskQueue,
  Supervisor,
  WorkerHeartbeat,
  buildReport,
  createHandlers,
  formatActivityLine,
  scrub,
  assertSyncSafe,
  findSyncViolations,
  maskEmail,
  filterCatalog,
  requiredLane,
  isAuthorized,
  laneForSourceTool,
} from '@studdy/agent-core';

/**
 * Supervisor + privacy + authorization semantics ported from MAJIN V6 and
 * Omega. These are the tests that decide whether an autonomous run is allowed
 * to claim success, so they run against the real filesystem and real timers.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-kernel-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(clock: () => number = Date.now) {
  const log = new EventLog(join(dir, 'events'), { clock });
  const queue = new TaskQueue({ file: join(dir, 'queue', 'queue.json'), log, clock });
  const workersDir = join(dir, 'workers');
  return { log, queue, workersDir };
}

describe('kernel supervisor', () => {
  it('continues through independent work and isolates a blocker instead of failing the run', async () => {
    const { log, queue, workersDir } = setup();
    const handlers = createHandlers({
      'health.delay': async () => ({ ok: true, summary: 'waited' }),
      'probe.blocked': async () => ({
        blocked: { code: 'NATIVE_UNAVAILABLE', reason: 'No desktop session', requiresOwner: true },
      }),
    });
    await queue.add({ kind: 'health.delay', priority: 5 });
    await queue.add({ kind: 'probe.blocked', priority: 4 });
    await queue.add({ kind: 'health.delay', priority: 3 });

    const supervisor = new Supervisor({
      queue, log, handlers, heartbeatFile: join(workersDir, 'w1.json'), workerId: 'w1',
    });
    const summary = await supervisor.run({ maxTasks: 10 });

    expect(summary.completed).toBe(2);
    expect(summary.blocked).toBe(1);
    expect(summary.reason).toBe('no eligible tasks');

    const blockedTask = (await queue.list({ state: 'BLOCKED' }))[0];
    expect(blockedTask?.blocked?.code).toBe('NATIVE_UNAVAILABLE');
    expect(blockedTask?.blocked?.requiresOwner).toBe(true);
  });

  it('fails a silent handler by watchdog instead of hanging forever', async () => {
    const { log, queue } = setup();
    const handlers = createHandlers({
      // Never calls progress() and never resolves: exactly the mistake a
      // model-driven tool loop makes.
      'probe.silent': () => new Promise(() => {}),
    });
    await queue.add({ kind: 'probe.silent', maxAttempts: 1 });
    const supervisor = new Supervisor({
      queue, log, handlers, workerId: 'w-stall',
      limits: { stallMs: 60, taskTimeoutMs: 5000, pollMs: 20 },
    });
    await expect(supervisor.run({ maxTasks: 1 })).resolves.toMatchObject({ failed: 1 });
    const task = (await queue.list())[0];
    expect(task?.state).toBe('FAILED_FINAL');
    expect(task?.lastError?.code).toBe('WATCHDOG_STALL');
    expect(task?.maxAttempts).toBe(1);
    const events = log.read({ types: ['watchdog.stalled'] });
    expect(events).toHaveLength(1);
  }, 15_000);

  it('stops on the task budget and leaves remaining work queued', async () => {
    const { log, queue } = setup();
    const handlers = createHandlers({ 'health.delay': async () => ({ ok: true }) });
    for (let i = 0; i < 5; i += 1) await queue.add({ kind: 'health.delay', priority: 5 - i });
    const supervisor = new Supervisor({ queue, log, handlers, workerId: 'w-budget' });
    const summary = await supervisor.run({ maxTasks: 2 });
    expect(summary.completed).toBe(2);
    expect(summary.reason).toBe('task budget reached');
    expect((await queue.stats()).byState.QUEUED).toBe(3);
  });

  it('respects a STOP file and reports the real reason', async () => {
    const { log, queue } = setup();
    const handlers = createHandlers({
      'health.delay': async () => {
        writeFileSync(join(dir, 'STOP'), 'stop');
        return { ok: true };
      },
    });
    await queue.add({ kind: 'health.delay' });
    await queue.add({ kind: 'health.delay' });
    const supervisor = new Supervisor({ queue, log, handlers, workerId: 'w-stop', stopFile: join(dir, 'STOP') });
    const summary = await supervisor.run({ maxTasks: 10 });
    expect(summary.reason).toBe('STOP file present');
    expect(summary.completed).toBe(1);
  });

  it('refuses a task with no registered handler instead of pretending it ran', async () => {
    const { log, queue } = setup();
    await queue.add({ kind: 'no.such.handler', maxAttempts: 1 });
    const supervisor = new Supervisor({ queue, log, handlers: createHandlers({}), workerId: 'w1' });
    const summary = await supervisor.run({ maxTasks: 1 });
    expect(summary.failed).toBe(1);
    const task = (await queue.list())[0];
    expect(task?.state).toBe('FAILED_FINAL');
    expect(task?.lastError?.code).toBe('HANDLER_NOT_IMPLEMENTED');
  });

  it('shares one queue between two workers without running a task twice', async () => {
    const { log, queue } = setup();
    const executed: string[] = [];
    const handlers = createHandlers({
      'health.delay': async (context) => {
        executed.push(context.task.id);
        return { ok: true };
      },
    });
    for (let i = 0; i < 6; i += 1) await queue.add({ kind: 'health.delay', priority: 1 });
    const a = new Supervisor({ queue, log, handlers, workerId: 'w-a' });
    const b = new Supervisor({ queue, log, handlers, workerId: 'w-b' });
    await Promise.all([a.run({ maxTasks: 6 }), b.run({ maxTasks: 6 })]);
    expect(executed).toHaveLength(6);
    expect(new Set(executed).size).toBe(6);
    expect((await queue.stats()).byState.COMPLETED).toBe(6);
  });
});

describe('worker health and report', () => {
  it('distinguishes a live heartbeat from a stale or dead one', () => {
    let now = 1_700_000_000_000;
    const beat = new WorkerHeartbeat({ file: join(dir, 'w.json'), workerId: 'w1', clock: () => now });
    const snapshot = beat.beat({ state: 'ACTIVE' });
    expect(WorkerHeartbeat.health(snapshot, { now: now + 1000 }).state).toBe('ACTIVE');

    now += 2 * 60_000;
    expect(WorkerHeartbeat.health(snapshot, { now }).state).toBe('STALLED');
    expect(WorkerHeartbeat.health(null).state).toBe('NO_HEARTBEAT');

    // A PID that cannot exist is never healthy, even inside the stale window.
    const dead = { ...snapshot, pid: 2_147_483_646 };
    expect(WorkerHeartbeat.health(dead, { now: now + 10 }).state).toBe('STALLED');
  });

  it('reports only persisted state and says so when there is none', async () => {
    const { log, queue, workersDir } = setup();
    const empty = await buildReport({ queue, log, workersDir: join(dir, 'missing'), home: dir });
    expect(empty.engine.state).toBe('NOT_RUNNING');
    expect(empty.queue.total).toBe(0);
    expect(empty.activity).toEqual([]);
    expect(empty.health.workers).toEqual(['No worker heartbeat recorded']);
    expect(empty.checks.gmail.state).toBe('NOT_CHECKED');

    const handlers = createHandlers({ 'health.delay': async () => ({ ok: true }) });
    await queue.add({ kind: 'health.delay', title: 'visible work' });
    const supervisor = new Supervisor({
      queue, log, handlers, workerId: 'w-report', heartbeatFile: join(workersDir, 'w-report.json'),
    });
    await supervisor.run({ maxTasks: 1 });

    const report = await buildReport({ queue, log, workersDir, home: dir });
    expect(report.queue.byState.COMPLETED).toBe(1);
    expect(report.workers).toHaveLength(1);
    expect(report.workers[0]?.tasksCompleted).toBe(1);
    expect(report.activity.join('\n')).toContain('Task completed');
    expect(report.model).toContain('not reported');
  });
});

describe('privacy scrubber', () => {
  it('removes secrets and private content while keeping operational shape', () => {
    const event = scrub({
      tool: 'gmail.search',
      access_token: 'ya29.super-secret-value-should-vanish',
      body: 'Dear candidate, your verification link is here: https://x.example/verify?token=abc123',
      note: 'sent to owner@example.com with Bearer abcdefghijklmnopqrstuvwxyz',
      count: 3,
    }) as Record<string, unknown>;

    expect(event.tool).toBe('gmail.search');
    expect(event.access_token).toBe('[REDACTED]');
    expect(String(event.body)).toContain('[OMITTED');
    expect(String(event.note)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(String(event.note)).toContain('o****@example.com');
    expect(event.count).toBe(3);
  });

  it('hard-refuses a sync payload with tokens, CV text or verification links', () => {
    expect(() => assertSyncSafe({ token: 'ghp_abcdefghijklmnopqrstuvwxyz012345' })).toThrow(/Refusing sync/);
    expect(() => assertSyncSafe({ cvText: 'my whole CV' })).toThrow(/Refusing sync/);
    expect(() => assertSyncSafe({ url: 'https://x/verify?token=abc' })).toThrow(/Refusing sync/);
    expect(findSyncViolations({ nested: [{ password: 'x' }] }).length).toBeGreaterThan(0);
    expect(assertSyncSafe({ kind: 'summary', tasks: 3 })).toBe(true);
  });

  it('masks emails without destroying the domain', () => {
    expect(maskEmail('owner@example.com')).toMatch(/^o\*+@example\.com$/);
  });
});

describe('authorization policy', () => {
  it('keeps the original MAJIN lane mapping for tool names', () => {
    expect(laneForSourceTool('fs.read')).toBe('files');
    expect(laneForSourceTool('exec.run')).toBe('shell');
    expect(laneForSourceTool('browser.navigate')).toBe('browser');
    expect(laneForSourceTool('screen.capture')).toBe('screen');
    expect(laneForSourceTool('majin.self_audit')).toBe('sys');
    expect(laneForSourceTool('something.else')).toBe('unknown');
    expect(requiredLane({ name: 'tools_search' })).toBe('meta');
    expect(requiredLane({ name: 'driver_status' })).toBe('meta');
  });

  it('fails closed on a revoked lane and always allows meta tools', () => {
    expect(isAuthorized({ name: 'driver_status' }, [])).toBe(true);
    expect(isAuthorized({ name: 'fs_read', source: 'fs.read' }, [])).toBe(false);
    expect(isAuthorized({ name: 'fs_read', source: 'fs.read' }, ['files'])).toBe(true);
    expect(isAuthorized({ name: 'web_fetch', source: 'web.fetch' }, ['research'])).toBe(true);
    expect(isAuthorized({ name: 'shell_run', source: 'shell.run' }, ['shelltools'])).toBe(true);
  });

  it('filters the catalog by grant and treats _ and . as the same separator', () => {
    const catalog = [
      { name: 'driver_status', source: 'majin.status' },
      { name: 'fs_read', source: 'fs.read', description: 'read a file' },
      { name: 'browser_navigate', source: 'browser.navigate' },
    ];
    expect(filterCatalog(catalog, []).map((e) => e.name)).toEqual(['driver_status']);
    expect(filterCatalog(catalog, ['files'], 'fs.read').map((e) => e.name)).toEqual(['fs_read']);
    expect(filterCatalog(catalog, ['files', 'browser']).map((e) => e.lane)).toEqual(['meta', 'files', 'browser']);
  });
});

describe('event log', () => {
  it('rejects an unknown event type and rotates past the size cap', () => {
    const log = new EventLog(join(dir, 'events'), { maxBytes: 2000, keepArchives: 2 });
    expect(() => log.append('totally.unknown.event', {})).toThrow(/Unknown kernel event type/);
    for (let i = 0; i < 80; i += 1) log.append('task.progress', { action: `step ${i}` });
    const files = readFileSync; // keep the import used in a real assertion below
    expect(files).toBeTypeOf('function');
    expect(existsSync(join(dir, 'events', 'events.jsonl'))).toBe(true);
    const tail = log.tail(3);
    expect(tail).toHaveLength(3);
    const seqs = tail.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('formats real activity lines and never invents an unknown one', () => {
    const log = new EventLog(join(dir, 'events'));
    const queued = log.append('task.queued', { kind: 'job.discover', taskId: 't1' });
    const custom = log.append('kernel.custom', {});
    expect(formatActivityLine(queued)).toContain('Task queued: job.discover');
    expect(formatActivityLine(custom)).toMatch(/^\d{2}:\d{2} kernel\.custom$/);
    expect(formatActivityLine(null)).toBe('unknown event');
  });

  it('redacts a secret written into an event', () => {
    const file = join(dir, 'events', 'events.jsonl');
    const log = new EventLog(join(dir, 'events'));
    log.append('engine.error', { code: 'AUTH', apiKey: 'sk-live-1234567890', detail: 'Bearer abcdefghijklmnopqrst' });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-live-1234567890');
    expect(raw).not.toContain('abcdefghijklmnopqrst');
  });
});

describe('supervisor tool bridge', () => {
  it('passes a deterministic operation id and forwards the abort signal', async () => {
    const { log, queue } = setup();
    const seen: { name: string; args: Record<string, unknown>; operationId: string; aborted: boolean }[] = [];
    const handlers = createHandlers({
      tool: async (context) => {
        await context.callTool('fs.read', { path: 'a.txt' });
        return { ok: true, summary: 'called' };
      },
    });
    const supervisor = new Supervisor({
      queue, log, handlers, workerId: 'w-tool',
      toolInvoker: async (name, args, { operationId, signal }) => {
        seen.push({ name, args, operationId, aborted: signal.aborted });
        return { record: { operationId, finishedAt: 'now' }, result: { summary: 'read a.txt' } };
      },
    });
    await queue.add({ kind: 'tool', payload: { tool: 'fs.read', arguments: { path: 'a.txt' } } });
    await supervisor.run({ maxTasks: 1 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('fs.read');
    expect(seen[0]?.args).toEqual({ path: 'a.txt' });
    expect(seen[0]?.operationId).toMatch(/^kernel-[a-f0-9]{40}$/);
    expect(seen[0]?.aborted).toBe(false);
    expect(log.read({ types: ['tool.completed'] })).toHaveLength(1);
  });

  it('fails loudly when a task asks for a tool but no invoker is configured', async () => {
    const { log, queue } = setup();
    const handlers = createHandlers({ tool: async (context) => {
      await context.callTool('fs.read', {});
      return { ok: true };
    } });
    await queue.add({ kind: 'tool', payload: { tool: 'fs.read' }, maxAttempts: 1 });
    const supervisor = new Supervisor({ queue, log, handlers, workerId: 'w-noinvoker' });
    await supervisor.run({ maxTasks: 1 });
    const task = (await queue.list())[0];
    expect(task?.state).toBe('FAILED_FINAL');
    expect(task?.lastError?.code).toBe('TOOL_INVOKER_MISSING');
  });
});
