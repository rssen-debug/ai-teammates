/**
 * MAJIN RE — analysmotorn.
 * En ingång: analyze(buffer) → en strukturerad rapport en modell kan läsa direkt.
 * Inget av stegen kräver extern mjukvara; extern verktyg (ghidra/rizin/objdump)
 * kopplas på automatiskt om de finns, annars fungerar allt ändå.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { entropy, strings as getStrings, classify as classifyStrings, entropyProfile } from './strings.js';
import { scanEmbedded } from './containers.js';
import { parsePe } from './pe.js';
import { parseElf, parseMachO } from './elf.js';
import { detectFormat, peekContainer } from './containers.js';
import { scan as yaraScan } from './yara.js';
import { scoreApis, detectPackers, risk } from './sigs.js';
import { opcodeScan } from './scan.js';

export const DEFAULT_RULES_TEXT = `
rule Packer_UPX : packer {
  meta:
    severity = "low"
    author = "majin"
  strings:
    $s1 = "UPX0" ascii
    $s2 = "UPX1" ascii wide
    $s3 = "UPX!" ascii
  condition:
    any of them and filesize < 200MB
}

rule Suspicious_Injection : injection behav {
  meta:
    severity = "high"
  strings:
    $a = "NtUnmapViewOfSection" ascii
    $b = "WriteProcessMemory" ascii
    $c = "CreateRemoteThread" ascii
    $d = "SetThreadContext" ascii
    $e = "VirtualAllocEx" ascii
  condition:
    2 of them
}

rule Anti_Debug : evasion {
  meta:
    severity = "medium"
  strings:
    $a = "IsDebuggerPresent" ascii
    $b = "CheckRemoteDebuggerPresent" ascii
    $c = "OutputDebugStringA" ascii
    $d = "NtQueryInformationProcess" ascii
    $e = "SeDebugPrivilege" ascii wide
  condition:
    2 of them
}

rule Ransomware_Behaviour : ransom behav {
  meta:
    severity = "high"
  strings:
    $a = "vssadmin" ascii nocase
    $b = "wbadmin" ascii nocase
    $c = "shadow copies" ascii nocase
    $d = "CryptEncrypt" ascii
    $e = "README_FOR_DECRYPT" ascii nocase
    $f = ".locked" ascii nocase
    $g = "restore your files" ascii nocase wide
  condition:
    3 of them
}

rule Downloader_Behav : c2 net {
  meta:
    severity = "high"
  strings:
    $a = "URLDownloadToFileA" ascii
    $b = "InternetOpenUrlA" ascii
    $c = "WinHttpOpen" ascii
    $d = "POST /" ascii
    $e = "User-Agent: " ascii
  condition:
    ($a or $b or $c) and ($d or $e)
}

rule Embedded_Powershell : script behav {
  meta:
    severity = "medium"
  strings:
    $a = "-EncodedCommand" ascii nocase
    $b = "frombase64string" ascii nocase
    $c = "powershell.exe" ascii nocase wide
    $d = "Invoke-Expression" ascii nocase
  condition:
    any of them
}

rule VM_Detection : evasion sandbox {
  meta:
    severity = "medium"
  strings:
    $a = "VMware, Inc" ascii
    $b = "VBOX" ascii
    $c = "VirtualBox" ascii nocase
    $d = "qemu" ascii nocase
    $e = "Sandboxie" ascii nocase
    $f = "GetSystemFirmwareTable" ascii
  condition:
    any of them
}

rule DotNet_SingleFile : framework {
  meta:
    severity = "info"
  strings:
    $a = "single-file-host" ascii nocase
    $b = "DOTNET_64" ascii
    $c = "System.Private.CoreLib" ascii
  condition:
    2 of them
}

rule Electron_App : framework {
  meta:
    severity = "info"
  strings:
    $a = "electron.asar" ascii
    $b = "chrome_100_percent.pak" ascii
    $c = "resources.pak" ascii
  condition:
    2 of them
}

rule Go_Binary : framework {
  meta:
    severity = "info"
  strings:
    $a = "go:buildid" ascii
    $b = "runtime.gopanic" ascii
    $c = "goroutine " ascii
  condition:
    2 of them
}

rule Rust_Binary : framework {
  meta:
    severity = "info"
  strings:
    $a = "rust_begin_unwind" ascii
    $b = "core::panicking" ascii
    $c = "invalid safety" ascii nocase
  condition:
    any of them
}
`;

export function analyze(buf, opts = {}) {
  const { name = 'buffer', rules = [], maxStrings = 4000 } = opts;
  const t0 = Date.now();
  if (!buf?.length) throw new Error('empty file');
  const format = detectFormat(buf);
  const full = entropy(buf, 0, Math.min(buf.length, 4_000_000));
  const strs = getStrings(buf, { limit: maxStrings });
  const text = strs.slice(0, 1500).map((s) => s.value).join('\n');

  const report = {
    file: name,
    ext: path.extname(name).toLowerCase(),
    size: buf.length,
    kind: format.kind,
    detected: format.detected,
    entropy: { overall: full, profile: entropyProfile(buf) },
    strings: { total: strs.length, sample: strs.slice(0, 120) },
    iocs: classifyStrings(strs.slice(0, 8000).map((s) => s.value)),
    yara: yaraScan(buf, rules),
    timings: {},
  };

  let pe = null;
  let elf = null;
  let macho = null;
  if (format.kind === 'pe') {
    pe = safe(() => parsePe(buf), report);
    if (pe) {
      for (const s of pe.sections) s.entropy = entropy(buf, s.rawPointer, Math.min(buf.length, s.rawPointer + s.rawSize));
      report.arch = pe.arch;
      report.bits = pe.bits;
      report.subsystem = pe.optional.subsystem;
      report.isDll = pe.isDll;
      report.entry = pe.entryPoint;
      report.sections = pe.sections.map(({ name: n, virtualAddress, virtualSize, rawSize, rawPointer, entropy: e, flags, executable, writable, readable }) => ({ name: n, rva: virtualAddress, virtualSize, rawSize, rawPointer, entropy: e, flags, executable, writable, readable }));
      report.characteristics = pe.characteristics;
      report.timestamp = pe.timestamp;
      report.hashes = pe.hashes;
      report.imphash = pe.imphash;
      report.dllFlags = pe.optional.dllFlags;
      report.security = {
        aslr: pe.optional.dllFlags.some((f) => /DYNAMIC_BASE/.test(f.name)),
        dep: pe.optional.dllFlags.some((f) => /NX_COMPAT/.test(f.name)),
        cfg: Boolean(pe.loadConfig?.cfgEnabled),
        gs: pe.optional.dllFlags.some((f) => /INTEGRITY/.test(f.name)),
        controlFlowGuard: pe.optional.dllFlags.some((f) => /GUARD_CF/.test(f.name)),
        signed: pe.certificate?.present || false,
        certLength: pe.certificate?.bytes || 0,
        certTypeOk: pe.certificate?.typeOk ?? null,
        signers: pe.certificate?.issuers || [],
      };
      report.rich = pe.rich;
      report.imports = pe.imports.map((i) => ({ dll: i.dll, count: i.count, functions: i.functions.slice(0, 80).map((f) => f.name) }));
      report.importCount = pe.imports.reduce((n, i) => n + i.count, 0);
      report.exports = pe.exports ? { dllName: pe.exports.dllName, count: pe.exports.numNames, functions: pe.exports.functions.slice(0, 60).map((f) => f.name) } : null;
      report.delayImports = (pe.delayImports || []).map((d) => ({ dll: d.dll, count: d.count }));
      report.tls = pe.tls;
      report.resources = pe.resources;
      report.debug = pe.debug;
      report.pdb = pe.debug?.find((d) => d.pdb)?.pdb?.path || null;
      report.relocations = pe.relocations;
      report.overlay = pe.overlay;
      report.dotnet = pe.dotnet;
      report.symbols = pe.symbols?.slice(0, 40) || [];
      report.sectionsOfInterest = pe.sections
        .map((s) => ({ ...s, ratio: s.rawSize ? s.rawSize / buf.length : 0 }))
        .filter((s) => s.entropy > 7 || (s.executable && s.writable))
        .map((s) => ({ name: s.name, entropy: s.entropy, executable: s.executable, writable: s.writable, size: s.rawSize }));
    }
  } else if (format.kind === 'elf') {
    elf = safe(() => parseElf(buf), report);
    if (elf) {
      Object.assign(report, {
        arch: elf.arch,
        bits: elf.bits,
        elfType: elf.type,
        pie: elf.pie,
        interpreter: elf.interpreter,
        entry: { rva: elf.entry },
        sections: elf.sections.map((s) => ({ name: s.name, rva: s.addr, rawSize: s.size, rawPointer: s.offset, entropy: entropy(buf, s.offset, Math.min(buf.length, s.offset + s.size)), executable: s.executable, writable: s.writable })),
        segments: elf.segments,
        imports: elf.imports.slice(0, 400).map((n) => ({ name: n })),
        importCount: elf.imports.length,
        exports: elf.exports?.length ? { count: elf.exports.length, functions: elf.exports.slice(0, 60) } : null,
        dynamic: elf.dynamic,
        symbols: elf.symbols,
        stripped: elf.stripped,
        hashes: elf.hashes,
        notes: elf.notes,
      });
    }
  } else if (format.kind === 'macho') {
    macho = safe(() => parseMachO(buf), report);
    if (macho) {
      Object.assign(report, { arch: macho.cpu, bits: macho.bits, machoType: macho.filetype, sections: macho.segments, dylibs: macho.dylibs, hashes: macho.hashes, flags: macho.flags });
    }
  } else {
    report.hashes = hashLite(buf);
    report.sections = [];
  }

  const apis = scoreApis(pe ? pe.imports.map((i) => ({ dll: i.dll, functions: i.functions })) : elf ? [{ dll: 'dynsym', functions: (elf?.imports || []).map((n) => ({ name: n })) }] : []);
  report.apis = { flagged: apis.flagged, tags: apis.tags, unique: apis.unique };
  report.packers = detectPackers({ sections: report.sections || [], overlay: pe?.overlay || { size: report.overlay?.size || 0 }, strings: text, importsCount: report.importCount || 0 });
  report.containers = peekContainer(buf, { name, strings: strs.slice(0, 4000).map((s) => s.value) });
  report.embedded = scanEmbedded(buf, { limit: 18 });
  report.opcodes = pe || elf ? opcodeScan(buf, report, format.kind) : null;
  report.risk = risk(report);
  report.recommendations = nextSteps(report, format);
  report.timings.totalMs = Date.now() - t0;
  return report;
}

function safe(fn, report) {
  try {
    return fn();
  } catch (err) {
    report.parseError = { message: err.message, code: err.code || null, hint: err.hint || null, offset: err.offset ?? null };
    return null;
  }
}

function hashLite(buf) {
  const h = (a) => crypto.createHash(a).update(buf).digest('hex');
  return { md5: h('md5'), sha1: h('sha1'), sha256: h('sha256'), size: buf.length };
}

/**
 * Stegen en RE-person skulle taga härnäst — genererat från rapporten, inte gissat.
 */
function nextSteps(r, format) {
  const out = [];
  if (r.parseError) out.push(`the header failed to parse (${r.parseError.message}). For PE: ${r.kind === 'pe' ? 'check e_lfanew and section alignment' : 'cut the first 4 KB into a hexdump'}.`);
  if (r.packers?.some((p) => /UPX/.test(p.packer))) out.push('Likely UPX: run `upx -d file` (or re.unpack when upx is installed) and analyse the unpacked copy.');
  if (r.packers?.some((p) => /VMProtect|Themida|Enigma/.test(p.packer))) out.push('Commercial protector: static analysis is near-useless first. Run it in a sandbox and trace API calls instead.');
  if ((r.sections || []).some((s) => s.executable && s.writable)) out.push('Section that is both writable and executable — unpack it, or dump process memory and analyse that block.');
  if (r.entry && r.entry.inImage === false) out.push('Entry point outside the image: check the overlay and TLS callbacks; probably a self-extractor.');
  if (r.tls?.count) out.push(`${r.tls.count} TLS callback(s) — decode these first; they run before main and often hide the unpacking stub.`);
  if (r.importCount < 10 && (r.entropy?.overall || 0) > 7) out.push('Few imports + high entropy: almost certainly a packed or encrypted payload. Try dynamic analysis.');
  if (r.apis.flagged.some((f) => f.tags.includes('inject'))) out.push('Injection: break on WriteProcessMemory/CreateRemoteThread in x64dbg and dump the buffer being written.');
  if (r.apis.flagged.some((f) => f.tags.includes('downloader'))) out.push('Downloader: extract the URLs, check the domain age, and fetch the payload in a sandbox (never on the host).');
  if (r.apis.flagged.some((f) => f.tags.includes('ransom'))) out.push('Ransomware pattern: run in an isolated environment with bait documents; record encryption behaviour, key retrieval and the ransom note.');
  if (r.security && r.security.signed === false && r.kind === 'pe') out.push('Unsigned: match the imphash against known families and run the file through a sandbox before trusting it.');
  if (r.dotnet?.managed) out.push('.NET: use ilspycmd/dnSpy (dotnet tool install -g ilspycmd) — managed code is easy to read, do not waste time on assembly.');
  if (r.containers?.some((c) => c.kind === 'apk')) out.push('APK: unpack with apktool, read AndroidManifest.xml, look for URL/permission strings and decompile classes.dex.');
  if (r.containers?.some((c) => c.kind === 'asar')) out.push('Electron: extract the asar archive (npx @electron/asar extract) and read the JS bundle — the logic is there, not in the exe.');
  if (r.overlay?.size > 100000) out.push(`Overlay of ${Math.round(r.overlay.size / 1024)} kB after the last section: dump offset ${r.overlay.offset} and run entropy on that part.`);
  if (r.iocs?.urls?.length) out.push(`${r.iocs.urls.length} URLs — check domain age and the TLS certificate, and fetch with web.fetch in a sandboxed run.`);
  if (!out.length && format.kind === 'text') out.push('Text file: grep it for hard-coded keys, endpoints and secret strings.');
  return out.slice(0, 8);
}

export { entropy, getStrings };
