import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '@studdy/database';
import {
  PermissionGate,
  ProactiveGovernor,
  PROACTIVE_DEFAULTS,
  assembleContext,
  AgentLoop,
  PerceptionScheduler,
  buildResumeSummary,
  type AgentTaskHandler,
} from '@studdy/agent-core';
import { LearningService } from '@studdy/learning-engine';

describe('permission gate', () => {
  let db: Database;
  let gate: PermissionGate;
  beforeEach(() => {
    db = openDatabase(':memory:');
    gate = new PermissionGate(db);
  });
  afterEach(() => db.close());

  it('denies everything by default', () => {
    expect(gate.isGranted('screen.capture')).toBe(false);
    expect(gate.check('observe', ['screen.capture']).allowed).toBe(false);
    expect(gate.currentMode()).toBe('OBSERVE_ONLY');
  });

  it('allows observation once granted', () => {
    gate.grant('application.observe');
    expect(gate.check('observe', ['application.observe']).allowed).toBe(true);
  });

  it('requires VISUAL_GUIDE mode for highlights', () => {
    gate.grant('application.observe');
    expect(gate.check('guide', ['application.observe']).allowed).toBe(false);
    gate.setMode('VISUAL_GUIDE');
    expect(gate.check('guide', ['application.observe']).allowed).toBe(true);
  });

  it('never allows actions in OBSERVE_ONLY or VISUAL_GUIDE mode even with the grant', () => {
    gate.grant('computer.actions');
    expect(gate.check('act', []).allowed).toBe(false);
    gate.setMode('VISUAL_GUIDE');
    expect(gate.check('act', []).allowed).toBe(false);
    gate.setMode('APPROVED_ACTION');
    expect(gate.check('act', []).allowed).toBe(true);
  });

  it('revoking takes effect immediately', () => {
    gate.grant('microphone');
    expect(gate.isGranted('microphone')).toBe(true);
    gate.revoke('microphone');
    expect(gate.isGranted('microphone')).toBe(false);
  });

  it('persists grants across a reopen supplied by the same db', () => {
    gate.grant('browser.read');
    const fresh = new PermissionGate(db);
    expect(fresh.isGranted('browser.read')).toBe(true);
  });
});

describe('proactive governor', () => {
  it('never interrupts graded work', () => {
    const gov = new ProactiveGovernor(() => 0);
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.NORMAL, 0.99, 'GRADED_QUIZ').allowed).toBe(false);
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.NORMAL, 0.99, 'FORMAL_EXAM').allowed).toBe(false);
  });

  it('respects the cooldown', () => {
    let now = 1_000_000;
    const gov = new ProactiveGovernor(() => now);
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.QUIET, 0.9, 'SELF_STUDY').allowed).toBe(true);
    gov.markSuggested();
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.QUIET, 0.9, 'SELF_STUDY').allowed).toBe(false);
    now += PROACTIVE_DEFAULTS.QUIET.cooldownMs + 1;
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.QUIET, 0.9, 'SELF_STUDY').allowed).toBe(true);
  });

  it('is off in OFF mode and rejects weak relevance', () => {
    const gov = new ProactiveGovernor(() => 0);
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.OFF, 1, 'SELF_STUDY').allowed).toBe(false);
    expect(gov.maySuggest(PROACTIVE_DEFAULTS.QUIET, 0.2, 'SELF_STUDY').allowed).toBe(false);
  });
});

describe('context assembly', () => {
  it('includes labelled facts from the observed page', () => {
    const ctx = assembleContext({
      page: {
        url: 'https://netacad.com/module/3',
        courseName: 'CCNA ITN',
        headingPath: ['Module 3', '3.2 Network Protocols'],
        currentNodeId: null,
        platformCompletedVisible: false,
        detectedAt: '2026-01-01T00:00:00Z',
      },
      selection: 'ARP is used to resolve IPv4 addresses to MAC addresses.',
    });
    expect(ctx.facts.join(' ')).toContain('CCNA ITN');
    expect(ctx.facts.join(' ')).toContain('Markerad text');
    expect(ctx.conceptHints).toContain('arp');
  });

  it('excludes non-approved windows and says so', () => {
    const ctx = assembleContext({
      windows: [
        { id: 'w1', title: 'Steam', processName: 'steam.exe', appKind: 'OTHER', bounds: { x: 0, y: 0, width: 1, height: 1 }, displayId: null, minimized: false },
      ],
    });
    expect(ctx.facts.join(' ')).not.toContain('Steam');
    expect(ctx.excluded.join(' ')).toMatch(/uteslöts/);
  });

  it('states the absence of observed topology instead of implying knowledge', () => {
    const ctx = assembleContext({
      topology: { capturedAt: '2026-01-01T00:00:00Z', devices: [], cliOutputs: [], limitations: ['Paketfönstret var minimerat.'] },
    });
    expect(ctx.facts.join(' ')).toMatch(/ingen topologi kunde läsas/);
    expect(ctx.facts.join(' ')).toContain('Paketfönstret var minimerat');
  });

  it('never equates a selected answer with correctness', () => {
    const ctx = assembleContext({
      question: {
        id: 'q1',
        questionText: 'Which layer uses MAC?',
        options: [{ label: 'A', text: 'Layer 2' }],
        questionType: 'MULTIPLE_CHOICE',
        officialCorrectness: null,
        selected: ['A'],
        feedbackVisible: false,
        mode: 'PRACTICE',
        conceptId: null,
      },
    });
    const text = ctx.facts.join(' ');
    expect(text).toMatch(/Ingen officiell rätt\/fel-markering/);
    expect(text).not.toMatch(/svaret är rätt/);
  });

  it('caps the number of facts', () => {
    const ctx = assembleContext({
      page: {
        url: 'x'.repeat(300),
        courseName: 'C',
        headingPath: Array.from({ length: 30 }, (_, i) => `H${i}`),
        currentNodeId: null,
        platformCompletedVisible: null,
        detectedAt: 'now',
      },
      knowledge: Array.from({ length: 20 }, (_, i) => `k${i}`),
    });
    expect(ctx.facts.length).toBeLessThanOrEqual(14);
    expect(ctx.knowledge.length).toBeLessThanOrEqual(8);
  });
});

describe('agent loop', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('runs a registered handler and marks the task done', async () => {
    let ran = 0;
    const handler: AgentTaskHandler = {
      kind: 'OBSERVE_WINDOWS',
      run: async () => {
        ran += 1;
        return 'observed 2 windows';
      },
    };
    const loop = new AgentLoop({ db, handlers: [handler] });
    loop.enqueue('OBSERVE_WINDOWS', {});
    const report = await loop.tick();
    expect(ran).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(db.tasks.counts().DONE).toBe(1);
  });

  it('retries with backoff and records the error', async () => {
    const handler: AgentTaskHandler = {
      kind: 'CAPTURE_SCREEN',
      run: async () => {
        throw new Error('capture failed');
      },
    };
    // The durable queue stores wall-clock timestamps, so the loop must use the
    // real clock here for the backoff window to be meaningful.
    const loop = new AgentLoop({ db, handlers: [handler] });
    const id = loop.enqueue('CAPTURE_SCREEN', {});
    const report = await loop.tick();
    expect(report.failed).toBe(1);
    const counts = db.tasks.counts();
    expect(counts.FAILED).toBe(1);
    // Not immediately retryable: available_at is in the future.
    expect(db.tasks.claim()).toHaveLength(0);
    expect(id).toBeTruthy();
  });

  it('does not spin forever on a task with no handler', async () => {
    const loop = new AgentLoop({ db, handlers: [] });
    loop.enqueue('SUMMARISE_SESSION', {});
    const report = await loop.tick();
    expect(report.skipped.length).toBe(1);
    expect(db.tasks.counts().RUNNING).toBe(0);
  });

  it('caps the batch size so a tick is bounded', async () => {
    let ran = 0;
    const loop = new AgentLoop({
      db,
      batchSize: 3,
      handlers: [{ kind: 'INDEX_PAGE', run: async () => { ran += 1; return 'ok'; } }],
    });
    for (let i = 0; i < 10; i += 1) loop.enqueue('INDEX_PAGE', { i });
    await loop.tick();
    expect(ran).toBe(3);
  });

  it('recovers orphaned RUNNING tasks after a crash', async () => {
    db.tasks.enqueue('INDEX_PAGE', {});
    db.tasks.claim(1);
    expect(db.tasks.counts().RUNNING).toBe(1);
    const loop = new AgentLoop({ db, handlers: [] });
    expect(loop.recover()).toBe(1);
    expect(db.tasks.counts().FAILED).toBe(1);
  });

  it('reports its status honestly', () => {
    const loop = new AgentLoop({ db, handlers: [{ kind: 'INDEX_PAGE', run: async () => 'ok' }] });
    const status = loop.status();
    expect(status.running).toBe(false);
    expect(status.handlers).toContain('INDEX_PAGE');
  });
});

describe('perception scheduler', () => {
  it('deduplicates identical observations inside the window', () => {
    let now = 0;
    const scheduler = new PerceptionScheduler(() => now, 60_000);
    expect(scheduler.shouldProcess('page', ['url-a', 'title-a'])).toBe(true);
    expect(scheduler.shouldProcess('page', ['url-a', 'title-a'])).toBe(false);
    now += 61_000;
    expect(scheduler.shouldProcess('page', ['url-a', 'title-a'])).toBe(true);
  });

  it('treats changed content as a new event', () => {
    const scheduler = new PerceptionScheduler(() => 0, 60_000);
    expect(scheduler.shouldProcess('page', ['url-a'])).toBe(true);
    expect(scheduler.shouldProcess('page', ['url-b'])).toBe(true);
  });

  it('produces a stable image fingerprint', () => {
    const a = PerceptionScheduler.imageFingerprint('abcdef'.repeat(1000));
    const b = PerceptionScheduler.imageFingerprint('abcdef'.repeat(1000));
    expect(a).toBe(b);
    expect(PerceptionScheduler.imageFingerprint('zzzz'.repeat(1000))).not.toBe(a);
  });
});

describe('session resume', () => {
  it('says nothing when there is no history', () => {
    const db = openDatabase(':memory:');
    const learning = new LearningService(db);
    db.sessions.recent().forEach(() => undefined);
    // Fresh DB has no sessions at all.
    const dbEmpty = openDatabase(':memory:');
    const summary = buildResumeSummary(dbEmpty, new LearningService(dbEmpty));
    expect(summary.greeting).toBeNull();
    expect(summary.lastNodeTitle).toBeNull();
    db.close();
    dbEmpty.close();
    void learning;
  });

  it('resumes the last lesson from stored records', () => {
    const db = openDatabase(':memory:');
    const learning = new LearningService(db);
    const session = db.sessions.ensureOpen();
    db.sessions.updateContext(session.id, { lastNodeTitle: '3.2.1 The TCP/IP Protocol Suite', courseId: 'ccna' });
    const summary = buildResumeSummary(db, learning);
    expect(summary.greeting).toContain('3.2.1 The TCP/IP Protocol Suite');
    expect(summary.lastCourseId).toBe('ccna');
    db.close();
  });

  it('mentions due reviews only when they actually exist', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const db = openDatabase(':memory:');
    const learning = new LearningService(db, () => now);
    learning.record({ conceptId: 'arp', kind: 'QUIZ_CORRECT', difficulty: 3, hintsUsed: 0, source: 'QUIZ_ENGINE' });
    let summary = buildResumeSummary(db, learning);
    expect(summary.greeting ?? '').not.toContain('repetera');

    now += 1000 * 60 * 60 * 24 * 30;
    summary = buildResumeSummary(db, learning);
    expect(summary.greeting).toContain('repetera');
    db.close();
  });
});
