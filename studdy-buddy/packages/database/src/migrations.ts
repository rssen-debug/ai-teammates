import type { SqlDriver } from './driver.js';

/**
 * Versioned migrations. Rules:
 *  - append only; never edit a migration that has shipped
 *  - each migration is idempotent-safe via the schema_migrations table
 *  - no destructive changes without a new migration
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_settings_sessions_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS study_session (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        course_id TEXT,
        last_node_id TEXT,
        last_node_title TEXT,
        topic_summary TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_session(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        structured TEXT,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_message_session ON chat_message(session_id, created_at);

      CREATE TABLE IF NOT EXISTS permission_grant (
        key TEXT PRIMARY KEY,
        granted INTEGER NOT NULL,
        granted_at TEXT,
        mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_config (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'curriculum_graph',
    sql: `
      CREATE TABLE IF NOT EXISTS curriculum_node (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        ordinal INTEGER,
        url TEXT,
        platform_completed INTEGER,
        inaccessible INTEGER NOT NULL DEFAULT 0,
        discovered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_curriculum_course ON curriculum_node(course_id);
      CREATE INDEX IF NOT EXISTS idx_curriculum_parent ON curriculum_node(parent_id);

      CREATE TABLE IF NOT EXISTS curriculum_course (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        discovered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observation_event (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observation_created ON observation_event(created_at);
    `,
  },
  {
    version: 3,
    name: 'learning_evidence_mastery',
    sql: `
      CREATE TABLE IF NOT EXISTS concept (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'networking'
      );

      CREATE TABLE IF NOT EXISTS concept_dependency (
        concept_id TEXT NOT NULL,
        prerequisite_id TEXT NOT NULL,
        PRIMARY KEY (concept_id, prerequisite_id)
      );

      CREATE TABLE IF NOT EXISTS learning_evidence (
        id TEXT PRIMARY KEY,
        concept_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        hints_used INTEGER NOT NULL DEFAULT 0,
        independent INTEGER NOT NULL,
        source TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_concept ON learning_evidence(concept_id, created_at);

      CREATE TABLE IF NOT EXISTS mastery_estimate (
        concept_id TEXT PRIMARY KEY,
        probability REAL NOT NULL,
        state TEXT NOT NULL,
        evidence_count INTEGER NOT NULL,
        independent_correct INTEGER NOT NULL,
        last_evidence_at TEXT,
        review_due_at TEXT,
        confidence REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS practice_attempt (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        hints_used INTEGER NOT NULL,
        answer TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS misconception (
        id TEXT PRIMARY KEY,
        concept_id TEXT NOT NULL,
        description TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'agent_runtime_usage_voice',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_task (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_status ON agent_task(status, available_at);

      CREATE TABLE IF NOT EXISTS agent_checkpoint (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_usage (
        day TEXT PRIMARY KEY,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS packet_tracer_session (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        window_title TEXT,
        observation TEXT
      );
    `,
  },
];

export interface MigrationReport {
  applied: number[];
  alreadyAt: number;
  currentVersion: number;
}

export function migrate(db: SqlDriver): MigrationReport {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const row = db.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
  const current = row?.version ?? 0;
  const applied: number[] = [];

  const pending = [...MIGRATIONS].filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.version);
  }

  const after = db.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
  return { applied, alreadyAt: current, currentVersion: after?.version ?? 0 };
}
