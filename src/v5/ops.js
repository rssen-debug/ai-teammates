/**
 * MAJIN V5 — Operations, Loop Guard, Backup, Rollback & Build Provenance (Section 12).
 *
 * Reuses `src/v4/supervisor.js` and `src/v4/autonomous-diagnosis.js`.
 *
 * Enforces:
 *  - No infinite agent loops: hard caps on time, cost, attempts, and consecutive
 *    non-progressing steps.
 *  - Strategy switching when repeated failures occur.
 *  - Atomic persistent storage (write-to-temp + fsync + rename).
 *  - Safe backup, migration and automatic rollback on failed update.
 *  - Visible installed version (`5.0.0`) and exact build SHA.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Supervisor } from '../v4/supervisor.js';
import { superviseFailure } from '../v4/autonomous-diagnosis.js';

export const V5_VERSION = [5, 0, 0].join('.');

/** Resolve the current git / build SHA honestly. */
export function resolveBuildSha(repoRoot = process.cwd()) {
  if (process.env.MAJIN_BUILD_SHA) return String(process.env.MAJIN_BUILD_SHA).trim();
  const buildManifest = path.join(repoRoot, 'docs', 'v5', 'build-manifest.json');
  if (fs.existsSync(buildManifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(buildManifest, 'utf8'));
      if (m?.gitSha) return m.gitSha;
    } catch { /* fall through */ }
  }
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  } catch { /* fall through */ }
  return 'unknown';
}

/** Atomic JSON write with fsync + rename so crashes never leave half-written files. */
export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Bounded Execution & Anti-Loop Guard.
 * Prevents infinite agent loops, detects repeated non-progress, bounds time/cost/attempts,
 * and recommends strategy switches.
 */
export class ExecutionLoopGuard {
  constructor({
    maxSteps = 16,
    maxDurationMs = 60_000,
    maxCostUsd = 0.50,
    maxConsecutiveFailures = 3,
    maxSameToolRepeats = 2,
    now = () => Date.now(),
  } = {}) {
    this.maxSteps = maxSteps;
    this.maxDurationMs = maxDurationMs;
    this.maxCostUsd = maxCostUsd;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.maxSameToolRepeats = maxSameToolRepeats;
    this.now = now;

    this.startedAt = this.now();
    this.steps = 0;
    this.costUsd = 0;
    this.consecutiveFailures = 0;
    this.callCounts = new Map(); // fingerprint -> count
    this.toolFailureCounts = new Map(); // tool -> count
  }

  /** Check limits before executing the next step. */
  checkBeforeStep({ tool = '', args = {} } = {}) {
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.maxDurationMs) {
      return { allowed: false, code: 'LIMIT_TIME_EXCEEDED', message: `Execution exceeded time limit (${this.maxDurationMs} ms).` };
    }
    if (this.steps >= this.maxSteps) {
      return { allowed: false, code: 'LIMIT_STEPS_EXCEEDED', message: `Execution reached step limit (${this.maxSteps}).` };
    }
    if (this.costUsd > this.maxCostUsd) {
      return { allowed: false, code: 'LIMIT_COST_EXCEEDED', message: `Execution exceeded cost budget ($${this.maxCostUsd.toFixed(4)}).` };
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return { allowed: false, code: 'NO_PROGRESS_STAGNATION', message: `Stopped after ${this.consecutiveFailures} consecutive steps without verified progress.` };
    }

    if (tool) {
      const fp = `${tool}:${crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex').slice(0, 12)}`;
      const seen = this.callCounts.get(fp) || 0;
      if (seen >= this.maxSameToolRepeats) {
        return {
          allowed: false,
          code: 'LOOP_IDENTICAL_CALL_BLOCKED',
          message: `Blocked repeated identical call to ${tool} (${seen} prior attempts). Switch strategy.`,
        };
      }
    }

    return { allowed: true };
  }

  /** Record step outcome and return strategy recommendation if failing. */
  recordStepOutcome({
    tool = '',
    args = {},
    ok = true,
    verifiedProgress = false,
    failureClass = null,
    stepCostUsd = 0,
    availableTools = [],
  } = {}) {
    this.steps += 1;
    if (Number.isFinite(stepCostUsd) && stepCostUsd > 0) {
      this.costUsd = Number((this.costUsd + stepCostUsd).toFixed(6));
    }

    const fp = `${tool}:${crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex').slice(0, 12)}`;
    this.callCounts.set(fp, (this.callCounts.get(fp) || 0) + 1);

    if (ok && verifiedProgress) {
      this.consecutiveFailures = 0;
      return { switchStrategy: false, consecutiveFailures: 0 };
    }

    if (!ok) {
      this.consecutiveFailures += 1;
      const toolFails = (this.toolFailureCounts.get(tool) || 0) + 1;
      this.toolFailureCounts.set(tool, toolFails);
      const diagnosis = superviseFailure({
        tool,
        code: failureClass || 'TOOL_FAILURE',
        repeats: toolFails,
        available: availableTools,
      });
      return {
        switchStrategy: true,
        consecutiveFailures: this.consecutiveFailures,
        diagnosis,
      };
    }

    return { switchStrategy: false, consecutiveFailures: this.consecutiveFailures };
  }
}

/**
 * Backup, Migration & Update Rollback Manager for V5 data directory.
 */
export class V5OpsManager {
  constructor({ dataDir, repoRoot = process.cwd() } = {}) {
    if (!dataDir) throw new Error('V5OpsManager requires dataDir');
    this.dataDir = dataDir;
    this.repoRoot = repoRoot;
    this.backupsDir = path.join(dataDir, 'backups');
    this.releaseStateFile = path.join(dataDir, 'release-state.json');
    fs.mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
  }

  getVersionInfo() {
    const buildSha = resolveBuildSha(this.repoRoot);
    let releaseState = null;
    if (fs.existsSync(this.releaseStateFile)) {
      try {
        releaseState = JSON.parse(fs.readFileSync(this.releaseStateFile, 'utf8'));
      } catch { /* ignore */ }
    }
    return {
      product: 'MAJIN V5 — GRAND ARCHITECT',
      version: releaseState?.activeVersion || V5_VERSION,
      buildSha: releaseState?.activeSha || buildSha,
      previousVersion: releaseState?.previousVersion || null,
      previousSha: releaseState?.previousSha || null,
      rolledBack: Boolean(releaseState?.rolledBack),
      nodeVersion: process.versions.node,
      platform: process.platform,
    };
  }

  /** Create a verified backup snapshot of V5 persistent state files. */
  createBackup({ label = 'manual' } = {}) {
    const backupId = `backup-${Date.now()}-${label.replace(/[^a-z0-9-_]/gi, '')}`;
    const targetDir = path.join(this.backupsDir, backupId);
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

    const files = fs.readdirSync(this.dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(json|jsonl)$/.test(e.name))
      .map((e) => e.name);

    const manifestFiles = {};
    for (const name of files) {
      const src = path.join(this.dataDir, name);
      const dst = path.join(targetDir, name);
      const bytes = fs.readFileSync(src);
      fs.writeFileSync(dst, bytes, { mode: 0o600 });
      manifestFiles[name] = {
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }

    const manifest = {
      schema: 'majin.v5.backup/v1',
      backupId,
      createdAt: new Date().toISOString(),
      version: V5_VERSION,
      buildSha: resolveBuildSha(this.repoRoot),
      files: manifestFiles,
    };
    atomicWriteJson(path.join(targetDir, 'backup-manifest.json'), manifest);
    return manifest;
  }

  /** Restore a backup and verify every file's SHA-256 before replacing live state. */
  restoreBackup(backupId) {
    const targetDir = path.join(this.backupsDir, backupId);
    const manifestPath = path.join(targetDir, 'backup-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Backup not found: ${backupId}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const [name, meta] of Object.entries(manifest.files || {})) {
      const src = path.join(targetDir, name);
      if (!fs.existsSync(src)) throw new Error(`Backup file missing: ${name}`);
      const bytes = fs.readFileSync(src);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha !== meta.sha256) {
        throw new Error(`Backup integrity check failed for ${name}`);
      }
    }
    for (const name of Object.keys(manifest.files || {})) {
      const src = path.join(targetDir, name);
      const dst = path.join(this.dataDir, name);
      const tmp = `${dst}.${process.pid}.restore.tmp`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
    }
    return { ok: true, restoredBackupId: backupId, filesRestored: Object.keys(manifest.files || {}).length };
  }

  /**
   * Apply an update with automatic pre-update backup and rollback if health check fails.
   */
  async applyUpdateWithRollback({
    newVersion,
    newSha,
    verifyHealth = async () => true,
  } = {}) {
    const current = this.getVersionInfo();
    const preBackup = this.createBackup({ label: 'pre-update' });

    const candidateState = {
      activeVersion: newVersion || V5_VERSION,
      activeSha: newSha || current.buildSha,
      previousVersion: current.version,
      previousSha: current.buildSha,
      backupId: preBackup.backupId,
      updatedAt: new Date().toISOString(),
      rolledBack: false,
    };
    atomicWriteJson(this.releaseStateFile, candidateState);

    let healthy = false;
    try {
      healthy = Boolean(await verifyHealth());
    } catch {
      healthy = false;
    }

    if (!healthy) {
      // Automatic rollback!
      this.restoreBackup(preBackup.backupId);
      const rolledBackState = {
        activeVersion: current.version,
        activeSha: current.buildSha,
        previousVersion: newVersion,
        previousSha: newSha,
        backupId: preBackup.backupId,
        rolledBack: true,
        rollbackReason: 'Post-update health check failed',
        updatedAt: new Date().toISOString(),
      };
      atomicWriteJson(this.releaseStateFile, rolledBackState);
      return {
        ok: false,
        rolledBack: true,
        activeVersion: current.version,
        activeSha: current.buildSha,
        backupId: preBackup.backupId,
      };
    }

    return {
      ok: true,
      rolledBack: false,
      activeVersion: candidateState.activeVersion,
      activeSha: candidateState.activeSha,
      backupId: preBackup.backupId,
    };
  }

  createSupervisor(options = {}) {
    return new Supervisor(options);
  }
}
