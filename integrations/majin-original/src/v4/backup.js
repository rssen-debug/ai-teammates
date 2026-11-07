/**
 * MAJIN V4 — backup, verify, restore.
 *
 * A private assistant accumulates things that cannot be recreated: conversations,
 * finished goals with their evidence, remembered preferences. Losing them to a
 * disk failure is a real user problem, and restoring a corrupted backup silently
 * is worse than refusing it.
 *
 * Format: a plain directory (inspectable everywhere, zero dependencies), the same
 * discipline as V2's audit bundle (`src/v2/audit/export.js`):
 *
 *   MANIFEST.json   { format, version, createdAt, app, stats, files:[{path,sha256,bytes}] }
 *   conversations/  goal files, conversations
 *   goals/
 *   memory/         MemoryStore namespaces, exported through its own exportAll()
 *
 * Honesty rules, enforced here rather than documented:
 *   - the HMAC key (`secret.key`), the pairing record and session records are
 *     NEVER included. A backup that carried the key would let anyone holding it
 *     forge sessions; a restore therefore requires pairing the phone again.
 *   - every manifest entry is hashed from the bytes actually written.
 *   - verify re-proves manifest ≡ files on disk and rejects any tampering.
 *   - restore refuses an unknown schema instead of guessing. That is the
 *     migration check: a future format must be migrated by code, not hoped for.
 *   - restore never overwrites existing data unless explicitly forced.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore, MEMORY_SCHEMA } from '../v2/memory/store.js';

export const BACKUP_FORMAT = 'majin-v4-backup';
export const BACKUP_VERSION = 1;

/** Files and dirs that must never leave the host inside a backup. */
export const FORBIDDEN = Object.freeze(['secret.key', 'pairing.json', 'sessions.json']);

/** Schema each restored JSON file must declare. Unknown = refuse, never guess. */
const SCHEMAS = {
  conversations: 'majin.v4.conversation/v1',
  goals: 'majin.v2.goal/v1',
};

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Write a backup bundle.
 * @returns {{dir:string, files:number, bytes:number, manifest:string}}
 */
export function createBackup({ home, out, now = () => Date.now() } = {}) {
  if (!home) throw new BackupError('NO_HOME', 'home (the MAJIN data dir) is required');
  if (!out) throw new BackupError('NO_OUT', 'a destination directory is required');
  const root = path.join(home, 'v4');
  if (!fs.existsSync(root)) throw new BackupError('NO_DATA', `nothing to back up: ${root} does not exist`);
  const dest = path.resolve(out);
  // Refuse only what would be recursive or copied into its own source: the live
  // V4 root. A sibling folder such as <data>/v4-backups is the intended target.
  const live = path.resolve(root);
  if (dest === live || dest.startsWith(live + path.sep)) {
    throw new BackupError('REFUSED', 'the backup destination must not be inside the live V4 data directory');
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  const files = [];

  // conversations + goals: copy bytes as they are (they are the source of truth)
  for (const kind of ['conversations', 'goals']) {
    const src = path.join(root, kind);
    for (const rel of walk(src)) {
      const buf = fs.readFileSync(path.join(src, rel));
      const target = path.join(dest, kind, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, buf, { mode: 0o600 });
      files.push({ path: `${kind}/${rel}`, sha256: sha256(buf), bytes: buf.length });
    }
  }

  // memory: through the V2 store's own export, so the shape stays its contract
  const memoryDir = path.join(root, 'memory');
  if (fs.existsSync(memoryDir)) {
    const exported = new MemoryStore(memoryDir).exportAll();
    const buf = Buffer.from(`${JSON.stringify(exported, null, 2)}\n`, 'utf8');
    const target = path.join(dest, 'memory', 'export.json');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, buf, { mode: 0o600 });
    files.push({ path: 'memory/export.json', sha256: sha256(buf), bytes: buf.length, schema: MEMORY_SCHEMA });
  }

  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(now()).toISOString(),
    app: 'majin-v4',
    note: 'Contains conversations, goals and memory. Never contains keys, pairing codes or sessions.',
    stats: {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      conversations: files.filter((f) => f.path.startsWith('conversations/')).length,
      goals: files.filter((f) => f.path.startsWith('goals/')).length,
    },
    files,
  };
  fs.writeFileSync(path.join(dest, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  // Belt and suspenders: refuse to have written anything forbidden.
  const leaked = walk(dest).filter((rel) => FORBIDDEN.some((f) => path.basename(rel) === f));
  if (leaked.length) {
    throw new BackupError('LEAKED_SECRET', `refusing to finish: backup contains ${leaked.join(', ')}`);
  }

  return { dir: dest, files: files.length, bytes: manifest.stats.bytes, manifest: path.join(dest, 'MANIFEST.json') };
}

/**
 * Re-prove a bundle against its own manifest.
 * @returns {{ok:boolean, verdict:string, problems:string[], manifest:object|null}}
 */
export function verifyBackup(dir) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  } catch {
    return { ok: false, verdict: 'UNFORMATTED', problems: ['MANIFEST.json is missing or unreadable'], manifest: null };
  }
  if (manifest.format !== BACKUP_FORMAT) {
    return { ok: false, verdict: 'UNTRUSTED_FORMAT', problems: [`unknown format: ${manifest.format}`], manifest };
  }
  if (!Number.isInteger(manifest.version) || manifest.version > BACKUP_VERSION) {
    problems.push(`backup version ${manifest.version} is newer than this MAJIN (${BACKUP_VERSION}); upgrade first`);
    return { ok: false, verdict: 'UNSUPPORTED_VERSION', problems, manifest };
  }
  if (!Array.isArray(manifest.files)) return { ok: false, verdict: 'UNFORMATTED', problems: ['manifest has no files list'], manifest };

  const listed = new Set();
  for (const entry of manifest.files) {
    listed.add(entry.path);
    const file = path.join(dir, entry.path);
    if (!fs.existsSync(file)) {
      problems.push(`missing: ${entry.path}`);
      continue;
    }
    const buf = fs.readFileSync(file);
    if (buf.length !== entry.bytes) problems.push(`size mismatch: ${entry.path} (${buf.length} != ${entry.bytes})`);
    if (sha256(buf) !== entry.sha256) problems.push(`hash mismatch: ${entry.path}`);
  }

  // Anything present but unlisted was not covered by the manifest.
  for (const rel of walk(dir)) {
    if (rel === 'MANIFEST.json') continue;
    if (!listed.has(rel)) problems.push(`unlisted file: ${rel}`);
  }

  // A bundle must never carry secrets, whatever its manifest says.
  for (const rel of walk(dir)) {
    if (FORBIDDEN.some((f) => path.basename(rel) === f)) problems.push(`forbidden file: ${rel}`);
  }

  return {
    ok: problems.length === 0,
    verdict: problems.length === 0 ? 'BUNDLE_OK' : (problems.some((p) => p.startsWith('hash') || p.startsWith('size')) ? 'BUNDLE_TAMPERED' : 'BUNDLE_INCOMPLETE'),
    problems,
    manifest,
  };
}

function assertSchema(kind, file) {
  const expected = SCHEMAS[kind];
  if (!expected) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new BackupError('INVALID_JSON', `${path.basename(file)} is not valid JSON`);
  }
  if (data?.schema !== expected) {
    throw new BackupError(
      'UNKNOWN_SCHEMA',
      `${path.basename(file)} declares schema "${data?.schema ?? 'none'}", expected "${expected}". Refusing to guess — write a migration first.`,
    );
  }
}

/**
 * Restore into a data dir.
 * @returns {{restored:number, dryRun:boolean, target:string, skipped:string[]}}
 */
export function restoreBackup({ bundle, home, force = false, dryRun = false } = {}) {
  if (!bundle) throw new BackupError('NO_BUNDLE', 'bundle directory is required');
  if (!home) throw new BackupError('NO_HOME', 'home (the MAJIN data dir) is required');
  const check = verifyBackup(bundle);
  if (!check.ok) {
    throw new BackupError('BUNDLE_REJECTED', `refusing to restore: ${check.verdict} — ${check.problems.slice(0, 3).join('; ')}`);
  }

  const root = path.join(home, 'v4');
  const target = {
    conversations: path.join(root, 'conversations'),
    goals: path.join(root, 'goals'),
    memory: path.join(root, 'memory'),
  };

  // Dry run: validate schemas and collisions, write nothing.
  const restored = [];
  const skipped = [];
  for (const entry of check.manifest.files) {
    const [kind, ...rest] = entry.path.split('/');
    if (kind === 'memory') continue; // handled by the memory store below
    if (!SCHEMAS[kind]) {
      skipped.push(entry.path);
      continue;
    }
    const source = path.join(bundle, entry.path);
    assertSchema(kind, source);
    const dest = path.join(target[kind], ...rest);
    if (fs.existsSync(dest) && !force) {
      throw new BackupError('ALREADY_EXISTS', `${path.relative(root, dest)} already exists; pass --force to overwrite`);
    }
    restored.push({ from: source, to: dest });
  }

  if (dryRun) {
    return { restored: restored.length, dryRun: true, target: root, skipped };
  }

  for (const item of restored) {
    fs.mkdirSync(path.dirname(item.to), { recursive: true, mode: 0o700 });
    const tmp = `${item.to}.restore-${process.pid}`;
    fs.copyFileSync(item.from, tmp);
    fs.renameSync(tmp, item.to);
  }

  const memoryFile = path.join(bundle, 'memory', 'export.json');
  if (fs.existsSync(memoryFile)) {
    const exported = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    if (exported?.schema !== MEMORY_SCHEMA) {
      throw new BackupError('UNKNOWN_SCHEMA', `memory export declares "${exported?.schema}", expected "${MEMORY_SCHEMA}"`);
    }
    const store = new MemoryStore(target.memory);
    for (const [kind, entries] of Object.entries(exported.kinds || {})) {
      for (const entry of entries) {
        try {
          store.put(kind, {
            key: entry.key,
            text: entry.text,
            tags: entry.tags || [],
            importance: entry.importance ?? 0.5,
            meta: entry.meta ?? null,
          });
        } catch {
          /* a single unusable entry must not abort the whole restore */
        }
      }
    }
  }

  return { restored: restored.length, dryRun: false, target: root, skipped };
}
