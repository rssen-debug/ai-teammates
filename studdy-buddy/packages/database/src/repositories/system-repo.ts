import { createId, dayKey, nowIso, type ProviderUsage } from '@studdy/shared';
import type { SqlDriver } from '../driver.js';

export interface PermissionRecord {
  key: string;
  granted: boolean;
  grantedAt: string | null;
  mode: string;
}

export class PermissionRepo {
  constructor(private readonly db: SqlDriver) {}

  list(): PermissionRecord[] {
    return this.db.all<{ key: string; granted: number; granted_at: string | null; mode: string }>(
      'SELECT * FROM permission_grant ORDER BY key',
    ).map((r) => ({ key: r.key, granted: r.granted === 1, grantedAt: r.granted_at, mode: r.mode }));
  }

  get(key: string): PermissionRecord | null {
    const r = this.db.get<{ key: string; granted: number; granted_at: string | null; mode: string }>(
      'SELECT * FROM permission_grant WHERE key = ?',
      [key],
    );
    return r ? { key: r.key, granted: r.granted === 1, grantedAt: r.granted_at, mode: r.mode } : null;
  }

  set(key: string, granted: boolean, mode = 'OBSERVE_ONLY'): void {
    this.db.run(
      `INSERT INTO permission_grant (key, granted, granted_at, mode) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET granted = excluded.granted, granted_at = excluded.granted_at, mode = excluded.mode`,
      [key, granted ? 1 : 0, granted ? nowIso() : null, mode],
    );
  }

  setMode(mode: string): void {
    // Mode is global; each grant row carries it so the UI can show one value.
    this.db.run('UPDATE permission_grant SET mode = ?', [mode]);
  }
}

export class ObservationRepo {
  constructor(private readonly db: SqlDriver) {}

  record(kind: string, payload: unknown, sessionId: string | null = null): void {
    this.db.run('INSERT INTO observation_event (id, session_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)', [
      createId('obs'),
      sessionId,
      kind,
      JSON.stringify(payload),
      nowIso(),
    ]);
  }

  recent(limit = 50): { id: string; kind: string; payload: unknown; createdAt: string }[] {
    return this.db
      .all<{ id: string; kind: string; payload: string; created_at: string }>(
        'SELECT id, kind, payload, created_at FROM observation_event ORDER BY created_at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({ id: r.id, kind: r.kind, payload: safeParse(r.payload), createdAt: r.created_at }));
  }

  /** Keeps the event log bounded - unbounded observation logs are a privacy risk. */
  prune(keep = 2000): number {
    return this.db.run(
      'DELETE FROM observation_event WHERE id NOT IN (SELECT id FROM observation_event ORDER BY created_at DESC LIMIT ?)',
      [keep],
    ).changes;
  }
}

export class UsageRepo {
  constructor(private readonly db: SqlDriver) {}

  add(input: { inputTokens: number; outputTokens: number; costUsd: number; clock?: () => number }): void {
    const day = dayKey(input.clock);
    this.db.run(
      `INSERT INTO provider_usage (day, requests, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         requests = provider_usage.requests + 1,
         input_tokens = provider_usage.input_tokens + excluded.input_tokens,
         output_tokens = provider_usage.output_tokens + excluded.output_tokens,
         estimated_cost_usd = provider_usage.estimated_cost_usd + excluded.estimated_cost_usd`,
      [day, input.inputTokens, input.outputTokens, input.costUsd],
    );
  }

  today(clock?: () => number): ProviderUsage {
    const day = dayKey(clock);
    const row = this.db.get<{ day: string; requests: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number }>(
      'SELECT * FROM provider_usage WHERE day = ?',
      [day],
    );
    return {
      day,
      requests: row?.requests ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      estimatedCostUsd: row?.estimated_cost_usd ?? 0,
    };
  }
}

export interface AgentTaskRecord {
  id: string;
  kind: string;
  payload: unknown;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  availableAt: string;
  lastError: string | null;
}

export class AgentTaskRepo {
  constructor(private readonly db: SqlDriver) {}

  enqueue(kind: string, payload: unknown, availableAt = nowIso()): string {
    const id = createId('task');
    this.db.run(
      'INSERT INTO agent_task (id, kind, payload, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [id, kind, JSON.stringify(payload), 'PENDING', availableAt, nowIso(), nowIso()],
    );
    return id;
  }

  claim(limit = 5): AgentTaskRecord[] {
    const now = nowIso();
    return this.db.transaction(() => {
      const rows = this.db.all<{ id: string; kind: string; payload: string; status: string; attempts: number; available_at: string; last_error: string | null }>(
        "SELECT * FROM agent_task WHERE status IN ('PENDING','FAILED') AND available_at <= ? ORDER BY available_at ASC LIMIT ?",
        [now, limit],
      );
      for (const r of rows) {
        this.db.run("UPDATE agent_task SET status = 'RUNNING', updated_at = ? WHERE id = ?", [now, r.id]);
      }
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: safeParse(r.payload),
        status: 'RUNNING' as const,
        attempts: r.attempts,
        availableAt: r.available_at,
        lastError: r.last_error,
      }));
    });
  }

  complete(id: string): void {
    this.db.run("UPDATE agent_task SET status = 'DONE', updated_at = ? WHERE id = ?", [nowIso(), id]);
  }

  fail(id: string, error: string, nextAvailableAt: string): void {
    this.db.run(
      "UPDATE agent_task SET status = 'FAILED', attempts = attempts + 1, last_error = ?, available_at = ?, updated_at = ? WHERE id = ?",
      [error.slice(0, 500), nextAvailableAt, nowIso(), id],
    );
  }

  counts(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM agent_task GROUP BY status');
    const out: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Requeue tasks orphaned by a crash (running when the app died). */
  recoverOrphans(): number {
    return this.db.run("UPDATE agent_task SET status = 'FAILED', updated_at = ? WHERE status = 'RUNNING'", [nowIso()]).changes;
  }
}

export class CheckpointRepo {
  constructor(private readonly db: SqlDriver) {}

  get<T>(key: string): T | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM agent_checkpoint WHERE key = ?', [key]);
    return row ? (safeParse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO agent_checkpoint (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), nowIso()],
    );
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
