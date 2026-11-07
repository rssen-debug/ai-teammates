/**
 * V2 executable whitelist (master brief sections 49-52: normalized, persistent).
 *
 * The core lesson embedded from the public bypass advisory (PraisonAI
 * GHSA-vjv9-7m7j-h833): whitelisting only the FIRST token of a chained shell
 * line is worthless. Every executable in every chain segment is extracted and
 * must be whitelisted, else the whole line is denied.
 */
import fs from 'node:fs';
import path from 'node:path';

/** split a command line into segments on shell control operators (naive on purpose; payloads inside strings are still caught by preflight) */
export function chainSegments(command) {
  return command.split(/;|&&|\|\||\||&/).map((s) => s.trim()).filter(Boolean);
}

/** normalize an executable: basename, lowercase, strip common win extensions (sections 50-51) */
export function normalizeExecutable(token) {
  if (!token) return '';
  let t = token.trim().replace(/^["']|["']$/g, '');
  t = t.replace(/\\/g, '/');
  t = t.split('/').pop();
  t = t.toLowerCase();
  t = t.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
  return t;
}

/** executable token of a chain segment (first whitespace token, env assignments skipped) */
export function segmentExecutable(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // env assignment prefix like PATH=...
    return normalizeExecutable(tok);
  }
  return '';
}

/** every executable in a full command line */
export function executablesOf(command) {
  return chainSegments(command).map(segmentExecutable).filter(Boolean);
}

const SAFE_BASELINE = [
  'node', 'npm', 'npx', 'git', 'echo', 'cat', 'ls', 'dir', 'pwd', 'whoami',
  'grep', 'find', 'mkdir', 'cp', 'mv', 'copy', 'type', 'python', 'python3', 'rm', 'del', 'rmdir',
  'ffmpeg', 'ffprobe',
];

export class Whitelist {
  constructor(filePath, events, { baseline = SAFE_BASELINE } = {}) {
    this.filePath = filePath;
    this.events = events;
    this.entries = new Set(baseline);
    if (filePath && fs.existsSync(filePath)) {
      try { for (const e of JSON.parse(fs.readFileSync(filePath, 'utf8'))) this.entries.add(e); } catch { /* corrupt whitelist file falls back to baseline, logged by caller */ }
    }
  }

  persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.entries].sort(), null, 2));
  }

  add(executable) {
    const n = normalizeExecutable(executable);
    this.entries.add(n);
    this.persist();
    this.events?.emit('task.updated', { taskId: `whitelist:${n}`, to: 'added', type: this.constructor.name });
    return n;
  }

  remove(executable) {
    const n = normalizeExecutable(executable);
    this.entries.delete(n);
    this.persist();
    this.events?.emit('task.updated', { taskId: `whitelist:${n}`, to: 'removed', type: this.constructor.name });
  }

  /** auditable verdict per command line: which executables failed the list */
  check(command) {
    const found = executablesOf(command);
    const missing = found.filter((e) => !this.entries.has(e));
    return { executables: found, missing, allowed: missing.length === 0 };
  }
}
