import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, databaseHealth, schemaVersion, type Database } from '@studdy/database';
import { DEFAULT_SETTINGS, mergeSettings } from '@studdy/shared';

describe('database', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('applies all migrations on a fresh database', () => {
    expect(db.migrations.applied.length).toBeGreaterThan(0);
    expect(db.migrations.currentVersion).toBe(schemaVersion());
    expect(databaseHealth(db).ok).toBe(true);
  });

  it('is idempotent when opened twice on the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-'));
    try {
      const path = join(dir, 'studdy.db');
      const first = openDatabase(path);
      const appliedFirst = first.migrations.applied.length;
      first.close();

      const second = openDatabase(path);
      expect(appliedFirst).toBeGreaterThan(0);
      expect(second.migrations.applied).toEqual([]);
      expect(second.migrations.currentVersion).toBe(schemaVersion());
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists settings across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-'));
    try {
      const path = join(dir, 'studdy.db');
      const a = openDatabase(path);
      const updated = mergeSettings(DEFAULT_SETTINGS, { theme: 'dark', voice: { enabled: true, speed: 1.2 } });
      a.settings.save(updated);
      a.close();

      const b = openDatabase(path);
      const loaded = b.settings.get();
      expect(loaded.theme).toBe('dark');
      expect(loaded.voice.enabled).toBe(true);
      expect(loaded.voice.speed).toBe(1.2);
      // Voice defaults off; only the explicit update turns it on.
      expect(DEFAULT_SETTINGS.voice.enabled).toBe(false);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only one open session and survives restart', () => {
    const s1 = db.sessions.ensureOpen();
    const s2 = db.sessions.ensureOpen();
    expect(s2.id).toBe(s1.id);
    db.sessions.updateContext(s1.id, { lastNodeTitle: 'OSI Model', courseId: 'ccna' });
    const reloaded = db.sessions.latestOpen();
    expect(reloaded?.lastNodeTitle).toBe('OSI Model');
  });

  it('cascades message deletion with the session', () => {
    const session = db.sessions.create();
    db.messages.append({ sessionId: session.id, role: 'user', text: 'hej', mode: 'NORMAL' });
    expect(db.messages.list(session.id)).toHaveLength(1);
    db.driver.run('DELETE FROM study_session WHERE id = ?', [session.id]);
    expect(db.messages.list(session.id)).toHaveLength(0);
  });

  it('forms an ordered transcript', () => {
    const session = db.sessions.create();
    db.messages.append({ sessionId: session.id, role: 'user', text: 'one', mode: 'QUICK' });
    db.messages.append({ sessionId: session.id, role: 'buddy', text: 'two', mode: 'QUICK' });
    const list = db.messages.list(session.id);
    expect(list.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('stores and reloads a curriculum graph with honest module count', () => {
    db.curriculum.saveGraph({
      courseId: 'ccna-1',
      courseName: 'CCNA: Introduction to Networks',
      sourceUrl: 'https://www.netacad.com/courses/networking',
      discoveredAt: new Date().toISOString(),
      nodes: [
        { id: 'm1', kind: 'MODULE', title: 'Module 1', order: 1, url: null, parentId: null, platformCompleted: false, inaccessible: false },
        { id: 'm2', kind: 'MODULE', title: 'Module 2', order: 2, url: null, parentId: null, platformCompleted: null, inaccessible: true },
        { id: 's1', kind: 'SECTION', title: '1.1', order: 1, url: null, parentId: 'm1', platformCompleted: true, inaccessible: false },
      ],
    });
    expect(db.curriculum.moduleCount('ccna-1')).toBe(2);
    const graph = db.curriculum.loadGraph('ccna-1');
    expect(graph?.nodes.find((n) => n.id === 'm2')?.inaccessible).toBe(true);
    expect(graph?.nodes.find((n) => n.id === 'm2')?.platformCompleted).toBeNull();
  });

  it('tracks daily usage and agent task lifecycle', () => {
    db.usage.add({ inputTokens: 1000, outputTokens: 500, costUsd: 0.002 });
    db.usage.add({ inputTokens: 1000, outputTokens: 500, costUsd: 0.003 });
    const today = db.usage.today();
    expect(today.requests).toBe(2);
    expect(today.estimatedCostUsd).toBeCloseTo(0.005, 6);

    const id = db.tasks.enqueue('observe', { window: 'x' });
    const claimed = db.tasks.claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(id);
    expect(db.tasks.claim()).toHaveLength(0); // already running
    db.tasks.fail(id, 'boom', new Date(Date.now() - 1000).toISOString());
    expect(db.tasks.counts().FAILED).toBe(1);
    const retried = db.tasks.claim();
    expect(retried[0]?.attempts).toBe(1);
    db.tasks.complete(id);
    expect(db.tasks.counts().DONE).toBe(1);
  });
});
