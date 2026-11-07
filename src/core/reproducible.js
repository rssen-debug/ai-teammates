/**
 * MAJIN W14 — reproducible build content hash (file-true proof).
 *
 * Scope honesty stated first, because binary-exe reproducibility across
 * machines is a DIFFERENT problem: pkg resedit/NT-signing timestamps and
 * npm tarballs-of-dependencies make bit-exact exe reproducibility nontrivial
 * — currently NOT TESTED in this pipeline. What THIS module proves is the
 * deterministic base every reproducible build stands on: the TRACTED source
 * set (git ls-files) always yields the identical manifest hash — same repo,
 * same hash, any machine, any time of day. If that hash wobbles, every
 * build on top of it is fiction.
 *
 * Deterministic recipe: for each tracked file, sorted by (byte-ordered) path:
 *   sha256( <path>\0 <mode>\0 <size>\0 sha256(content) )
 * folded into one rolling manifest hash. Excludes .git and untracked
 * content by construction (ls-files is the truth).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const REPRO_VERSION = 'majin-reproducible/1';

export function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', shell: false });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr?.toString().slice(0, 200) || r.status}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

function fileDigest(abs) {
  const stat = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  const mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
  return { mode, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** rolling manifest sha256 over the tracked set — deterministic per repo state. */
export function manifestHash(root, { onFile = null } = {}) {
  const files = trackedFiles(root);
  const h = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const d = fileDigest(abs);
    totalBytes += d.size;
    h.update(rel, 'utf8'); h.update('\0');
    h.update(d.mode); h.update('\0');
    h.update(String(d.size)); h.update('\0');
    h.update(d.sha256);
    onFile?.(rel, d);
  }
  return {
    version: REPRO_VERSION,
    files: files.length,
    bytes: totalBytes,
    sha256: h.digest('hex'),
  };
}

/** run the proof: two independent computes MUST be identical. */
export function reproducibilityProof(root) {
  const a = manifestHash(root);
  const b = manifestHash(root);
  return {
    version: REPRO_VERSION,
    rootChecked: root,
    files: a.files, bytes: a.bytes,
    hashA: a.sha256, hashB: b.sha256,
    identical: a.sha256 === b.sha256,
    binaryExeReproducibilityScope: 'NOT TESTED — pkg/NT-signing/npm-tarball timestamps make bit-exact exe reproducibility a separate pipeline item (stated, not hidden)',
  };
}
