#!/usr/bin/env node
/**
 * Put the M icon inside a Windows executable, so the taskbar shows the logo.
 *
 * Nothing here is trusted: the file must start with `MZ` and the .ico with an
 * icon header, resedit must be installed, and the result is re-parsed before the
 * backup is removed. Any failure restores the original byte-for-byte -- a plain
 * icon-less MAJIN is fine, a corrupt exe is not. That is also why a missing
 * resedit is a note and not an error: `npm ci` in CI installs it, a bare
 * checkout without dev deps must still build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function embedIcon(o = {}) {
  const exe = o.exe;
  const ico = o.ico;
  const bail = (code, extra) => ({ ok: false, code, ...extra });
  if (!exe || !fs.existsSync(exe)) return bail('no_exe', { error: `no such file: ${exe}` });
  if (!ico || !fs.existsSync(ico)) return bail('no_ico', { error: `no such icon: ${ico}` });
  const buf = fs.readFileSync(exe);
  if (buf.length < 4096 || buf.readUInt16LE(0) !== 0x5a4d) return bail('not_pe', { error: 'the target is not a PE executable (no MZ header)' });
  const icoBuf = fs.readFileSync(ico);
  if (icoBuf.length < 22 || icoBuf.readUInt16LE(0) !== 0 || icoBuf.readUInt16LE(2) !== 1) return bail('not_ico', { error: 'the .ico does not look like an icon file' });
  let ResEdit;
  try {
    ResEdit = require('resedit');
  } catch {
    return bail('no_resedit', { hint: 'npm i -D resedit, or MAJIN_NO_ICON=1 to skip embedding' });
  }
  const bak = exe + '.majin-bak';
  fs.writeFileSync(bak, buf);
  const restore = () => {
    try {
      fs.copyFileSync(bak, exe);
      fs.rmSync(bak, { force: true });
    } catch { /* the caller still has its original file */ }
  };
  try {
    const nt = ResEdit.NtExecutable.from(buf, { ignoreInvalidMemberLayout: true });
    const res = ResEdit.NtExecutableResource.from(nt);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const id = o.iconId ?? (groups.length ? groups[0].id : 1);
    const iconFile = ResEdit.Data.IconFile.from(icoBuf);
    const icons = (iconFile.icons || []).map((i) => i.data);
    if (!icons.length) {
      restore();
      return bail('empty_ico', { error: 'the .ico holds no images' });
    }
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, 1033, icons);
    res.outputResource(nt);
    const out = Buffer.from(nt.generate());
    fs.writeFileSync(exe, out);
    const again = ResEdit.NtExecutable.from(fs.readFileSync(exe));
    const res2 = ResEdit.NtExecutableResource.from(again);
    const groups2 = ResEdit.Resource.IconGroupEntry.fromEntries(res2.entries);
    if (!groups2.length) {
      restore();
      return bail('verify_failed', { error: 'the patched exe no longer has an icon group; the original is back in place' });
    }
    fs.rmSync(bak, { force: true });
    return { ok: true, code: 'ok', id, sizes: icons.length, bytes: out.length, file: path.basename(exe) };
  } catch (err) {
    restore();
    return bail('patch_failed', { error: String(err && err.message ? err.message : err).slice(0, 200), restored: true });
  }
}

/* WINDOWS TRAP: new URL(...).pathname gives /D:/a/... which never equals a
   real Windows path — the guard was silently FALSE on Windows for two
   releases and the exe shipped with the default icon ("icon: no output").
   fileURLToPath is the only honest comparison. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const o = { exe: a[0], ico: a[1] };
  for (const arg of a.slice(2)) {
    const m = /^--icon-id=(\d+)$/.exec(arg);
    if (m) o.iconId = Number(m[1]);
  }
  const r = embedIcon(o);
  process.stdout.write(
    r.ok
      ? `icon: ${r.file} now carries ${r.sizes} size(s) at id ${r.id} (${r.bytes} bytes)\n`
      : `icon: ${r.code}${r.error ? ' -- ' + r.error : ''}${r.hint ? ' (' + r.hint + ')' : ''}\n`,
  );
  process.exit(r.ok || a.includes('--tolerant') || r.code === 'no_resedit' ? 0 : 1);
}
