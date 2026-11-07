/**
 * MAJIN RE — PE/COFF.
 * Egen parser (ingen pefile, ingen python, ingen build-step). Täckar det som
 * faktiskt används i triage: headers, sektioner, imports/exports, delay imports,
 * TLS-callbacks, load config (CFG/ASLR/DEP), debug (PDB), cert, overlay,
 * Rich-header-avkodning och .NET-metadata.
 */
import crypto from 'node:crypto';
import { BinError, makeRvaMapper } from './reader.js';

const MACHINE = {
  0x0: { id: 'UNKNOWN', bits: 64 },
  0x14c: { id: 'I386', bits: 32 },
  0x8664: { id: 'AMD64', bits: 64 },
  0x1c0: { id: 'ARM', bits: 32 },
  0xaa64: { id: 'ARM64', bits: 64 },
  0x1f0: { id: 'POWERPC', bits: 32 },
  0x93: { id: 'RISC_V32', bits: 32 },
  0x5064: { id: 'RISC_V64', bits: 64 },
  0xc0ee: { id: 'EBC', bits: 32 },
};

const SUBSYSTEM = {
  0: 'UNKNOWN',
  1: 'NATIVE',
  2: 'WINDOWS_GUI',
  3: 'WINDOWS_CUI',
  5: 'OS2_CUI',
  7: 'POSIX_CUI',
  8: 'WINDOWS_CUI_DRIVER',
  9: 'EFI_APPLICATION',
  10: 'EFI_BOOT_SERVICE_DRIVER',
  11: 'EFI_RUNTIME_DRIVER',
  12: 'EFI_ROM',
};

const CHARACTERISTICS = {
  0x0002: 'EXECUTABLE_IMAGE',
  0x0004: 'LINE_NUMS_STRIPPED',
  0x0008: 'LOCAL_SYMS_STRIPPED',
  0x0020: 'LARGE_ADDRESS_AWARE',
  0x0040: '16BIT_MACHINE',
  0x0080: 'COMNET_RUNNABLE_IMAGE',
  0x0100: 'NET_RUN_FROM_SWAP',
  0x0200: 'SYSTEM',
  0x0400: 'DLL',
  0x1000: 'UP_SYSTEM_ONLY',
  0x2000: 'WDM_DRIVER',
  0x4000: 'TERMSERVER_PER_MACHINE',
};

const DLL_FLAGS = {
  0x0020: { name: 'HIGH_ENTROPY_VA', good: true },
  0x0040: { name: 'DYNAMIC_BASE (ASLR)', good: true },
  0x0080: { name: 'FORCE_INTEGRITY (Integrity Checks)', good: true },
  0x0100: { name: 'NX_COMPAT (DEP)', good: true },
  0x0200: { name: 'NO_ISOLATION', good: false },
  0x0400: { name: 'NO_SEH', good: false },
  0x0800: { name: 'NO_BIND', good: true },
  0x1000: { name: 'APPCONTAINER', good: true },
  0x2000: { name: 'WDM_DRIVER', good: false },
  0x4000: { name: 'GUARD_CF (CFG)', good: true },
  0x8000: { name: 'TERMINAL_SERVER_AWARE', good: true },
};

const DIR_NAMES = [
  'EXPORT',
  'IMPORT',
  'RESOURCE',
  'EXCEPTION',
  'CERTIFICATE',
  'BASE_RELOCATION',
  'DEBUG',
  'ARCHITECTURE',
  'GLOBAL_PTR',
  'TLS',
  'LOAD_CONFIG',
  'BOUND_IMPORT',
  'IAT',
  'DELAY_IMPORT',
  'CLR_RUNTIME',
];

export function parsePe(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = buf.length;
  const bad = (m, extra) => new BinError(m, { code: 'pe_parse', ...extra });

  if (size < 0x40) throw bad('The file is too small for a PE header', { hint: 'Needs at least a 64 byte DOS header.' });
  // MZ = bytes 4d 5a → little-endian u16 = 0x5a4d (DataView är big-endian som default).
  if (view.getUint16(0, true) !== 0x5a4d) throw bad('missing MZ signature', { hint: 'this is not a Windows PE file' });

  const e_lfanew = view.getUint32(0x3c, true);
  if (e_lfanew <= 0 || e_lfanew + 24 > size) throw bad(`Ogiltig e_lfanew (0x${e_lfanew.toString(16)})`, { offset: 0x3c });
  if (view.getUint32(e_lfanew, true) !== 0x00004550) throw bad('missing the PE\\0\\0 signature after the DOS header', { offset: e_lfanew });

  const coff = e_lfanew + 4;
  const machineId = view.getUint16(coff, true);
  const numberOfSections = view.getUint16(coff + 2, true);
  const timeDateStamp = view.getUint32(coff + 4, true);
  const pointerToSymbolTable = view.getUint32(coff + 8, true);
  const numberOfSymbols = view.getUint32(coff + 12, true);
  const sizeOfOptionalHeader = view.getUint16(coff + 16, true);
  const characteristics = view.getUint16(coff + 18, true);

  const opt = coff + 20;
  const magic = view.getUint16(opt, true);
  if (magic !== 0x10b && magic !== 0x20b) throw bad(`Unknown optional header magic 0x${magic.toString(16)}`, { offset: opt, hint: 'Expected PE32 (0x10b) or PE32+ (0x20b).' });
  const is64 = magic === 0x20b;
  const bits = is64 ? 64 : 32;

  const sectionsOff = opt + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections && sectionsOff + i * 40 + 40 <= size; i += 1) {
    const o = sectionsOff + i * 40;
    const name = buf.toString('latin1', o, o + 8).replace(/\0+$/, '');
    const virtualSize = view.getUint32(o + 8, true);
    const virtualAddress = view.getUint32(o + 12, true);
    const rawSize = view.getUint32(o + 16, true);
    const rawPointer = view.getUint32(o + 20, true);
    const characteristicsSec = view.getUint32(o + 36, true);
    sections.push({
      index: i,
      name: name.length ? name : `<anon${i}>`,
      virtualSize,
      virtualAddress,
      rawSize,
      rawPointer,
      entropy: null,
      characteristics: characteristicsSec,
      flags: sectionFlags(characteristicsSec),
      executable: (characteristicsSec & 0x20000000) !== 0,
      writable: (characteristicsSec & 0x80000000) !== 0,
      readable: (characteristicsSec & 0x40000000) !== 0,
      discardable: (characteristicsSec & 0x02000000) !== 0,
    });
  }
  const rvaToOffset = makeRvaMapper(sections);

  const dirBase = is64 ? opt + 112 : opt + 96;
  const directories = [];
  for (let i = 0; i < 16 && dirBase + i * 8 + 8 <= size; i += 1) {
    const rva = view.getUint32(dirBase + i * 8, true);
    const sz = view.getUint32(dirBase + i * 8 + 4, true);
    if (rva || sz) directories.push({ index: i, name: DIR_NAMES[i], rva, size: sz, offset: rvaToOffset(rva) });
  }
  const dir = (name) => directories.find((d) => d.name === name) || null;

  const sub = {
    magic: `0x${magic.toString(16)}`,
    bits,
    linkVersion: `${view.getUint8(opt + 2)}.${view.getUint8(opt + 3)}`,
    loaderVersion: `${view.getUint8(opt + 4)}.${view.getUint8(opt + 5)}`,
    sizeOfCode: view.getUint32(opt + 12, true),
    sizeOfInitializedData: view.getUint32(opt + 16, true),
    sizeOfUninitializedData: view.getUint32(opt + 20, true),
    addressOfEntryPoint: view.getUint32(opt + 24, true),
    baseOfCode: view.getUint32(opt + 28, true),
    imageBase: is64 ? Number(view.getBigUint64(opt + 32, true)) : view.getUint32(opt + 32, true),
    sectionAlignment: view.getUint32(opt + is64 ? 40 : 36, true),
    fileAlignment: view.getUint32(opt + (is64 ? 44 : 40), true),
    osVersion: `${view.getUint16(opt + (is64 ? 48 : 44), true)}.${view.getUint16(opt + (is64 ? 50 : 46), true)}`,
    imageVersion: `${view.getUint16(opt + (is64 ? 52 : 48), true)}.${view.getUint16(opt + (is64 ? 54 : 50), true)}`,
    subsystemVersion: `${view.getUint16(opt + (is64 ? 56 : 52), true)}.${view.getUint16(opt + (is64 ? 58 : 54), true)}`,
    sizeOfImage: view.getUint32(opt + (is64 ? 64 : 60), true),
    sizeOfHeaders: view.getUint32(opt + (is64 ? 68 : 64), true),
    checkSum: view.getUint32(opt + (is64 ? 72 : 68), true),
    realCheckSum: checksum(buf, sections, sectionsOff),
    subsystemId: view.getUint16(opt + (is64 ? 76 : 72), true),
    dllCharacteristics: view.getUint16(opt + (is64 ? 78 : 74), true),
    sizeOfStackReserve: is64 ? Number(view.getBigUint64(opt + 80, true)) : view.getUint32(opt + 76, true),
    sizeOfHeapReserve: is64 ? Number(view.getBigUint64(opt + 88, true)) : view.getUint32(opt + 84, true),
    loaderFlags: undefined,
  };
  sub.subsystem = SUBSYSTEM[sub.subsystemId] || `UNKNOWN(${sub.subsystemId})`;
  sub.dllFlags = Object.entries(DLL_FLAGS)
    .map(([mask, v]) => ((sub.dllCharacteristics & Number(mask)) !== 0 ? { name: v.name, good: v.good } : null))
    .filter(Boolean);

  const imports = parseImports(buf, view, dir('IMPORT'), rvaToOffset, bits);
  const exportsTab = parseExports(buf, view, dir('EXPORT'), rvaToOffset);
  const delay = parseDelayImports(buf, view, dir('DELAY_IMPORT'), rvaToOffset);
  const tls = parseTls(buf, view, dir('TLS'), rvaToOffset, bits);
  const debug = parseDebug(buf, view, dir('DEBUG'), rvaToOffset);
  const loadConfig = parseLoadConfig(buf, view, dir('LOAD_CONFIG'), rvaToOffset, bits);
  const resources = parseResources(buf, view, dir('RESOURCE'), rvaToOffset);
  const clr = dir('CLR_RUNTIME');
  const dotnet = clr ? parseClr(buf, view, clr, rvaToOffset) : null;
  const cert = parseCert(buf, view, dir('CERTIFICATE'));
  const relocations = dir('BASE_RELOCATION') ? countRelocs(view, dir('BASE_RELOCATION'), rvaToOffset) : null;

  const entrySection = sections.find((s) => sub.addressOfEntryPoint >= s.virtualAddress && sub.addressOfEntryPoint < s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
  const overlayOff = sections.length ? Math.max(...sections.map((s) => s.rawPointer + s.rawSize)) : sub.sizeOfHeaders;
  const overlay = Math.max(0, size - overlayOff);

  const timestamp = timeDateStamp ? new Date(timeDateStamp * 1000).toISOString() : null;
  const machine = MACHINE[machineId] || { id: `UNKNOWN(0x${machineId.toString(16)})`, bits: 64 };

  return {
    format: 'pe',
    arch: machine.id,
    bits: machine.bits,
    isDll: (characteristics & 0x2000) !== 0 || (characteristics & 0x1000) !== 0,
    characteristics: flagNames(characteristics, CHARACTERISTICS),
    timestamp,
    timestampRaw: timeDateStamp,
    futureTimestamp: timestamp ? Date.parse(timestamp) > Date.now() + 86400000 : false,
    tinyTimestamp: timeDateStamp > 0 && timeDateStamp < 0x40000000,
    pointerToSymbolTable,
    numberOfSymbols,
    symbols: pointerToSymbolTable && numberOfSymbols ? readSymbols(buf, view, pointerToSymbolTable, numberOfSymbols) : [],
    sections,
    optional: sub,
    directories,
    imports,
    exports: exportsTab,
    delayImports: delay,
    tls,
    debug,
    loadConfig,
    resources,
    dotnet,
    certificate: cert,
    relocations,
    entryPoint: { rva: sub.addressOfEntryPoint, offset: rvaToOffset(sub.addressOfEntryPoint), section: entrySection?.name || null, inImage: !!entrySection },
    overlay: { offset: overlayOff, size: overlay },
    rich: parseRich(buf, e_lfanew),
    hashes: hash(buf),
    imphash: imphash(imports),
    _rvaToOffset: rvaToOffset,
    _view: view,
  };
}

function sectionFlags(c) {
  const map = {
    0x00000020: 'CNT_CODE',
    0x00000040: 'CNT_INIT_DATA',
    0x00000080: 'CNT_UNINIT_DATA',
    0x01000000: 'LNK_INFO',
    0x02000000: 'LNK_REMOVE',
    0x04000000: 'LNK_OTHER',
    0x08000000: 'LNK_COMDAT',
    0x10000000: 'NO_DEFER_SPEC_EXC',
    0x20000000: 'MEM_EXECUTE',
    0x40000000: 'MEM_READ',
    0x80000000: 'MEM_WRITE',
  };
  return Object.entries(map)
    .filter(([m]) => (c & Number(m)) !== 0)
    .map(([, n]) => n);
}

function flagNames(value, map) {
  return Object.entries(map)
    .filter(([m]) => (value & Number(m)) !== 0)
    .map(([, n]) => n);
}

function readAt(view, buf, off, len) {
  if (off < 0 || off + len > buf.length) return false;
  void view;
  return true;
}

function parseImports(buf, view, d, rvaToOffset, bits) {
  const out = [];
  if (!d || d.offset < 0) return out;
  const thunkSize = bits === 64 ? 8 : 4;
  const ordinalBit = bits === 64 ? 0x8000000000000000n : 0x80000000;
  for (let i = 0; i < 512; i += 1) {
    const o = d.offset + i * 20;
    if (!readAt(view, buf, o, 20)) break;
    const originalFirstThunk = view.getUint32(o, true);
    const firstThunk = view.getUint32(o + 16, true);
    const nameRva = view.getUint32(o + 12, true);
    if (!originalFirstThunk && !firstThunk && !nameRva) break;
    const dllOff = rvaToOffset(nameRva);
    if (dllOff < 0) continue;
    const dll = buf.toString('latin1', dllOff, buf.indexOf(0, dllOff) === -1 ? dllOff + 40 : buf.indexOf(0, dllOff));
    const funcs = [];
    const intOff = rvaToOffset(originalFirstThunk || firstThunk);
    if (intOff >= 0) {
      for (let j = 0; j < 4096; j += 1) {
        const to = intOff + j * thunkSize;
        if (!readAt(view, buf, to, thunkSize)) break;
        const val = thunkSize === 8 ? view.getBigUint64(to, true) : BigInt(view.getUint32(to, true));
        if (val === 0n) break;
        const isOrd = thunkSize === 8 ? val & ordinalBit : Number(val) & Number(ordinalBit);
        if (isOrd) {
          funcs.push({ name: `Ordinal#${Number(val & 0xffffn)}`, ordinal: Number(val & 0xffffn), hint: -1 });
          continue;
        }
        const nameOff = rvaToOffset(Number(val & 0xffffffffn));
        if (nameOff < 0 || nameOff + 2 > buf.length) continue;
        const hint = view.getUint16(nameOff, true);
        const end = buf.indexOf(0, nameOff + 2);
        const name = buf.toString('latin1', nameOff + 2, end === -1 ? nameOff + 60 : end);
        if (!/^[\w@?]{2,160}(@\d+)?$/.test(name)) continue;
        funcs.push({ name, hint, thunkRva: Number(val & 0xffffffffn) });
      }
    }
    if (funcs.length || dll) out.push({ dll: dll || `<unknown@0x${nameRva.toString(16)}>`, functions: funcs, count: funcs.length });
  }
  return out;
}

function parseExports(buf, view, d, rvaToOffset) {
  if (!d || d.offset < 0) return null;
  try {
    const nameRva = view.getUint32(d.offset + 12, true);
    const ordinalBase = view.getUint32(d.offset + 16, true);
    const numFunctions = view.getUint32(d.offset + 20, true);
    const numNames = view.getUint32(d.offset + 24, true);
    const addrFuncsRva = view.getUint32(d.offset + 28, true);
    const addrNamesRva = view.getUint32(d.offset + 32, true);
    const addrOrdsRva = view.getUint32(d.offset + 36, true);
    const funcsOff = rvaToOffset(addrFuncsRva);
    const namesOff = rvaToOffset(addrNamesRva);
    const ordsOff = rvaToOffset(addrOrdsRva);
    const names = [];
    if (funcsOff >= 0 && namesOff >= 0 && ordsOff >= 0) {
      for (let i = 0; i < Math.min(numNames, 5000); i += 1) {
        const nameRvaI = view.getUint32(namesOff + i * 4, true);
        const ord = view.getUint16(ordsOff + i * 2, true);
        const no = rvaToOffset(nameRvaI);
        if (no < 0) continue;
        const end = buf.indexOf(0, no);
        const rva = view.getUint32(funcsOff + ord * 4, true);
        names.push({ name: buf.toString('latin1', no, end === -1 ? no + 120 : end), ordinal: ord + ordinalBase, rva, forwarder: isExportForwarded(rva, d) ? forwarderName(buf, rvaToOffset, rva) : null });
      }
    }
    const dn = buf.toString('latin1', Math.max(0, rvaToOffset(nameRva)), rvaToOffset(nameRva) < 0 ? 0 : buf.indexOf(0, rvaToOffset(nameRva)));
    return { dllName: rvaToOffset(nameRva) >= 0 ? dn : '', numFunctions, numNames, ordinalBase, functions: names.slice(0, 500), forwarded: names.filter((n) => n.forwarder).length };
  } catch {
    return null;
  }
}

function isExportForwarded(rva, d) {
  return rva >= d.rva && rva < d.rva + d.size;
}

function forwarderName(buf, rvaToOffset, rva) {
  const off = rvaToOffset(rva);
  if (off < 0) return null;
  const end = buf.indexOf(0, off);
  return buf.toString('latin1', off, end === -1 ? off + 120 : end);
}

function parseDelayImports(buf, view, d, rvaToOffset) {
  const out = [];
  if (!d || d.offset < 0) return out;
  for (let i = 0; i < 128; i += 1) {
    const o = d.offset + i * 32;
    if (o + 32 > buf.length) break;
    const attrs = view.getUint32(o, true);
    const nameRva = view.getUint32(o + 4, true);
    const moduleTable = view.getUint32(o + 8, true);
    const importTable = view.getUint32(o + 12, true);
    if (!nameRva && !attrs && !moduleTable && !importTable) break;
    const no = rvaToOffset(nameRva);
    if (no < 0) continue;
    const end = buf.indexOf(0, no);
    const dll = buf.toString('latin1', no, end === -1 ? no + 60 : end);
    const functions = [];
    const it = rvaToOffset(importTable);
    const mt = rvaToOffset(moduleTable);
    if (it >= 0 && mt >= 0) {
      for (let j = 0; j < 512; j += 1) {
        const thunk = view.getUint32(it + j * 4, true);
        const hintOff = rvaToOffset(thunk & 0xfffffff);
        if (hintOff < 0) break;
        const e = buf.indexOf(0, hintOff + 2);
        const nm = buf.toString('latin1', hintOff + 2, e === -1 ? hintOff + 60 : e);
        if (!nm) break;
        functions.push({ name: nm });
      }
    }
    out.push({ dll, functions, count: functions.length, delayed: true });
  }
  return out;
}

function parseTls(buf, view, d, rvaToOffset, bits) {
  if (!d || d.offset < 0) return null;
  const ptr = bits === 64 ? 8 : 4;
  try {
    const read = (o) => (ptr === 8 ? Number(view.getBigUint64(o, true)) : view.getUint32(o, true));
    const start = read(d.offset);
    const end = read(d.offset + ptr);
    const index = read(d.offset + ptr * 2);
    const callbacksRva = read(d.offset + ptr * 3);
    void start;
    void end;
    void index;
    const off = rvaToOffset(callbacksRva & 0xffffffff);
    const callbacks = [];
    if (off >= 0) {
      for (let i = 0; i < 32; i += 1) {
        const v = read(off + i * ptr);
        if (!v || v === 0xffffffff || v === 0xffffffffffffffff) break;
        callbacks.push(v);
      }
    }
    return { callbacksRva, count: callbacks.length, callbacks };
  } catch {
    return null;
  }
}

function parseDebug(buf, view, d, rvaToOffset) {
  const out = [];
  if (!d || d.offset < 0) return out;
  for (let i = 0; i < 16; i += 1) {
    const o = d.offset + i * 28;
    if (o + 28 > buf.length) break;
    const type = view.getUint32(o + 12, true);
    const size = view.getUint32(o + 16, true);
    const addrRva = view.getUint32(o + 20, true);
    const ptrRaw = view.getUint32(o + 24, true);
    const off = rvaToOffset(addrRva) >= 0 ? rvaToOffset(addrRva) : ptrRaw;
    const entry = { type, typeName: debugTypeName(type), size, fileOffset: off };
    if (type === 0 && off >= 0 && off + size <= buf.length) {
      const p = new DataView(buf.buffer, buf.byteOffset + off, size);
      entry.pdb = {
        signature: `0x${p.getUint32(0, true).toString(16)}`,
        age: p.getUint32(4, true),
        path: buf.toString('latin1', off + 8, off + Math.min(size, 8 + 260)).replace(/\0+$/, ''),
      };
    }
    out.push(entry);
  }
  return out;
}

function debugTypeName(t) {
  return { 0: 'CODEVIEW (PDB)', 2: 'VC_FEATURE', 4: 'POGO', 5: 'ILTCG', 6: 'MPCLTCG', 13: 'REPRO', 15: 'EXCEPTION_DATA', 16: 'FIXUP' }[t] || `TYPE_${t}`;
}

function parseLoadConfig(buf, view, d, rvaToOffset, bits) {
  if (!d) return null;
  const off = d.offset >= 0 ? d.offset : 0;
  if (off + 4 > buf.length) return null;
  try {
    const size = view.getUint32(off, true);
    const guarded = size >= (bits === 64 ? 304 : 268) || size === 0;
    const sec = off + (bits === 64 ? 144 : 136);
    const secFlags = sec + 4 <= buf.length ? view.getUint32(sec, true) : 0;
    return {
      size,
      staticGuccheckFlags: view.getUint32(off + 8, true),
      loadConfigFlags: view.getUint32(off + (bits === 64 ? 136 : 132), true) || 0,
      guardFlags: secFlags,
      cfgEnabled: (secFlags & 0x0004) !== 0 || guarded,
      longCallsEnabled: (secFlags & 0x1100) !== 0,
      cetEnabled: (secFlags & 0x0100) !== 0,
    };
  } catch {
    return null;
  }
}

function parseResources(buf, view, d, rvaToOffset) {
  if (!d || d.offset < 0) return null;
  const counts = {};
  let total = 0;
  const bump = (name) => {
    counts[name] = (counts[name] || 0) + 1;
  };
  const walk = (off, depth, currentType) => {
    if (depth > 2 || off + 16 > buf.length || total > 6000) return;
    const named = view.getUint16(off + 12, true);
    const idEntries = view.getUint16(off + 14, true);
    const n = Math.min(named + idEntries, 400);
    for (let i = 0; i < n; i += 1) {
      const e = off + 16 + i * 8;
      if (e + 8 > buf.length) return;
      const nameId = view.getUint32(e, true);
      const dataEntry = view.getUint32(e + 4, true);
      if (dataEntry & 0x80000000) {
        const child = rvaToOffset(dataEntry & 0x7fffffff);
        if (child < 0) continue;
        if (depth === 0) {
          const typeName = RESOURCE_TYPES[nameId] || `TYPE_${nameId}`;
          counts[typeName] = counts[typeName] || 0;
          walk(child, depth + 1, typeName);
        } else {
          walk(child, depth + 1, currentType);
        }
      } else {
        total += 1;
        if (currentType) bump(currentType);
      }
    }
  };
  try {
    walk(d.offset, 0, null);
  } catch {
    /* felaktiga resusträd är vanliga i det vilda — fortsätt med det vi har */
  }
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  const manifest = (counts.MANIFEST || 0) > 0;
  return { count: total, types: counts, manifest, icons: counts.ICON || 0, versionInfo: (counts.VERSION || 0) > 0 };
}

export const RESOURCE_TYPES = {
  1: 'CURSOR',
  2: 'BITMAP',
  3: 'ICON',
  4: 'MENU',
  5: 'DIALOG',
  6: 'STRING',
  7: 'FONTDIR',
  8: 'FONT',
  9: 'ACCELERATOR',
  10: 'RCDATA',
  11: 'MESSAGETABLE',
  12: 'GROUP_CURSOR',
  14: 'GROUP_ICON',
  16: 'VERSION',
  17: 'DLGINCLUDE',
  19: 'PLUGPLAY',
  23: 'MANIFEST',
  24: 'ANIMATION',
};

function parseClr(buf, view, d, rvaToOffset) {
  const off = d.offset;
  if (off < 0 || off + 72 > buf.length) return null;
  try {
    const metadataRva = view.getUint32(off + 8, true);
    const flags = view.getUint32(off + 16, true);
    const moff = rvaToOffset(metadataRva);
    if (moff < 0 || buf.toString('latin1', moff, moff + 4) !== 'BSJB') return { managed: true, metadata: null, flags };
    const versionLen = view.getUint32(moff + 12, true);
    const version = buf.toString('latin1', moff + 16, moff + 16 + Math.max(0, versionLen - 1)).replace(/\0+$/, '');
    const streamsOff = moff + 16 + align(versionLen, 4);
    const count = view.getUint16(streamsOff + 2, true);
    const streams = [];
    let p = streamsOff + 4;
    for (let i = 0; i < count; i += 1) {
      const o = view.getUint32(p, true);
      const s = view.getUint32(p + 4, true);
      let end = p + 8;
      while (end < buf.length && buf[end] !== 0) end += 1;
      const name = buf.toString('latin1', p + 8, end);
      streams.push({ name, offset: o, size: s });
      p = align(end + 1, 4);
    }
    const strings = streams.find((s) => s.name === '#Strings');
    const names = [];
    if (strings) {
      const sOff = moff + strings.offset;
      const blob = buf.toString('latin1', sOff, sOff + Math.min(strings.size, 400000)).replace(/\0/g, '\n');
      for (const n of blob.split('\n')) {
        if (n.length > 2 && /^[\w<>`.`]{2,120}$/.test(n)) names.push(n);
        if (names.length > 3000) break;
      }
    }
    return {
      managed: true,
      version,
      flags: { ilOnly: (flags & 1) !== 0, requires64Bit: (flags & 2) !== 0, background: (flags & 4) !== 0 },
      streams: streams.map((s) => ({ name: s.name, size: s.size })),
      typeNames: names.filter((n) => /[A-Z]/.test(n)).slice(0, 400),
      namespaceGuess: unique(names.filter((n) => /^[a-z][\w.]{2,60}$/.test(n))).slice(0, 60),
      tokenCount: 0,
    };
  } catch {
    return null;
  }
}

const align = (n, a) => (Math.ceil(n / a) * a) | 0;

function unique(a) {
  return [...new Set(a)];
}

function parseCert(buf, view, d) {
  if (!d) return { present: false };
  const off = d.offset >= 0 ? d.offset : d.rva;
  if (off + 8 > buf.length) return { present: false };
  const len = view.getUint32(off, true);
  const type = view.getUint16(off + 4, true);
  const blobStart = off + 8;
  const blob = buf.subarray(blobStart, Math.min(buf.length, blobStart + Math.max(0, len - 8)));
  const info = { present: blob.length > 0, length: len, type, typeOk: type === 1, bytes: blob.length, signedDataOffset: blobStart };
  if (blob.length > 16) {
    const txt = blob.toString('latin1');
    const names = txt.match(/[\x20-\x7e]{6,90}/g) || [];
    info.issuers = names.filter((n) => /(Inc|Ltd|Corporation|Authority|CA|Class|Global|Microsoft|DigiCert|Sectigo|Entrust|Let.s Encrypt)/i.test(n)).slice(0, 8);
    info.hashes = names.filter((n) => /^[a-zA-Z0-9+/=]{28,44}$/.test(n)).slice(0, 4);
    info.notAfterGuess = (txt.match(/\d{6}0000\d{2}Z/g) || []).slice(0, 4);
  }
  return info;
}

function countRelocs(view, d, rvaToOffset) {
  const off = rvaToOffset(d.rva);
  if (off < 0) return null;
  let entries = 0;
  let blocks = 0;
  try {
    let p = off;
    while (p + 8 <= view.byteLength && blocks < 4096) {
      const rva = view.getUint32(p, true);
      const size = view.getUint32(p + 4, true);
      if (size < 8 || rva === 0) break;
      entries += Math.max(0, Math.floor((size - 8) / 2));
      blocks += 1;
      p += size;
    }
  } catch {
    /* truncated relocation data */
  }
  return { blocks, entries };
}

function readSymbols(buf, view, off, count) {
  const out = [];
  try {
    for (let i = 0; i < Math.min(count, 64); i += 1) {
      const o = off + i * 18;
      if (o + 18 > buf.length) break;
      const nameOff = view.getUint32(o, true);
      let name = buf.toString('latin1', o, o + 8).replace(/\0+$/, '').trim();
      if (!name && nameOff) {
        const e = buf.indexOf(0, off + count * 18 + nameOff);
        name = buf.toString('latin1', off + count * 18 + nameOff, e === -1 ? o + 40 : e);
      }
      const secNum = view.getInt16(o + 2, true);
      const type = view.getUint16(o + 12, true);
      if (name) out.push({ name, section: secNum, type, storageClass: buf[o + 17] });
    }
  } catch {
    /* coff symbol tables are optional */
  }
  return out;
}

function checksum(buf, sections, sectionsOff) {
  void sections;
  void sectionsOff;
  let sum = 0;
  const len = buf.length - (buf.length % 4);
  for (let i = 0; i < len; i += 4) {
    sum = (sum + buf.readUInt32LE(i)) >>> 0;
    sum = (sum + (sum >>> 16)) >>> 0;
  }
  for (let i = len; i < buf.length; i += 1) sum = (sum + (buf[i] << ((i - len) * 8))) >>> 0;
  return (sum + buf.length) >>> 0;
}

/**
 * "Rich" header: compiler ids XOR:ed with a key, planted before e_lfanew by MSVC.
 * Finns bara i linker-producerade binärer — bra signatur för "var byggdes detta".
 */
function parseRich(buf, e_lfanew) {
  const zone = buf.subarray(0x80, Math.max(0x80, e_lfanew));
  const richAt = zone.indexOf(Buffer.from('Rich', 'ascii'));
  if (richAt < 0) return null;
  const absolute = 0x80 + richAt;
  const key = buf.readUInt32LE(absolute + 4);
  const danAt = zone.lastIndexOf(Buffer.from('DanS', 'ascii'), richAt);
  if (danAt < 0) return { xorKey: `0x${key.toString(16)}`, entries: [], version: null };
  const comps = [];
  for (let p = absolute - 8; p > 0x80 + danAt + 8; p -= 8) {
    const id = buf.readUInt32LE(p) ^ key;
    const ver = buf.readUInt32LE(p + 4) ^ key;
    if (id > 0 && id < 0x100 && ver > 0 && ver < 0x20000000) comps.push({ id, build: (ver >>> 4) & 0xffff, comp: ver & 0xf, tag: `${RICH_COMP[id] || `comp_${id}`}.${ver & 0xf} (${(ver >>> 4) & 0xffff})` });
  }
  return { xorKey: `0x${key.toString(16)}`, entries: comps.reverse(), compilers: unique(comps.map((c) => c.tag)) };
}

const RICH_COMP = {
  1: 'Linker',
  2: 'C/C++ obj',
  3: 'MASM',
  7: 'C 6.x',
  8: 'C 6.x obj',
  12: 'MSIL / .NET',
  13: 'MIDL',
  14: 'MASM64',
  16: 'C 6.x lib',
  20: 'CVres',
  21: 'VB5',
  36: 'VC 2.x',
  39: 'VS 6.0',
  40: 'VS 6.0 SP',
  57: '.NET',
  66: 'Linker 6.x',
  67: 'C 6.x',
  75: 'Linker 8.0',
  76: 'C 8.0',
  119: 'Linker 9.0',
  120: 'VC 9.0 (2008)',
  136: 'Golang (via 64-bit?)',
  140: 'Linker 10.0',
  141: 'VC 10.0',
  160: 'Linker 11.0',
  161: 'VC 11.0',
  167: 'VC 11.0 ATL',
  179: 'Linker 12.0',
  180: 'VC 12.0 (2013)',
  192: 'Linker 14.0',
  193: 'VC 14.0 (2015)',
  207: 'VC 14.1 (2017)',
  219: 'VC 14.2 (2019)',
  226: 'Linker 14.29',
  242: 'VC 14.3 (2022)',
  243: 'VC 14.36',
};

function hash(buf) {
  const h = (a) => crypto.createHash(a).update(buf).digest('hex');
  return { md5: h('md5'), sha1: h('sha1'), sha256: h('sha256'), size: buf.length };
}

/** Imphash: md5 av "dll!func;" för importerade namn (ordinaler som ordinalN). */
export function imphash(imports) {
  const parts = [];
  for (const imp of imports || []) {
    const dll = String(imp.dll || '').toLowerCase();
    for (const f of imp.functions || []) {
      if (f.ordinal != null) parts.push(`${dll}:ordinal${f.ordinal}`);
      else parts.push(`${dll}.${stripOrdinal(String(f.name).toLowerCase())}`);
    }
  }
  if (!parts.length) return null;
  return crypto.createHash('md5').update(parts.join('').toLowerCase()).digest('hex');
}

function stripOrdinal(n) {
  return n.replace(/@.*$/, '');
}
