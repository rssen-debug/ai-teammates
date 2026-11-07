/** Small, dependency-free atomic checkpoint store.
 * Store only serializable task metadata. Never persist credentials here.
 * Writing a checkpoint is NOT evidence a side effect completed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function checkpointPath(root, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid checkpoint id');
  return path.join(root, id + '.json');
}
export function saveCheckpoint(root, id, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Checkpoint state must be an object');
  const destination = checkpointPath(root, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(root);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid checkpoint directory');
  try { const existing = fs.lstatSync(destination); if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe checkpoint destination'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = path.join(root, '.checkpoint-' + crypto.randomUUID() + '.tmp');
  const payload = JSON.stringify({ schema: 1, id, savedAt: new Date().toISOString(), state }, (_key, value) => {
    if (typeof value === 'bigint') throw new TypeError('Checkpoint BigInt unsupported');
    return value;
  });
  if (typeof payload !== 'string') throw new Error('Checkpoint serialization failed');
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Checkpoint too large');
  try {
    fs.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, destination);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return destination;
}
export function loadCheckpoint(root, id) {
  const directory = (() => { try { return fs.lstatSync(root); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
  if (!directory) return null;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid checkpoint directory');
  const file = checkpointPath(root, id);
  let data;
  const stat = (() => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid checkpoint file size');
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > 1024 * 1024) throw new Error('Invalid checkpoint file size');
      data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (data?.schema !== 1 || data?.id !== id || !data?.state || typeof data.state !== 'object' || Array.isArray(data.state)) throw new Error('Invalid checkpoint schema');
  return data;
}
