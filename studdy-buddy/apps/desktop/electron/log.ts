import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSensitive } from '@studdy/ai-router';

/**
 * Bounded, redacted logging.
 *
 * Requirements: no secrets in logs, bounded size, and enough detail for
 * `studdy logs` to be useful. We redact on the way IN (not on read), so a
 * secret can never be sitting in the file waiting to leak.
 */

export const MAX_LOG_BYTES = 2 * 1024 * 1024;

export interface LogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

export function redact(text: string): string {
  return redactSensitive(text);
}

export class BoundedLogger {
  constructor(private readonly path: string) {}

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size > MAX_LOG_BYTES) {
        renameSync(this.path, `${this.path}.1`);
      }
    } catch {
      /* rotation is best-effort; never break the app for it */
    }
  }

  log(entry: LogEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.rotateIfNeeded();
    const line = `${entry.at} ${entry.level.toUpperCase()} [${entry.scope}] ${redact(entry.message)}${
      entry.data !== undefined ? ` ${redact(JSON.stringify(entry.data))}` : ''
    }\n`;
    try {
      appendFileSync(this.path, line, 'utf8');
    } catch {
      /* logging must never throw */
    }
  }

  info(scope: string, message: string, data?: unknown): void {
    this.log({ at: new Date().toISOString(), level: 'info', scope, message, data });
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.log({ at: new Date().toISOString(), level: 'warn', scope, message, data });
  }

  error(scope: string, message: string, data?: unknown): void {
    this.log({ at: new Date().toISOString(), level: 'error', scope, message, data });
  }

  clear(): void {
    try {
      writeFileSync(this.path, '', 'utf8');
    } catch {
      /* ignore */
    }
  }
}
