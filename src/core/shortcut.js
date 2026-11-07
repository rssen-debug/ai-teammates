/**
 * MAJIN — skrivbordsgenvagen for en fristande exe.
 * Den som dubbelklickar pa majin-win-x64.exe ska slippa gora nagot mer: en
 * genvag med M-ikonen laggs pa skrivbordet, och den kan tas bort igen.
 * Allt byggs som ett synligt PowerShell-skript sa att anvandaren (och testerna)
 * kan se exakt vad som koms koras — och `print`-atgarden ror ingenting alls.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9 _()-]{1,40}$/;

export function shortcutName(name) {
  const n = String(name == null ? 'MAJIN' : name).trim();
  return NAME_RE.test(n) ? n : 'MAJIN';
}

/** PowerShell ekar enkeltcitata genom att dubbla dem — inget annat. */
export function quotePs(value) {
  return String(value == null ? '' : value).split("'").join("''");
}

export function desktopDir(env = process.env, homedir = os.homedir()) {
  const cands = [];
  if (env.USERPROFILE) cands.push(path.join(env.USERPROFILE, 'Desktop'));
  cands.push(path.join(homedir, 'Desktop'), path.join(homedir, 'OneDrive', 'Desktop'), path.join(homedir, 'Skrivbord'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* hoppa over */ }
  }
  return cands[cands.length - 2];
}

export function shortcutFile({ name = 'MAJIN', dir } = {}) {
  return path.join(dir || desktopDir(), shortcutName(name) + '.lnk');
}

/** Vad genvagen ska peka pa: exe:n sjalv, annars installerad launcher, annars node + klan. */
export function pickTarget(o = {}) {
  const local = o.env || process.env;
  if (process.pkg) return { target: o.target || process.execPath, args: 'start' };
  const cmd = path.join(local.LOCALAPPDATA || '', 'MAJIN', 'bin', 'majin.cmd');
  if (local.LOCALAPPDATA && fs.existsSync(cmd)) return { target: cmd, args: '' };
  const cli = o.cli || path.resolve(process.execPath, '..', '..', 'src', 'cli', 'majin.js');
  const repoCli = (() => { try { return path.resolve(process.cwd(), 'src', 'cli', 'majin.js'); } catch { return ''; } })();
  const use = fs.existsSync(repoCli) ? repoCli : cli;
  return { target: process.execPath, args: ' start "' + use.replace(/"/g, '') + '"' };
}

export function psCreate(o = {}) {
  const file = o.file || shortcutFile(o);
  const t = o.target ? { target: o.target, args: o.args || '' } : pickTarget(o);
  const icon = o.icon || t.target;
  const working = o.working || path.dirname(t.target);
  const desc = o.description || 'MAJIN — your own agent, on this machine';
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${quotePs(file)}')`,
    `$s.TargetPath = '${quotePs(t.target)}'`,
    `$s.Arguments = '${quotePs(t.args)}'`,
    `$s.WorkingDirectory = '${quotePs(working)}'`,
    `$s.IconLocation = '${quotePs(icon)},0'`,
    `$s.Description = '${quotePs(desc)}'`,
    '$s.WindowStyle = 1',
    '$s.Save()',
  ].join('; ');
}

export function psRemove(o = {}) {
  const file = o.file || shortcutFile(o);
  return `Remove-Item -LiteralPath '${quotePs(file)}' -Force -ErrorAction SilentlyContinue`;
}

/**
 * @param {object} o
 * @param {'create'|'remove'|'print'} [o.action]
 * @param {boolean} [o.dry]  kor inte, bara visa (print implied for testerna)
 */
export function shortcutAction(o = {}) {
  const action = o.action || 'create';
  const file = o.file || shortcutFile(o);
  const script = action === 'remove' ? psRemove({ ...o, file }) : psCreate({ ...o, file });
  const exists = (() => { try { return fs.existsSync(file); } catch { return false; } })();
  const out = { action, file, script, exists, windows: process.platform === 'win32' };
  if (action === 'print' || o.dry === true || process.env.MAJIN_DRY_RUN === '1') return { ...out, ok: true, ran: false };
  if (process.platform !== 'win32') {
    return { ...out, ok: false, ran: false, code: 'not_windows', error: 'a .lnk only exists on Windows — this is the command that would run', };
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) {
    return { ...out, ok: false, ran: true, code: 'powershell_failed', error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
  }
  return { ...out, ok: true, ran: true, summary: `${action === 'remove' ? 'removed' : 'created'} ${path.basename(file)}` };
}
