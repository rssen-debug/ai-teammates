/**
 * Unified kernel — isolated home directory and durable engines.
 *
 * The layout is the MAJIN V6 layout (`home.ts` in that subsystem) with one
 * deliberate change: the kernel lives *inside* the Studdy data directory so a
 * single `studdy` install owns exactly one state tree the owner can inspect.
 *
 * Nothing here is created until `openKernel()` is called; `kernelHome()` is a
 * pure path resolver so `--json`/`doctor` can report paths without side effects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from './events.js';
import { TaskQueue } from './queue.js';
import { ensureDir, type Clock } from './util.js';

export const KERNEL_LAYOUT = Object.freeze({
  events: 'events',
  queue: 'queue/queue.json',
  workers: 'workers',
  reports: 'reports',
  receipts: 'receipts',
  stop: 'STOP',
  engine: 'engine.json',
  outbox: 'outbox',
});

export interface KernelPaths {
  home: string;
  eventsDir: string;
  queueFile: string;
  workersDir: string;
  reportsDir: string;
  receiptsDir: string;
  outboxDir: string;
  stopFile: string;
  engineFile: string;
}

/** Pure resolver: the kernel tree is `<dataDir>/kernel` unless overridden. */
export function kernelHome(dataDir: string, override: string | null = null, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(override || env.STUDDY_KERNEL_HOME || path.join(dataDir, 'kernel'));
}

export function kernelPaths(home: string): KernelPaths {
  const resolved = path.resolve(home);
  return {
    home: resolved,
    eventsDir: path.join(resolved, KERNEL_LAYOUT.events),
    queueFile: path.join(resolved, KERNEL_LAYOUT.queue),
    workersDir: path.join(resolved, KERNEL_LAYOUT.workers),
    reportsDir: path.join(resolved, KERNEL_LAYOUT.reports),
    receiptsDir: path.join(resolved, KERNEL_LAYOUT.receipts),
    outboxDir: path.join(resolved, KERNEL_LAYOUT.outbox),
    stopFile: path.join(resolved, KERNEL_LAYOUT.stop),
    engineFile: path.join(resolved, KERNEL_LAYOUT.engine),
  };
}

export function ensureLayout(home: string): KernelPaths {
  const paths = kernelPaths(home);
  for (const dir of [paths.home, paths.eventsDir, path.dirname(paths.queueFile), paths.workersDir, paths.reportsDir, paths.receiptsDir, paths.outboxDir]) {
    ensureDir(dir);
  }
  return paths;
}

export interface OpenKernelOptions {
  /** Data directory of the Studdy install. */
  dataDir: string;
  /** Explicit kernel home override (CLI flag or STUDDY_KERNEL_HOME). */
  home?: string | null;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
}

export interface OpenKernel {
  home: string;
  paths: KernelPaths;
  log: EventLog;
  queue: TaskQueue;
  clock: Clock;
}

export function openKernel({ dataDir, home = null, clock = Date.now, env = process.env }: OpenKernelOptions): OpenKernel {
  const resolved = kernelHome(dataDir, home, env);
  const paths = ensureLayout(resolved);
  const log = new EventLog(paths.eventsDir, { clock });
  const queue = new TaskQueue({ file: paths.queueFile, log, clock });
  return { home: resolved, paths, log, queue, clock };
}

export function stopRequested(home: string): boolean {
  return fs.existsSync(kernelPaths(home).stopFile);
}
