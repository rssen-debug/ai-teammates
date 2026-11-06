import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { NodeSqliteDriver, isSqliteAvailable, type SqlDriver } from './driver.js';
import { migrate, MIGRATIONS, type MigrationReport } from './migrations.js';
import {
  AgentTaskRepo,
  CheckpointRepo,
  MessageRepo,
  ObservationRepo,
  PermissionRepo,
  ProviderRepo,
  SessionRepo,
  SettingsRepo,
  UsageRepo,
  LearningRepo,
  CurriculumRepo,
} from './repositories/index.js';

export * from './driver.js';
export * from './migrations.js';
export * from './repositories/index.js';

export interface Database {
  driver: SqlDriver;
  settings: SettingsRepo;
  providers: ProviderRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  curriculum: CurriculumRepo;
  learning: LearningRepo;
  permissions: PermissionRepo;
  observations: ObservationRepo;
  usage: UsageRepo;
  tasks: AgentTaskRepo;
  checkpoints: CheckpointRepo;
  migrations: MigrationReport;
  close(): void;
}

export function defaultDataDir(): string {
  if (process.env.STUDDY_DATA_DIR) return process.env.STUDDY_DATA_DIR;
  const platform = process.platform;
  if (platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'StuddyBuddy');
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'StuddyBuddy');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'studdy-buddy');
}

export function databasePath(dataDir = defaultDataDir()): string {
  return join(dataDir, 'studdy.db');
}

/**
 * Opens (and migrates) the database. Pass ':memory:' for tests.
 */
export function openDatabase(path = databasePath()): Database {
  if (!isSqliteAvailable()) {
    throw new Error(
      'node:sqlite is not available in this runtime. Studdy Buddy requires Node 22.5+ (or an Electron build with the same Node version).',
    );
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const driver = NodeSqliteDriver.open(path);
  const report = migrate(driver);
  return {
    driver,
    settings: new SettingsRepo(driver),
    providers: new ProviderRepo(driver),
    sessions: new SessionRepo(driver),
    messages: new MessageRepo(driver),
    curriculum: new CurriculumRepo(driver),
    learning: new LearningRepo(driver),
    permissions: new PermissionRepo(driver),
    observations: new ObservationRepo(driver),
    usage: new UsageRepo(driver),
    tasks: new AgentTaskRepo(driver),
    checkpoints: new CheckpointRepo(driver),
    migrations: report,
    close: () => driver.close(),
  };
}

export function schemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Health check used by `studdy doctor`. */
export function databaseHealth(db: Database): { ok: boolean; version: number; tables: number; detail: string } {
  try {
    const tables = db.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")?.n ?? 0;
    return { ok: true, version: db.migrations.currentVersion, tables, detail: `${tables} tables, schema v${db.migrations.currentVersion}` };
  } catch (err) {
    return { ok: false, version: 0, tables: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
