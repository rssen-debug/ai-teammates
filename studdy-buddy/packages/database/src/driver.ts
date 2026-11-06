/**
 * SQLite access with no native compilation step.
 *
 * We use Node's built-in `node:sqlite` (usable without a flag from Node 22.13+; the
 * Electron build must therefore bundle Node 22.13 or newer - Electron 33 bundled
 * Node 20, where the module does not exist at all
 * in current 22.x/23+ releases). That removes the better-sqlite3/node-gyp
 * dependency that breaks on machines without a C++ toolchain, which matters
 * because this ships as a Windows installer.
 *
 * Everything outside this file talks to the small `SqlDriver` interface, so the
 * storage engine can be swapped (or backed by a test double) without touching
 * repositories.
 */

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): SqlRunResult;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

export class SqliteUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `SQLite is not available in this runtime (${detail}). Studdy Buddy needs Node 22.13+ ` +
        `with the built-in node:sqlite module, and an Electron build that bundles Node 22.13+ ` +
        `(Electron 37 or newer). On Electron 33 (Node 20) the module does not exist.`,
    );
    this.name = 'SqliteUnavailableError';
  }
}

/**
 * Thin wrapper over node:sqlite implementing the app's SqlDriver interface.
 * All SQL in the app goes through here, which keeps the engine swappable and
 * makes the driver the single place that knows about SQLite specifics.
 */
export class NodeSqliteDriver implements SqlDriver {
  private constructor(private readonly db: NodeSqliteDatabase) {}

  /** Opens a database synchronously; throws SqliteUnavailableError if unsupported. */
  static open(path: string): NodeSqliteDriver {
    const { DatabaseSync } = loadNodeSqliteSync();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 4000');
    return new NodeSqliteDriver(db);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: unknown[] = []): SqlRunResult {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* a rollback failure must not mask the original error */
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Synchronous probe. Returns true only when DatabaseSync was actually obtained,
 * because the constructor signature is synchronous and nothing in the app can
 * await a database connection.
 */
export function isSqliteAvailable(): boolean {
  try {
    loadNodeSqliteSync();
    return true;
  } catch {
    return false;
  }
}

function loadNodeSqliteSync(): { DatabaseSync: new (path: string) => NodeSqliteDatabase } {
  const errors: string[] = [];

  try {
    // The whole point of this function is to probe whether a CJS `require`
    // exists at runtime; a static import would break the bundled CJS main.
    const req = typeof require === 'function' ? require : null;
    if (req) {
      const mod = req('node:sqlite') as { DatabaseSync?: unknown };
      if (typeof mod?.DatabaseSync === 'function') {
        return { DatabaseSync: mod.DatabaseSync as new (path: string) => NodeSqliteDatabase };
      }
    }
  } catch (err) {
    errors.push(`require: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // createRequire is itself a synchronous CommonJS API and is available in ESM.
    // We import it lazily through the CJS cache to stay synchronous.
    const nodeModule = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.('node:module') as
      | { createRequire: (p: string) => NodeRequire }
      | undefined;
    if (nodeModule?.createRequire) {
      const req = nodeModule.createRequire(`${process.cwd()}/`);
      const mod = req('node:sqlite') as { DatabaseSync?: unknown };
      if (typeof mod?.DatabaseSync === 'function') {
        return { DatabaseSync: mod.DatabaseSync as new (path: string) => NodeSqliteDatabase };
      }
    }
  } catch (err) {
    errors.push(`createRequire: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new SqliteUnavailableError(errors.join(' | ') || 'no loader available');
}
