#!/usr/bin/env node
/**
 * Build `majin-setup.exe` — the double-click installer.
 *
 * Why this exists next to the pkg build: pkg needs a prebuilt node host binary
 * fetched from github.com, so the single-file .exe can only be made where that
 * download works, and it is ~80 MB. The stub here is 90 KB of C that carries the
 * *bundle* (`dist/majin.cjs` + ui + rules + the icon) inside itself, writes it
 * into %LOCALAPPDATA%\MAJIN, unpacks with the `tar.exe` every Windows 10/11
 * already has, and hands over to `setup/setup.ps1` -- which is where node is
 * found or fetched. It cross-compiles with `zig cc`, no SDK, no admin, no
 * network at build time, so it can be built anywhere zig is, including a laptop
 * with no GitHub access at all.
 *
 *   node scripts/build-setup.mjs            # dist/setup/majin-setup.exe (+ manifest)
 *   node scripts/build-setup.mjs --host     # ... and a native one, for testing
 *   node scripts/build-setup.mjs --payload-only
 *
 * Zig is found via $ZIG ("python3 -m ziglang" works), then `zig` on PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'setup');
const stage = path.join(out, 'stage');
const payload = path.join(out, 'payload.tar.gz');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const payloadOnly = has('--payload-only');
const hostBuild = has('--host') || process.platform !== 'win32';

function sh(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

function fail(msg) {
  process.stderr.write(`build-setup: ${msg}\n`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// --- 1. the bundle -----------------------------------------------------------
const bundle = path.join(root, 'dist', 'majin.cjs');
if (!fs.existsSync(bundle) || has('--rebuild')) {
  const r = sh(process.execPath, [path.join(root, 'scripts', 'build-exe.mjs'), '--no-pkg']);
  process.stdout.write(r.stdout.split('\n').filter((l) => /bundle|error/i.test(l)).join('\n') + '\n');
  if (!fs.existsSync(bundle)) fail('the bundle did not appear: ' + (r.stderr || '').slice(0, 300));
}

// --- 2. stage dist/** + setup.ps1 -------------------------------------------
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
for (const name of ['majin.cjs', 'package.json', 'ui', 'rules']) {
  const src = path.join(root, 'dist', name);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(stage, 'dist', name), { recursive: true });
}
// only the icon from assets: the UI already ships its own logo in dist/ui, and
// every byte here is a byte the user downloads
fs.mkdirSync(path.join(stage, 'dist', 'assets'), { recursive: true });
for (const name of ['majin.ico', 'majin-256.png']) {
  const src = path.join(root, 'dist', 'assets', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, 'dist', 'assets', name));
}
fs.copyFileSync(path.join(root, 'setup', 'setup.ps1'), path.join(stage, 'setup.ps1'));
fs.writeFileSync(
  path.join(stage, 'INSTALL-NOTE.txt'),
  [
    `MAJIN ${pkg.version} — installed by majin-setup`,
    '',
    'Everything lives in this folder:',
    '  dist\\majin.cjs     the program (one file, no dependencies)',
    '  dist\\ui           the window it serves',
    '  dist\\rules        the RE rule set',
    '  dist\\assets\\majin.ico   the icon',
    '  bin\\majin.cmd     the command that runs it  (node + dist\\majin.cjs)',
    '  node\\node.exe     only if it had to be downloaded',
    '  setup.ps1         this installer, re-runnable:',
    '                      powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -DryRun',
    '  setup.ps1 -NoShortcut -NoStart -NoPath are the switches it understands.',
    'Uninstall: delete this folder, take "majin" off your user PATH, and remove',
    'the Desktop icon. Nothing else was touched.',
    '',
  ].join('\n'),
);

// --- 3. payload --------------------------------------------------------------
// Written here rather than with `tar -czf`, for two reasons: the release build
// runs on Windows where the tar flags differ, and gzip stores a timestamp, so
// every CI build of the same source would ship a different checksum. A ustar
// block with fixed metadata plus `zlib.gzip` (mtime 0) is byte-for-byte stable,
// which is what makes `certutil -hashfile` on the download meaningful.
function ustar(name, data, { dir = false } = {}) {
  if (name.length > 99) fail(`payload path too long for ustar: ${name}`);
  const field = (text, len) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(len)]).subarray(0, len);
  const oct = (n, len) => (n.toString(8).padStart(len - 1, '0') + '\0').padEnd(len, '\0');
  const mode = dir ? '755' : '644';
  const h = Buffer.alloc(512);
  let o = 0;
  const put = (buf) => { buf.copy(h, o); o += buf.length; };
  put(field(name, 100));
  put(field(oct(parseInt(mode, 8), 8), 8));
  put(field(oct(0, 8), 8)); // uid
  put(field(oct(0, 8), 8)); // gid
  put(field(oct(dir ? 0 : data.length, 12), 12));
  put(field(oct(946684800, 12), 12)); // 2000-01-01, never "now"
  put(Buffer.from('        ')); // checksum placeholder
  put(field(dir ? '5' : '0', 1));
  put(field('', 100)); // linkname
  put(field('ustar\0', 6));
  put(field('00', 2));
  put(field('majin', 32));
  put(field('majin', 32));
  put(field(oct(0, 8), 8));
  put(field(oct(0, 8), 8));
  put(Buffer.alloc(155));
  let sum = 0;
  for (const byte of h) sum += byte;
  field(oct(sum, 8) , 8).copy(h, 148);
  return [h, data && data.length ? Buffer.concat([data, Buffer.alloc(512 - (data.length % 512 || 512))]) : null].filter(Boolean);
}

fs.rmSync(payload, { force: true });
const entries = [];
const walk = (rel) => {
  const abs = path.join(stage, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    entries.push([...ustar(rel.replace(/\/+$/, '') + '/', null, { dir: true })].flat());
    for (const child of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, child));
    return;
  }
  entries.push(ustar(rel, fs.readFileSync(abs)));
};
for (const top of fs.readdirSync(stage).sort()) walk(top);
const tarBuf = Buffer.concat([...entries.flat(), Buffer.alloc(1024)]);
const bytes = zlib.gzipSync(tarBuf, { level: 9 });
fs.writeFileSync(payload, bytes);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, 'payload.h'),
  [
    '/* generated by scripts/build-setup.mjs -- do not edit */',
    '#ifndef MAJIN_PAYLOAD_H',
    '#define MAJIN_PAYLOAD_H',
    `#define MAJIN_VERSION "${pkg.version}"`,
    `#define MAJIN_PAYLOAD_LEN ${bytes.length}UL`,
    `#define MAJIN_PAYLOAD_SHA256 "${sha}"`,
    `static const unsigned char MAJIN_PAYLOAD[MAJIN_PAYLOAD_LEN] = {${bytes
      .toString('hex')
      .replace(/../g, (m) => '0x' + m + ',')
      .replace(/,$/, '')}};`,
    '#endif',
    '',
  ].join('\n'),
);
process.stdout.write(
  `payload: ${bytes.length} B (gzip of ${fs
    .readdirSync(path.join(stage, 'dist'), { recursive: true })
    .filter((f) => f.toString().includes('.'))
    .join(', ')}), sha256 ${sha.slice(0, 16)}…\n`,
);
if (payloadOnly) process.exit(0);

// --- 4. compile --------------------------------------------------------------
function findZig() {
  if (process.env.ZIG) return process.env.ZIG.trim().split(/\s+/);
  for (const cand of [
    ['zig'],
    ['python3', '-m', 'ziglang'],
    ['python', '-m', 'ziglang'],
  ]) {
    // sh() throws when the program itself is missing -- that only means "not
    // this candidate", it is not an error worth stopping for
    let r;
    try {
      r = sh(cand[0], cand.slice(1).concat('version'), { timeout: 30000 });
    } catch {
      continue;
    }
    if (r.status === 0) return cand;
  }
  return null;
}
const zig = findZig();
if (!zig) {
  fail(
    'no C compiler found. Install zig (it bundles the whole Windows toolchain):\n' +
      '  pip install ziglang      then:  ZIG="python3 -m ziglang" npm run setup:exe\n' +
      '  -- or use "node scripts/build-setup.mjs --payload-only" and compile payload.h yourself',
  );
}
const zargs = zig.slice(1);
const inc = ['-I' + out];
const win = sh(zig[0], [...zargs, 'cc', ...inc, 'setup/stub.c', '-target', 'x86_64-windows-gnu', '-O2', '-static', '-s', '-o', 'dist/setup/majin-setup.exe'], {
  timeout: 600000,
});
if (win.status !== 0) fail('zig cc (windows) said:\n' + String(win.stderr || win.stdout).slice(-1200));
const exe = path.join(out, 'majin-setup.exe');
if (!fs.existsSync(exe)) fail('the compiler reported success but there is no ' + exe);

const host = hostBuild
  ? sh(zig[0], [...zargs, 'cc', ...inc, 'setup/stub.c', '-O2', '-s', '-o', 'dist/setup/majin-setup'], { timeout: 600000 })
  : null;
if (host && host.status !== 0) fail('zig cc (host) said:\n' + String(host.stderr || host.stdout).slice(-800));
if (host) fs.chmodSync(path.join(out, 'majin-setup'), 0o755);

// --- 5. the produced file must actually be a Windows console program ---------
const pe = fs.readFileSync(exe);
const at = pe.readUInt32LE(0x3c);
const checks = {
  mz: pe.slice(0, 2).toString('latin1') === 'MZ',
  sig: pe.slice(at, at + 4).toString('latin1') === 'PE\u0000\u0000',
  machine: pe.readUInt16LE(at + 4),
  subsystem: pe.readUInt16LE(at + 24 + 68),
  bytes: pe.length,
};
if (!checks.mz || !checks.sig) fail('the output is not a PE executable');
if (checks.machine !== 0x8664) fail(`expected an x64 image, got 0x${checks.machine.toString(16)}`);
if (checks.subsystem !== 3) fail(`expected the console subsystem (3), got ${checks.subsystem}`);

const manifest = {
  version: pkg.version,
  file: 'majin-setup.exe',
  bytes: checks.bytes,
  sha256: crypto.createHash('sha256').update(pe).digest('hex'),
  payload: { bytes: bytes.length, sha256: sha },
  zig: String(sh(zig[0], zig.slice(1).concat('version')).stdout || '').trim(),
  built: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(
  [
    `exe:      dist/setup/majin-setup.exe (${(checks.bytes / 1024).toFixed(0)} kB, x64 console PE, zig ${manifest.zig})`,
    `sha256:   ${manifest.sha256}`,
    'verify:   certutil -hashfile majin-setup.exe SHA256',
    host ? 'test:     dist/setup/majin-setup --dir <folder> --print' : '',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
