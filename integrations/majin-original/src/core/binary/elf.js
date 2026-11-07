/**
 * MAJIN RE — ELF + Mach-O.
 * Samma idé som PE-läsaren: headers, segment, imports/exports, entropy, hashes.
 */
import crypto from 'node:crypto';
import { BinError } from './reader.js';

const EMACH = {
  0x3e: 'AMD64',
  0x03: 'Intel 80386',
  0xb7: 'AArch64',
  0x28: 'ARM',
  0xf3: 'RISC-V',
  0x15: 'SPARC64',
  0x08: 'MIPS',
  0x16: 'S390',
  0x37: 'PPC64',
  0x14: 'PPC',
};

const ETYPE = { 0: 'NONE', 1: 'REL', 2: 'EXEC', 3: 'DYN (shared/pie)', 4: 'CORE' };

export function parseElf(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new BinError('missing ELF magic (\\x7fELF)', { code: 'elf_parse' });
  }
  const cl = buf[4];
  const is64 = cl === 2;
  const le = buf[5] === 1;
  const os = buf[7];
  const g = (off, size) => {
    if (size === 8) return Number(view.getBigUint64(off, le));
    if (size === 4) return view.getUint32(off, le);
    if (size === 2) return view.getUint16(off, le);
    return view.getUint8(off);
  };
  const e_type = g(16, 2);
  const e_machine = g(18, 2);
  const e_version = g(20, 4);
  const entry = is64 ? g(24, 8) : g(24, 4);
  const phoff = is64 ? g(32, 8) : g(28, 4);
  const shoff = is64 ? g(40, 8) : g(32, 4);
  const flags = g(48, 4);
  const ehsize = g(52, 2);
  const phentsize = g(54, 2);
  const phnum = g(56, 2);
  const shentsize = g(58, 2);
  const shnum = g(60, 2);
  const shstrndx = g(62, 2);

  let shstrOff = 0;
  if (shstrndx > 0 && shstrndx < 4096) {
    const so = shoff + shstrndx * shentsize;
    if (so + shentsize <= buf.length) shstrOff = is64 ? g(so + 24, 8) : g(so + 16, 4);
  }

  const sections = [];
  try {
    for (let i = 0; i < Math.min(shnum, 4096); i += 1) {
      const o = shoff + i * shentsize;
      if (o + shentsize > buf.length) break;
      const nameOff = g(o, 4);
      const sType = g(o + 4, 4);
      const addr = is64 ? g(o + 16, 8) : g(o + 12, 4);
      const offset = is64 ? g(o + 24, 8) : g(o + 16, 4);
      const size = is64 ? g(o + 32, 8) : g(o + 20, 4);
      const link = g(o + (is64 ? 40 : 24), 4);
      const info = g(o + (is64 ? 44 : 28), 4);
      const flagsS = is64 ? g(o + 8, 8) : g(o + 8, 4);
      sections.push({
        index: i,
        name: cstr(buf, shstrOff + nameOff),
        type: sType,
        addr,
        offset,
        size,
        link,
        info,
        executable: (flagsS & 0x4) !== 0,
        writable: (flagsS & 0x1) !== 0,
        alloc: (flagsS & 0x2) !== 0,
      });
    }
  } catch {
    /* stripped section headers */
  }

  const segments = [];
  try {
    for (let i = 0; i < Math.min(phnum, 128); i += 1) {
      const o = phoff + i * phentsize;
      if (o + phentsize > buf.length) break;
      const type = g(o, 4);
      const fl = is64 ? g(o + 4, 4) : g(o + 24, 4);
      const off = is64 ? g(o + 8, 8) : g(o + 4, 4);
      const vaddr = is64 ? g(o + 16, 8) : g(o + 8, 4);
      const filesz = is64 ? g(o + 32, 8) : g(o + 16, 4);
      const memsz = is64 ? g(o + 40, 8) : g(o + 20, 4);
      segments.push({ type, typeName: PT(type), flags: fl, offset: off, vaddr, filesz, memsz, executable: (fl & 1) !== 0, writable: (fl & 2) !== 0 });
    }
  } catch {
    /* ignore */
  }

  const dyn = parseDynamic(buf, view, sections, is64, le);
  const symbols = parseSymtab(buf, view, sections, is64, le, 600);
  const needed = dyn.needed || [];
  const imports = symbols.undefined.map((s) => s.name).filter(Boolean);
  const exportsTab = symbols.exported.map((s) => s.name).filter(Boolean);

  const interp = segments.find((s) => s.type === 3);
  const interpreter = interp ? cstr(buf, interp.offset).slice(0, 160) : null;

  return {
    format: 'elf',
    bits: is64 ? 64 : 32,
    endian: le ? 'little' : 'big',
    class: is64 ? 'ELF64' : 'ELF32',
    type: ETYPE[e_type] || `TYPE_${e_type}`,
    pie: e_type === 3,
    arch: EMACH[e_machine] || `MACHINE_0x${e_machine.toString(16)}`,
    os: ELFOS(os),
    version: e_version,
    entry,
    flags: `0x${flags.toString(16)}`,
    interpreter,
    sections,
    segments,
    dynamic: {
      needed,
      rpath: dyn.rpath,
      runpath: dyn.runpath,
      soname: dyn.soname,
      init: dyn.init,
      fini: dyn.fini,
      relro: dyn.relro,
      bindNow: dyn.bindNow,
    },
    imports,
    exports: exportsTab.slice(0, 400),
    symbols: { total: symbols.total, undefined: imports.length, exported: symbols.exported.length, sample: symbols.exported.slice(0, 40) },
    stripped: symbols.total === 0,
    notes: parseNotes(buf, view, segments, le),
    overlay: { size: Math.max(0, buf.length - Math.max(sections.length ? Math.max(...sections.map((s) => s.offset + s.size)) : 0, ehsize)) },
    hashes: { md5: h(buf, 'md5'), sha1: h(buf, 'sha1'), sha256: h(buf, 'sha256'), size: buf.length },
  };
}

function h(buf, alg) {
  return crypto.createHash(alg).update(buf).digest('hex');
}

function cstr(buf, off) {
  if (off < 0 || off >= buf.length) return '';
  const end = buf.indexOf(0, off);
  return buf.toString('latin1', off, end === -1 ? Math.min(buf.length, off + 200) : end);
}

const PT = (t) => ({ 0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 6: 'PHDR', 7: 'TLS', 0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY' }[t] || `PT_0x${t.toString(16)}`);
const ELFOS = (o) => ({ 0: 'SYSV', 1: 'HPUX', 3: 'NETBSD', 6: 'SOLARIS', 7: 'AIX', 9: 'FREEBSD', 12: 'OPENBSD' }[o] || `OS_${o}`);

function parseDynamic(buf, view, sections, is64, le) {
  const dyn = sections.find((s) => s.type === 6 || s.name === '.dynamic');
  const out = { needed: [], relro: false, bindNow: false };
  if (!dyn) return out;
  const strtab = sections.find((s) => s.name === '.dynstr' || s.name === '.strtab');
  const size = is64 ? 16 : 8;
  const cstrAt = (off) => (!strtab || off < 0 ? '' : cstr(buf, strtab.offset + off));
  try {
    for (let p = dyn.offset; p + size <= dyn.offset + dyn.size; p += size) {
      const t = Number(is64 ? view.getBigInt64(p, le) : BigInt(view.getInt32(p, le)));
      const v = Number(is64 ? view.getBigUint64(p + 8, le) : BigInt(view.getUint32(p + 4, le)));
      if (t === 0) break;
      if (t === 1) out.needed.push(cstrAt(v));
      if (t === 14) out.soname = cstrAt(v);
      if (t === 15) out.rpath = cstrAt(v);
      if (t === 29) out.runpath = cstrAt(v);
      if (t === 12) out.init = v;
      if (t === 13) out.fini = v;
      if (t === 30) out.bindNow = true;
      if (t === 0x6ffffffb) out.flags1 = v;
    }
  } catch {
    /* truncated dynamic section */
  }
  return out;
}

function parseSymtab(buf, view, sections, is64, le, cap) {
  const sym = sections.find((s) => s.name === '.symtab') || sections.find((s) => s.name === '.dynsym');
  const str = sym ? sections.find((s) => s.index === sym.link) : sections.find((s) => s.name === '.strtab' || s.name === '.dynstr');
  const out = { total: 0, undefined: [], exported: [] };
  if (!sym || !str) return out;
  const esize = is64 ? 24 : 16;
  try {
    for (let p = sym.offset; p + esize <= sym.offset + sym.size && out.total < 200000; p += esize) {
      const nameOff = view.getUint32(p, le);
      const info = is64 ? buf[p + 4] : buf[p + 12];
      const shndx = is64 ? view.getUint16(p + 6, le) : view.getUint16(p + 14, le);
      const value = is64 ? Number(view.getBigUint64(p + 8, le)) : view.getUint32(p + 4, le);
      const type = info & 0xf;
      const bind = info >> 4;
      out.total += 1;
      if (type === 3) continue;
      const name = cstr(buf, str.offset + nameOff);
      if (!name) continue;
      if (shndx === 0) {
        if (out.undefined.length < cap * 2) out.undefined.push({ name, value });
      } else if (bind === 1 && out.exported.length < cap) {
        out.exported.push({ name, value, shndx });
      }
    }
  } catch {
    /* malformed symtab */
  }
  return out;
}

function parseNotes(buf, view, segments, le) {
  const note = segments.find((s) => s.type === 4 || s.typeName === 'GNU_PROPERTY');
  const out = [];
  if (!note) return out;
  try {
    let p = note.offset;
    const end = Math.min(buf.length, note.offset + note.filesz);
    while (p + 12 <= end && out.length < 16) {
      const namesz = view.getUint32(p, le);
      const descsz = view.getUint32(p + 4, le);
      const type = view.getUint32(p + 8, le);
      const name = buf.toString('latin1', p + 12, p + 12 + Math.min(namesz, 64)).replace(/\0+$/, '');
      out.push({ name, type, desc: Math.max(0, Math.min(16, (descsz / 4) | 0)) * 4 });
      p += 12 + Math.ceil(namesz / 4) * 4 + Math.ceil(descsz / 4) * 4;
    }
  } catch {
    /* not all notes are well formed */
  }
  return out;
}

/* ------------------------------- Mach-O ----------------------------------- */

const MH_MAGIC = { 0xfeedface: { bits: 32, le: true }, 0xfeedfacf: { bits: 64, le: true }, 0xcefaedfe: { bits: 32, le: false }, 0xcffaedfe: { bits: 64, le: false } };

export function parseMachO(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  const info = MH_MAGIC[magic];
  if (!info) throw new BinError('unknown Mach-O magic', { code: 'macho_parse' });
  const le = info.le;
  const cputype = view.getUint32(4, le);
  const cpusub = view.getUint32(8, le);
  const filetype = view.getUint32(12, le);
  const ncmds = view.getUint32(16, le);
  const sizeofcmds = view.getUint32(20, le);
  const flags = view.getUint32(24, le);
  const dylibs = [];
  const segments = [];
  let p = 32;
  for (let i = 0; i < ncmds && p + 8 <= buf.length; i += 1) {
    const cmd = view.getUint32(p, le);
    const cmdsize = view.getUint32(p + 4, le);
    if (!cmdsize) break;
    if (cmd === 0x19 || cmd === 0x1) {
      const name = buf.toString('latin1', p + 8, p + 8 + 16).replace(/\0+$/, '');
      const vmaddr = le ? Number(view.getBigUint64(p + 24, true)) : view.getUint32(p + 24, le);
      const vmsize = info.bits === 64 ? Number(view.getBigUint64(p + 32, true)) : view.getUint32(p + 32, le);
      const maxprot = view.getUint32(p + (info.bits === 64 ? 48 : 40), le);
      segments.push({ name, vmaddr, vmsize, prot: protStr(maxprot) });
    }
    if (DYLIB_CMDS[cmd]) {
      const nameOff = view.getUint32(p + 8, le);
      dylibs.push({ cmd: DYLIB_CMDS[cmd], name: lcStr(buf, p + nameOff), current: versionStr(view.getUint32(p + 16, le)), compat: versionStr(view.getUint32(p + 20, le)) });
    }
    p += cmdsize;
  }
  void sizeofcmds;
  return {
    format: 'macho',
    bits: info.bits,
    endian: le ? 'little' : 'big',
    cpu: CPU[cputype] || `cpu_${cputype}`,
    cpusub: `0x${cpusub.toString(16)}`,
    filetype: FILETYPE[filetype] || `type_${filetype}`,
    ncmds,
    flags: flagsStr(flags),
    segments,
    dylibs: dylibs.map((d) => d.name).filter(Boolean),
    hashes: { md5: h(buf, 'md5'), sha256: h(buf, 'sha256'), size: buf.length },
  };
}

function lcStr(buf, off) {
  if (off < 0 || off >= buf.length) return '';
  const end = buf.indexOf(0, off);
  return buf.toString('latin1', off, end === -1 ? Math.min(buf.length, off + 200) : end);
}

const DYLIB_CMDS = { 0xc: 'LC_LOAD_DYLIB', 0xd: 'LC_ID_DYLIB', 0x18: 'LC_LOAD_WEAK_DYLIB', 0x1f: 'LC_REEXPORT_DYLIB', 0x23: 'LC_LOAD_UPWARD_DYLIB' };
const versionStr = (v) => `${(v >>> 16) & 0xffff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
const protStr = (p) => `${p & 1 ? 'r' : '-'}${p & 2 ? 'w' : '-'}${p & 4 ? 'x' : '-'}`;
const CPU = { 7: 'x86', 0x01000007: 'x86_64', 0x0100000c: 'ARM64', 12: 'ARM', 18: 'PPC' };
const FILETYPE = { 1: 'OBJECT', 2: 'EXECUTE', 6: 'DYLIB', 7: 'BUNDLE', 8: 'DYLINKER', 9: 'LOADABLE', 11: 'DUMPED_CORE' };
const MH_FLAGS = { 0x1: 'TWOLEVEL', 0x8000: 'PIE', 0x200000: 'NOUNDEFS', 0x400000: 'INCRLINK', 0x800000: 'DYLDLINK', 0x2000000: 'PREBOUND', 0x4000000: 'BINDATLOAD', 0x10000000: 'NO_REEXPORTED_DYLIBS', 0x400000: 'SUBSECTIONS_VIA_SYMBOLS' };
const flagsStr = (f) => Object.entries(MH_FLAGS).filter(([m]) => (f & Number(m)) !== 0).map(([, n]) => n);
