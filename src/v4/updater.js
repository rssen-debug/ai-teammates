/**
 * MAJIN V4 — signed-release updater.
 *
 * The requirement was explicit: approved releases install and activate without
 * the owner opening PowerShell again. That is only defensible if an update is
 * *provably* the release the owner approved — otherwise an auto-updater is a
 * remote code execution hole with a progress bar.
 *
 * The chain, and what makes each link trustworthy:
 *
 *   GitHub release  ->  a JSON manifest listing files with their SHA-256
 *   manifest        ->  detached Ed25519 signature by a key the owner pinned
 *                       at install time (public key on disk, private never here)
 *   files           ->  every file re-hashed after download; a mismatch aborts
 *                       the whole update before anything is written
 *   install         ->  staged beside the live tree, then swapped in one rename
 *   activation      ->  the supervisor restarts the host and health-checks it
 *   failure         ->  restore the previous directory and restart it
 *
 * What this deliberately does NOT do: it does not run `git pull`, it does not
 * accept a release without a signature, and it does not update itself. The
 * updater is a separate process precisely so a bad release cannot break the
 * thing that would fix it.
 *
 * Unsigned mode exists for a local test (`allowUnsigned`), is refused when a key
 * is pinned, and is recorded in the audit line so it cannot pass unnoticed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPDATER_SCHEMA = 'majin.v4.release/v1';
export const KEY_SCHEMA = 'majin.v4.release-key/v1';
export const UPDATE_CONFIG_SCHEMA = 'majin.v4.update-config/v1';

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

/* --------------------------------------------------------------- keys ----- */

/** Write the public key the owner pinned. 0644 is fine: it is public. */
export function pinKey(file, publicKeyPem) {
  if (!/-----BEGIN PUBLIC KEY-----/.test(String(publicKeyPem))) {
    throw new UpdateError('BAD_KEY', 'that is not a PEM public key');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: KEY_SCHEMA, pinnedAt: new Date().toISOString(), publicKey: publicKeyPem }, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

export function readPinnedKey(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.schema !== KEY_SCHEMA || typeof data.publicKey !== 'string') return null;
    return data.publicKey;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- update channel -- */

/**
 * Where unattended updates come from, and whether they are allowed.
 *
 * A scheduled task starts with no environment, so the release URL cannot live
 * only in `MAJIN_V4_RELEASE_URL`. This file is the durable answer: written once
 * by setup, read by both the CLI and the scheduled task. Only https is allowed
 * (http is accepted for loopback so the release-flow test can run locally).
 */
function validReleaseUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function readUpdateConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.schema !== UPDATE_CONFIG_SCHEMA) return null;
    return {
      releaseUrl: validReleaseUrl(raw.releaseUrl) ? raw.releaseUrl : null,
      auto: Boolean(raw.auto),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time || '')) ? raw.time : '04:00',
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return null;
  }
}

export function writeUpdateConfig(file, { releaseUrl = null, auto = false, time = '04:00' } = {}) {
  if (releaseUrl != null && !validReleaseUrl(releaseUrl)) {
    throw new UpdateError('BAD_RELEASE_URL', 'releaseUrl must be https:// (http is only allowed for loopback testing)');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
    throw new UpdateError('BAD_UPDATE_TIME', 'time must be HH:MM in 24-hour form, e.g. 04:00');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    schema: UPDATE_CONFIG_SCHEMA,
    releaseUrl: releaseUrl || null,
    auto: Boolean(auto),
    time,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/* ----------------------------------------------------------- manifests ---- */

/**
 * The exact bytes that are signed.
 *
 * A manifest is data; signing `JSON.stringify(parsed)` would make the signature
 * depend on key order and whitespace. The canonical form is the fields that
 * decide what gets installed, in a fixed order, with a fixed separator.
 */
export function canonicalManifest(manifest) {
  const files = [...(manifest.files || [])]
    .map((f) => ({ path: String(f.path), sha256: String(f.sha256).toLowerCase(), bytes: Number(f.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return [
    manifest.schema,
    manifest.version,
    manifest.commit,
    String(manifest.publishedAt || ''),
    ...files.map((f) => `${f.path}:${f.sha256}:${f.bytes}`),
  ].join('\n');
}

/** Verify a detached Ed25519 signature over the canonical manifest. */
export function verifyManifest(manifest, signatureB64, publicKeyPem) {
  if (manifest?.schema !== UPDATER_SCHEMA) throw new UpdateError('BAD_SCHEMA', `unknown manifest schema: ${manifest?.schema}`);
  if (!publicKeyPem) throw new UpdateError('NO_KEY', 'no release key is pinned on this machine');
  if (!signatureB64) throw new UpdateError('UNSIGNED', 'the release has no signature');
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(canonicalManifest(manifest), 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(String(signatureB64), 'base64'),
    );
  } catch (err) {
    throw new UpdateError('BAD_KEY', `could not verify the signature: ${err.message}`);
  }
  if (!ok) throw new UpdateError('BAD_SIGNATURE', 'the signature does not match this manifest');
  return true;
}

/** Sign a manifest (used by the release tooling, not by the host). */
export function signManifest(manifest, privateKeyPem) {
  return crypto.sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

/* ------------------------------------------------------------- install ---- */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Walk a directory into `relative/path -> sha256` for the manifest. */
export function hashTree(dir, { skip = [] } = {}) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        out.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Decide whether a release may be applied, without touching the disk.
 * Returns a plan the caller can print, or throws with the reason.
 */
export function planUpdate({ manifest, signature, publicKey, currentVersion, allowUnsigned = false, allowDowngrade = false } = {}) {
  if (allowUnsigned && !signature) {
    if (publicKey) throw new UpdateError('REFUSED', 'a release key is pinned; an unsigned update is not allowed');
    if (manifest?.schema !== UPDATER_SCHEMA) throw new UpdateError('BAD_SCHEMA', 'unknown manifest schema');
  } else {
    verifyManifest(manifest, signature, publicKey);
  }

  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new UpdateError('BAD_VERSION', `invalid version: ${manifest.version}`);
  }
  if (currentVersion && manifest.version === currentVersion) {
    return { action: 'noop', version: manifest.version, reason: 'already on this version' };
  }
  if (currentVersion && !allowDowngrade && compareVersions(manifest.version, currentVersion) < 0) {
    throw new UpdateError('DOWNGRADE_REFUSED', `${manifest.version} is older than ${currentVersion}`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) throw new UpdateError('EMPTY_RELEASE', 'the release lists no files');
  return {
    action: 'install',
    version: manifest.version,
    commit: manifest.commit || null,
    files: files.length,
    bytes: files.reduce((n, f) => n + (Number(f.bytes) || 0), 0),
    unsigned: Boolean(allowUnsigned && !signature),
  };
}

export function compareVersions(a, b) {
  const norm = (v) => String(v).split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [a1, a2, a3] = norm(a);
  const [b1, b2, b3] = norm(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

/**
 * Write a verified release into a staging directory.
 *
 * Every buffer is hashed BEFORE it is written, so a tampered file never lands on
 * disk at all — not even briefly.
 */
export function stageRelease({ manifest, readFile, stagingDir }) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const written = [];
  for (const entry of manifest.files) {
    const buf = readFile(entry.path);
    if (!buf || buf.length !== Number(entry.bytes)) {
      throw new UpdateError('SIZE_MISMATCH', `${entry.path}: expected ${entry.bytes} bytes`);
    }
    const got = sha256(buf);
    if (got !== String(entry.sha256).toLowerCase()) {
      throw new UpdateError('HASH_MISMATCH', `${entry.path}: hash does not match the manifest`);
    }
    const target = path.join(stagingDir, ...entry.path.split('/'));
    if (path.dirname(path.resolve(target)).startsWith(path.resolve(stagingDir)) === false) {
      throw new UpdateError('PATH_ESCAPE', `${entry.path} escapes the staging directory`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, buf, { mode: 0o600 });
    written.push(entry.path);
  }
  return { stagingDir, files: written };
}

/**
 * Swap the staged release in, keeping the previous tree for rollback.
 *
 * Two renames, not a merge: the old tree is moved aside whole, the new one moved
 * in whole. A half-installed state is therefore impossible.
 */
export const UPDATE_JOURNAL = 'update-journal.json';
export const UPDATE_JOURNAL_SCHEMA = 'majin.v4.update-journal/v1';

function walkRelative(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkRelative(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function writeFileAtomic(target, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.majin-new-${process.pid}`;
  fs.writeFileSync(tmp, bytes, { mode });
  fs.renameSync(tmp, target);
}

/**
 * Activate a staged release by overlaying it on the live tree, file by file.
 *
 * The first design renamed the whole live directory away and the staged tree
 * in. That deleted `node_modules` and `.git` (a release ships source, not an
 * installation), so a successful update produced a host that could not boot —
 * and moving the dependencies aside first created a window where a crash left
 * the installation unstartable.
 *
 * The overlay never moves anything out of the live tree. Every file that will
 * be replaced is copied to `backupDir` first (the rollback copy); then each
 * staged file is written through a temp file and a rename, so a reader sees
 * either the old bytes or the new ones, never a half-written file. A journal
 * lists the plan, and recovery can therefore restore the previous version even
 * if the process is killed between any two files.
 *
 * What this deliberately does not do: delete files that the new release no
 * longer ships. A stale module is inert; deleting the wrong path is not.
 */
export function activateRelease({ liveDir, stagingDir, backupDir }) {
  const files = walkRelative(stagingDir);
  if (!files.length) throw new UpdateError('EMPTY_RELEASE', 'the staged release contains no files');
  const journalFile = path.join(path.dirname(backupDir), UPDATE_JOURNAL);
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });

  const replaced = files.filter((rel) => fs.existsSync(path.join(liveDir, rel)));
  const added = files.filter((rel) => !fs.existsSync(path.join(liveDir, rel)));
  const journal = {
    schema: UPDATE_JOURNAL_SCHEMA,
    liveDir,
    stagingDir,
    backupDir,
    phase: 'overlay',
    files,
    replaced,
    added,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));

  // 1. Save every file the release will overwrite. Nothing is written to the
  //    live tree before this list is complete.
  for (const rel of replaced) {
    const target = path.join(backupDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(liveDir, ...rel.split('/')), target);
  }

  // 2. Overlay. Per-file atomic; a crash leaves a mix of old and new files,
  //    which the journal can undo.
  for (const rel of files) {
    const from = path.join(stagingDir, ...rel.split('/'));
    const to = path.join(liveDir, ...rel.split('/'));
    writeFileAtomic(to, fs.readFileSync(from));
  }

  return { liveDir, backupDir, preserved: [], journalFile, files, replaced, added };
}

/** Put the previous tree back. Used when the new host fails its health check. */
export function rollbackRelease({ liveDir, backupDir, preserved = [], journalFile = null, added = null }) {
  void preserved; // older callers passed renamed entries; the overlay keeps them in place
  if (!backupDir || !fs.existsSync(backupDir)) throw new UpdateError('NO_BACKUP', 'there is no previous release to roll back to');
  const backups = walkRelative(backupDir);
  for (const rel of backups) {
    const from = path.join(backupDir, ...rel.split('/'));
    const to = path.join(liveDir, ...rel.split('/'));
    writeFileAtomic(to, fs.readFileSync(from));
  }
  // Files the failed release introduced do not belong to the restored version.
  for (const rel of added || []) {
    const target = path.join(liveDir, ...String(rel).split('/'));
    if (!fs.existsSync(path.join(backupDir, ...String(rel).split('/')))) {
      fs.rmSync(target, { force: true });
    }
  }
  if (journalFile) fs.rmSync(journalFile, { force: true });
  return { liveDir, restored: true, files: backups.length };
}

/**
 * Finish or undo an update that did not complete.
 *
 * The journal is written before a single live file is touched. If the updater
 * dies at any point afterwards, the next run restores every backed-up file and
 * deletes the files the release added — a half-updated install is never
 * treated as current.
 */
export function recoverInterruptedUpdate({ liveDir, backupDir }) {
  const journalFile = path.join(path.dirname(backupDir), UPDATE_JOURNAL);
  if (!fs.existsSync(journalFile)) return { recovered: false };
  let journal = null;
  try {
    journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  } catch {
    fs.rmSync(journalFile, { force: true });
    return { recovered: false, reason: 'unreadable journal was discarded' };
  }
  try {
    if (journal.backupDir && fs.existsSync(journal.backupDir)) {
      rollbackRelease({
        liveDir: journal.liveDir || liveDir,
        backupDir: journal.backupDir,
        journalFile,
        added: journal.added || [],
      });
      return { recovered: true, action: 'restored the previous release' };
    }
    fs.rmSync(journalFile, { force: true });
    return { recovered: false, reason: 'no previous release to restore' };
  } catch (err) {
    return { recovered: false, error: String(err?.message || err) };
  }
}

/**
 * The whole update, with the injection points a test needs.
 *
 * `fetchManifest`, `fetchFile` and `restartHost` are supplied by the caller (the
 * CLI wires them to GitHub and the supervisor). Nothing here does network I/O
 * itself, so every branch is testable without a network.
 */
export async function runUpdate({
  manifest,
  signature,
  publicKey,
  currentVersion,
  liveDir,
  stagingDir,
  backupDir,
  readFile,
  restartHost,
  healthCheck,
  allowUnsigned = false,
  log = () => {},
} = {}) {
  const plan = planUpdate({ manifest, signature, publicKey, currentVersion, allowUnsigned });
  if (plan.action === 'noop') {
    log('noop', { version: plan.version });
    return { status: 'NOOP', ...plan };
  }
  log('planned', plan);

  const staged = stageRelease({ manifest, readFile, stagingDir });
  log('staged', { files: staged.files.length });

  const activated = activateRelease({ liveDir, stagingDir, backupDir });
  log('activated', { liveDir });

  let healthy = false;
  try {
    healthy = await restartHost();
  } catch (err) {
    log('restart_failed', { error: String(err?.message || err) });
    healthy = false;
  }
  if (healthy && typeof healthCheck === 'function') {
    try {
      healthy = await healthCheck();
    } catch {
      healthy = false;
    }
  }

  if (!healthy) {
    log('unhealthy', { version: plan.version });
    if (activated.backupDir) {
      rollbackRelease({
        liveDir: activated.liveDir,
        backupDir: activated.backupDir,
        journalFile: activated.journalFile || null,
        added: activated.added || [],
      });
      log('rolled_back', { to: currentVersion || null });
      try {
        await restartHost();
      } catch { /* the caller reports this */ }
      return { status: 'ROLLED_BACK', version: plan.version, reason: 'the new version failed its health check' };
    }
    return { status: 'FAILED', version: plan.version, reason: 'the new version failed and there was no previous release' };
  }

  if (activated.journalFile) fs.rmSync(activated.journalFile, { force: true });
  log('updated', { version: plan.version, commit: plan.commit });
  return { status: 'UPDATED', version: plan.version, commit: plan.commit, unsigned: plan.unsigned };
}
