/**
 * MAJIN W14 — update rollback core (the honest, platform-free half).
 *
 * What rollback means here: after an update, MAJIN keeps a MANIFEST of
 * installed versions and the installer apparatus keeps the previous
 * artifact on disk. A rollback is only true if there EXISTS a prior
 * artifact whose bytes still match their recorded sha256 — anything
 * else is a story, not a rollback.
 *
 * This module owns the deterministic contract (manifest, plan, gate,
 * dry-check-first) and lets the actual platform restore be INJECTED
 * (windows installer script pastes the artifact back / re-runs setup).
 * Injecting the platform hook is the wheel-rule too: the repo already
 * has installer scripts; this is their memory + gate, not a second
 * updater.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROLLBACK_VERSION = 'majin-rollback/1';

export class RollbackError extends Error {
  constructor(msg, code = 'rollback_error') { super(msg); this.name = 'RollbackError'; this.code = code; }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function manifestPath(installDir) { return path.join(installDir, '.majin-install-manifest.json'); }

export function readManifest(installDir) {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(installDir), 'utf8'));
    if (!j || !Array.isArray(j.versions)) throw new Error('no versions[]');
    return j;
  } catch { return { version: ROLLBACK_VERSION, versions: [] }; }
}

export function writeManifest(installDir, m) {
  fs.mkdirSync(installDir, { recursive: true });
  const tmp = manifestPath(installDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, manifestPath(installDir));
}

/**
 * Record an installed version. backupFile is COPIED into
 * <installDir>/.rollback/backups/<version>/<basename> — rollback never
 * trusts a path the original installer might later overwrite.
 */
export function recordInstalled(installDir, { version, appVersion = null, installedAt = null, backupFile = null, backupBytes = null }) {
  if (!version) throw new RollbackError('recordInstalled: version is required', 'bad_input');
  const m = readManifest(installDir);
  if (m.versions.some((v) => v.version === version)) m.versions = m.versions.filter((v) => v.version !== version); // re-install of same version replaces entry, never duplicates
  let backup = null;
  if (backupFile && fs.existsSync(backupFile)) {
    const bytes = fs.readFileSync(backupFile);
    const sha = sha256(bytes);
    const dir = path.join(installDir, '.rollback', 'backups', version);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(backupFile));
    fs.writeFileSync(dest, bytes);
    backup = { file: dest, sha256: sha, bytes: bytes.length };
  } else if (backupBytes && backupBytes.sha256) {
    // verifier-supplied manifest (external backups): verified when read
    backup = backupBytes;
  }
  m.versions.push({
    version, appVersion: appVersion || version,
    installedAt: installedAt || new Date().toISOString(),
    backup,
  });
  m.versions.sort((a, b) => a.installedAt < b.installedAt ? -1 : 1);
  writeManifest(installDir, m);
  return m;
}

/**
 * plan = the dry contract. Rollback to CURRENT version is nonsense; a
 * backup that vanished is diagnosable not magic; a sha mismatch = refuse
 * LOUD (bytes changed — file may be corrupt or replaced).
 */
export function planRollback(installDir, { currentVersion = null } = {}) {
  const m = readManifest(installDir);
  const current = currentVersion || m.versions.at(-1)?.version || null;
  if (!current) throw new RollbackError('no installed version recorded — nothing to roll back from', 'no_state');
  const history = m.versions.filter((v) => v.version !== current);
  if (!history.length) throw new RollbackError(`no EARLIER version recorded (only ${current}) — rollback target does not exist`, 'no_target');
  const refusals = [];
  for (const v of [...history].reverse()) { // newest good candidate forst
    if (!v.backup) { refusals.push({ version: v.version, reason: 'no backup recorded' }); continue; }
    if (!v.backup.file || !fs.existsSync(v.backup.file)) { refusals.push({ version: v.version, reason: `backup file missing: ${v.backup.file || '<none>'}` }); continue; }
    const sha = sha256(fs.readFileSync(v.backup.file));
    if (sha !== v.backup.sha256) { refusals.push({ version: v.version, reason: `sha mismatch: recorded ${v.backup.sha256?.slice(0, 12)}… vs disk ${sha.slice(0, 12)}… — bytes changed, never restore unidentified content` }); continue; }
    return {
      ok: true, from: current, to: v.version, backupFile: v.backup.file, sha256: sha,
      bytes: v.backup.bytes || fs.statSync(v.backup.file).size,
      refused: refusals, version: ROLLBACK_VERSION,
    };
  }
  throw new RollbackError(`no usable rollback target: ${refusals.map((r) => `${r.version} (${r.reason})`).join('; ')}`, 'no_usable_target');
}

/**
 * execute: platform hook is INJECTED (restorer(backupFile, version) → void).
 * Refuses without a hook: core never pretends the restore happened merely
 * because the plan was fine. Returns {from,to,restoredVia,ledger entry}.
 */
export async function executeRollback(installDir, { currentVersion = null, restorer = null, by = 'cli' } = {}) {
  if (typeof restorer !== 'function') {
    throw new RollbackError('no restorer injected — core proved the plan; the platform must provide the hook that replaces the binary (windows: installer flow / majin.bat rewrite). core will NOT guess your platform.', 'no_hook');
  }
  const plan = planRollback(installDir, { currentVersion });
  await restorer(plan.backupFile, plan.to);
  const ledgerDir = path.join(installDir, '.rollback');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const event = { at: new Date().toISOString(), type: 'rollback', by, from: plan.from, to: plan.to, backupFile: plan.backupFile, sha256: plan.sha256 };
  fs.appendFileSync(path.join(ledgerDir, 'ledger.jsonl'), JSON.stringify(event) + '\n');
  return { plan, event };
}

export function rollbackLedger(installDir) {
  try {
    return fs.readFileSync(path.join(installDir, '.rollback', 'ledger.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
