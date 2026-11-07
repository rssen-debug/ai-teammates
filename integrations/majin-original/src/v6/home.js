/**
 * MAJIN V6 — isolated home directory.
 *
 * Default: %LOCALAPPDATA%\\MAJIN\\v6 (Windows) or ~/.local/share/MAJIN/v6.
 * The V5 data directory is read for owner grants only; V6 never writes there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from './events.js';
import { TaskQueue } from './queue.js';
import { JobStore } from './jobs/store.js';
import { ensureDir } from './util.js';

export const V6_LAYOUT = Object.freeze({
  events: 'events',
  queue: 'queue/queue.json',
  jobs: 'jobs/applications.json',
  profiles: 'jobs/profiles.json',
  workers: 'workers',
  reports: 'reports',
  driver: 'driver-mcp',
  stop: 'STOP',
  engine: 'engine.json',
  gmail: 'secrets/gmail.json',
  syncToken: 'secrets/github-token',
});

export function defaultBase(env = process.env) {
  return env.LOCALAPPDATA || path.join(env.HOME || env.USERPROFILE || process.cwd(), '.local', 'share');
}

export function resolveV6Home(env = process.env, override = null) {
  return path.resolve(override || env.MAJIN_V6_HOME || path.join(defaultBase(env), 'MAJIN', 'v6'));
}

export function resolveV5DataDir(env = process.env, override = null) {
  return path.resolve(override || env.MAJIN_V5_DATA_DIR || path.join(defaultBase(env), 'MAJIN', 'v5'));
}

export function ensureLayout(home) {
  for (const dir of ['events', 'queue', 'jobs', 'workers', 'reports', 'driver-mcp', 'secrets']) {
    ensureDir(path.join(home, dir));
  }
  return home;
}

export function openV6({ home, clock = Date.now, log = null } = {}) {
  if (!home) throw new Error('openV6 requires a home directory');
  ensureLayout(home);
  const events = log || new EventLog(path.join(home, V6_LAYOUT.events), { clock });
  const queue = new TaskQueue({ file: path.join(home, V6_LAYOUT.queue), log: events, clock });
  const jobs = new JobStore({ file: path.join(home, V6_LAYOUT.jobs), clock, log: events });
  return {
    home,
    log: events,
    queue,
    jobs,
    workersDir: path.join(home, V6_LAYOUT.workers),
    reportsDir: path.join(home, V6_LAYOUT.reports),
    profilesFile: path.join(home, V6_LAYOUT.profiles),
    stopFile: path.join(home, V6_LAYOUT.stop),
    engineFile: path.join(home, V6_LAYOUT.engine),
    gmailFile: path.join(home, V6_LAYOUT.gmail),
    syncTokenFile: path.join(home, V6_LAYOUT.syncToken),
  };
}

export function stopRequested(home) {
  return fs.existsSync(path.join(home, V6_LAYOUT.stop));
}
