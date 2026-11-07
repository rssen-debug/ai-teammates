/**
 * MAJIN RE — bro till extern verktyg (valfritt, aldrig ett krav).
 * MAJINs egen parser räcker för triage. När man vill ha riktig decompilation
 * hittar agenten ghidra/rizin/objdump av sig själv och kör dem.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bus } from '../log.js';

export const TOOL_SPECS = [
  {
    id: 'ghidra',
    label: 'Ghidra (decompilation)',
    bins: ['analyzeHeadless', 'support/analyzeHeadless'],
    env: ['GHIDRA_HOME', 'GHIDRA_DIR'],
    winPaths: ['C:\\ghidra', 'C:\\Tools\\ghidra', '%USERPROFILE%\\ghidra', 'C:\\Program Files\\ghidra'],
    hint: 'Get it from https://ghidra-sre.org (needs JDK 21). Set GHIDRA_HOME or put the folder in PATH.',
    use: 'decompile functions to C, type recovery',
    build: ({ file, cfg, args }) => {
      const home = cfg.get('tools.re.ghidraDir') || process.env.GHIDRA_HOME;
      const bin = home ? path.join(home, 'support', 'analyzeHeadless') : 'analyzeHeadless';
      const proj = path.join(os.tmpdir(), `majin-ghidra-${Date.now()}`);
      return {
        cmd: bin,
        args: [proj, 'MAJIN', '-import', file, '-processorPath', '.', ...(args || []), '-scriptPath', path.join(os.tmpdir(), 'majin-ghidra-scripts'), '-postScript', 'MAJIN-Export.c', '-deleteProject'],
        note: `A Ghidra project is created in ${proj} (removed afterwards).`,
      };
    },
  },
  {
    id: 'rizin',
    label: 'rizin (analysis + disasm)',
    bins: ['rizin', 'r2'],
    winPaths: ['C:\\rizin\\bin\\rizin.exe'],
    hint: 'winget install rizin.rizin  ·  or pacman -S rizin',
    use: 'fast disassembler: afl, pdf, aaa',
    build: ({ file, commands }) => ({ cmd: 'rizin', args: ['-q', '-c', (commands || 'e bin.baddr; aa; afl; s entry0; pdf').join(';'), file] }),
  },
  {
    id: 'objdump',
    label: 'objdump (GNU binutils)',
    bins: ['objdump', 'llvm-objdump', 'x86_64-w64-mingw32-objdump'],
    hint: 'winget install binutils · or install MSYS2/LLVM',
    use: '-d disassembly, -p PE header, -T dynamic symbols',
    build: ({ file, flags = ['-d', '--no-show-raw-insn'] }) => ({ cmd: 'objdump', args: [...flags, file] }),
  },
  {
    id: 'binwalk',
    label: 'binwalk (embedded files)',
    bins: ['binwalk'],
    hint: 'pip install binwalk',
    use: 'find archives/firmware/bootloaders inside a file',
    build: ({ file, extract }) => ({ cmd: 'binwalk', args: extract ? ['-e', '-q', file] : ['--signatures', file] }),
  },
  {
    id: 'upx',
    label: 'UPX',
    bins: ['upx'],
    hint: 'winget install upx.upx',
    use: 'upx -d to unpack UPX binaries',
    build: ({ file, out }) => ({ cmd: 'upx', args: ['-d', '-o', out || `${file}.unpacked`, file] }),
  },
  {
    id: 'yara',
    label: 'YARA',
    bins: ['yara', 'yara64'],
    hint: 'winget install Yara-Yara',
    use: 'run full YARA rules (MAJIN has its own mini engine for the common ones)',
    build: ({ file, rules, namespace }) => ({ cmd: 'yara', args: ['-r', ...(namespace ? ['-n', namespace] : []), rules, file] }),
  },
  {
    id: 'jadx',
    label: 'jadx (Android → Java)',
    bins: ['jadx'],
    hint: 'winget install skydoves.jadx · needs Java',
    use: 'decompile APK/DEX into readable Java',
    build: ({ file, out }) => ({ cmd: 'jadx', args: ['-q', '--no-res', ...(out ? ['-d', out] : []), file] }),
  },
  {
    id: 'apktool',
    label: 'apktool (Android-resurser)',
    bins: ['apktool'],
    hint: 'https://apktool.org (needs Java)',
    use: 'unpack resources + AndroidManifest.xml',
    build: ({ file, out }) => ({ cmd: 'apktool', args: ['d', '-f', ...(out ? ['-o', out] : []), file] }),
  },
  {
    id: 'ilspycmd',
    label: 'ilspycmd (.NET → C#)',
    bins: ['ilspycmd'],
    hint: 'dotnet tool install -g ilspycmd',
    use: 'decompile .NET assemblies to C#',
    build: ({ file, out }) => ({ cmd: 'ilspycmd', args: ['-p', ...(out ? ['-o', out] : []), file] }),
  },
  {
    id: 'nm',
    label: 'nm / strings / file',
    bins: ['nm', 'strings', 'file'],
    hint: 'included in binutils/MSYS',
    use: 'fast symbol/string dump',
    build: ({ file, tool = 'strings' }) => ({ cmd: tool, args: ['-a', file] }),
  },
];

const cache = { at: 0, found: null };

function probePaths(spec) {
  const out = [];
  for (const envVar of spec.env || []) {
    const v = process.env[envVar];
    if (!v) continue;
    for (const b of spec.bins) out.push(path.join(v.replace(/"/g, ''), b));
  }
  const home = process.env.USERPROFILE || os.homedir();
  for (const p of spec.winPaths || []) out.push(p.replace(/%USERPROFILE%/gi, home).replace(/\\/g, path.sep));
  return out;
}

export async function detect({ refresh = false, timeoutMs = 6000 } = {}) {
  const now = Date.now();
  if (!refresh && cache.found && now - cache.at < 120000) return cache.found;
  const found = {};
  await Promise.all(
    TOOL_SPECS.map(async (spec) => {
      for (const cand of [...spec.bins.map((b) => b), ...probePaths(spec)]) {
        try {
          const abs = /\.(exe|bat|cmd)$/i.test(cand) || cand.includes(path.sep) ? cand : await which(cand);
          if (!abs) continue;
          if (cand.includes(path.sep) && !fs.existsSync(abs)) continue;
          found[spec.id] = { available: true, path: abs, label: spec.label, use: spec.use };
          return;
        } catch {
          /* next candidate */
        }
      }
      found[spec.id] = { available: false, label: spec.label, use: spec.use, hint: spec.hint };
    }),
  );
  cache.at = now;
  cache.found = found;
  void timeoutMs;
  return found;
}

function which(bin) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] || null : null));
    setTimeout(() => child.kill(), 4000).unref?.();
  });
}

export async function run(cmd, args, { cwd, timeoutMs = 120000, env = {}, maxChars = 60000, input } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ok: false, error: `could not start ${cmd}: ${err.message}`, exitCode: -1, ms: 0 });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => {
      if (out.length < maxChars * 2) out += d;
    });
    child.stderr?.on('data', (d) => {
      if (err.length < 20000) err += d;
    });
    if (input && child.stdin) {
      try {
        child.stdin.end(input);
      } catch {
        /* tool did not want stdin */
      }
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `${cmd}: ${e.message}`, hint: /ENOENT/.test(e.message) ? 'The tool is not in PATH. See the install hints in tools.re.' : null, exitCode: -1, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const clipped = out.length > maxChars ? `${out.slice(0, maxChars)}\n…[clipped ${out.length - maxChars} chars]` : out;
      bus.debug('external.done', { cmd, code, chars: out.length });
      resolve({ ok: code === 0, exitCode: code, stdout: clipped, stderr: err.slice(0, 4000), ms: Date.now() - t0, cmd: `${cmd} ${args.join(' ')}`.trim() });
    });
  });
}

export async function call(id, { file, ...rest } = {}, cfg) {
  const spec = TOOL_SPECS.find((s) => s.id === id);
  if (!spec) return { ok: false, error: `unknown tool ${id}`, available: Object.keys(await detect({})) };
  const det = await detect({});
  if (!det[id]?.available && !spec.bins.some((b) => b.includes(path.sep))) {
    if (!det[id]?.available) return { ok: false, error: `${spec.label} is not installed`, hint: spec.hint, use: spec.use };
  }
  const built = spec.build({ file, cfg, ...rest });
  const cmd = built.cmd.includes(path.sep) || fs.existsSync(built.cmd) ? built.cmd : det[id]?.path || built.cmd;
  const res = await run(cmd, built.args, { cwd: rest.cwd || (file ? path.dirname(file) : process.cwd()), timeoutMs: rest.timeoutMs || (id === 'ghidra' ? cfg?.get('tools.re.headlessTimeoutSec') * 1000 || 900000 : 180000), maxChars: rest.maxChars || 80000 });
  return { ...res, tool: id, note: built.note, cmd: `${cmd} ${built.args.join(' ')}` };
}

export function summary() {
  return detect({}).then((d) => Object.entries(d).map(([id, v]) => ({ id, available: v.available, path: v.path || null, hint: v.hint || null })));
}
