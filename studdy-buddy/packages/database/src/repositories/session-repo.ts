import type { ChatMessage, ChatRole, ResponseMode, StudySession } from '@studdy/shared';
import { createId, nowIso, parseSettings, type Settings, type ProviderConfigInput } from '@studdy/shared';
import type { SqlDriver } from '../driver.js';

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  text: string;
  structured: string | null;
  mode: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  course_id: string | null;
  last_node_id: string | null;
  last_node_title: string | null;
  topic_summary: string | null;
}

export interface StoredProviderConfig extends ProviderConfigInput {
  updatedAt: string;
}

export class SettingsRepo {
  constructor(private readonly db: SqlDriver) {}

  get(): Settings {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
    if (!row) return parseSettings({});
    try {
      return parseSettings(JSON.parse(row.value));
    } catch {
      return parseSettings({});
    }
  }

  save(settings: Settings): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(settings), nowIso()],
    );
  }
}

export class ProviderRepo {
  constructor(private readonly db: SqlDriver) {}

  list(): StoredProviderConfig[] {
    return this.db
      .all<{ payload: string; updated_at: string; id: string }>('SELECT id, payload, updated_at FROM provider_config ORDER BY updated_at DESC')
      .map((row) => {
        try {
          return { ...(JSON.parse(row.payload) as ProviderConfigInput), updatedAt: row.updated_at };
        } catch {
          return null;
        }
      })
      .filter((v): v is StoredProviderConfig => v !== null);
  }

  get(id: string): StoredProviderConfig | null {
    const row = this.db.get<{ payload: string; updated_at: string }>('SELECT payload, updated_at FROM provider_config WHERE id = ?', [id]);
    if (!row) return null;
    try {
      return { ...(JSON.parse(row.payload) as ProviderConfigInput), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  save(config: ProviderConfigInput): void {
    this.db.run(
      `INSERT INTO provider_config (id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [config.id, JSON.stringify(config), nowIso()],
    );
  }

  remove(id: string): void {
    this.db.run('DELETE FROM provider_config WHERE id = ?', [id]);
  }
}

export class SessionRepo {
  constructor(private readonly db: SqlDriver) {}

  /** Returns the session that was open when the app last closed, if any. */
  latestOpen(): StudySession | null {
    const row = this.db.get<SessionRow>('SELECT * FROM study_session WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1');
    return row ? mapSession(row) : null;
  }

  create(partial: Partial<StudySession> = {}): StudySession {
    const session: StudySession = {
      id: partial.id ?? createId('sess'),
      startedAt: partial.startedAt ?? nowIso(),
      endedAt: null,
      courseId: partial.courseId ?? null,
      lastNodeId: partial.lastNodeId ?? null,
      lastNodeTitle: partial.lastNodeTitle ?? null,
      topicSummary: partial.topicSummary ?? null,
    };
    this.db.run(
      `INSERT INTO study_session (id, started_at, course_id, last_node_id, last_node_title, topic_summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [session.id, session.startedAt, session.courseId, session.lastNodeId, session.lastNodeTitle, session.topicSummary],
    );
    return session;
  }

  get(id: string): StudySession | null {
    const row = this.db.get<SessionRow>('SELECT * FROM study_session WHERE id = ?', [id]);
    return row ? mapSession(row) : null;
  }

  /** Idempotent: returns the open session, creating one when needed. */
  ensureOpen(): StudySession {
    const existing = this.latestOpen();
    if (existing) return existing;
    return this.create();
  }

  updateContext(id: string, patch: { courseId?: string | null; lastNodeId?: string | null; lastNodeTitle?: string | null; topicSummary?: string | null }): void {
    const current = this.get(id);
    if (!current) return;
    this.db.run('UPDATE study_session SET course_id = ?, last_node_id = ?, last_node_title = ?, topic_summary = ? WHERE id = ?', [
      patch.courseId !== undefined ? patch.courseId : current.courseId,
      patch.lastNodeId !== undefined ? patch.lastNodeId : current.lastNodeId,
      patch.lastNodeTitle !== undefined ? patch.lastNodeTitle : current.lastNodeTitle,
      patch.topicSummary !== undefined ? patch.topicSummary : current.topicSummary,
      id,
    ]);
  }

  end(id: string): void {
    this.db.run('UPDATE study_session SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [nowIso(), id]);
  }

  /**
   * Ends any session left open by a crash so we never end up with two open
   * sessions after an unclean shutdown.
   */
  closeStale(thresholdIso: string): number {
    return this.db.run('UPDATE study_session SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?', [nowIso(), thresholdIso]).changes;
  }

  recent(limit = 5): StudySession[] {
    return this.db.all<SessionRow>('SELECT * FROM study_session ORDER BY started_at DESC LIMIT ?', [limit]).map(mapSession);
  }
}

export class MessageRepo {
  constructor(private readonly db: SqlDriver) {}

  append(input: {
    sessionId: string;
    role: ChatRole;
    text: string;
    structured?: unknown;
    mode: ResponseMode;
    id?: string;
  }): ChatMessage {
    const message: ChatMessage = {
      id: input.id ?? createId('msg'),
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      structured: (input.structured as ChatMessage['structured']) ?? null,
      mode: input.mode,
      createdAt: nowIso(),
    };
    this.db.run('INSERT INTO chat_message (id, session_id, role, text, structured, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      message.id,
      message.sessionId,
      message.role,
      message.text,
      message.structured ? JSON.stringify(message.structured) : null,
      message.mode,
      message.createdAt,
    ]);
    return message;
  }

  list(sessionId: string, limit = 200): ChatMessage[] {
    return this.db
      .all<MessageRow>(
        'SELECT * FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
        [sessionId, limit],
      )
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as ChatRole,
        text: row.text,
        structured: row.structured ? (JSON.parse(row.structured) as ChatMessage['structured']) : null,
        mode: row.mode as ResponseMode,
        createdAt: row.created_at,
      }));
  }

  clearSession(sessionId: string): void {
    this.db.run('DELETE FROM chat_message WHERE session_id = ?', [sessionId]);
  }
}

function mapSession(row: SessionRow): StudySession {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    courseId: row.course_id,
    lastNodeId: row.last_node_id,
    lastNodeTitle: row.last_node_title,
    topicSummary: row.topic_summary,
  };
}
