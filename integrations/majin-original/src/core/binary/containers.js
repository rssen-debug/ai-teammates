/**
 * MAJIN RE — formatdetektering och containrar.
 * Ingen `file`-binär behövs. Magi + en aning struktur för att veta vad vi tittar på.
 */

const SIGS = [
  { kind: 'pe', name: 'Windows PE (EXE/DLL)', magic: 'MZ', exts: ['.exe', '.dll', '.ocx', '.sys', '.cpl', '.lib', '.pyd', '.node', '.drv', '.efi'] },
  { kind: 'elf', name: 'ELF (Linux/Android)', magic: '\x7fELF', exts: ['.so', '.elf', '.bin', '.o', '.ko', ''] },
  { kind: 'macho', name: 'Mach-O', magic: 'cffaedfe', hex: [0xcf, 0xfa, 0xed, 0xfe], exts: ['.dylib', '.app'] },
  { kind: 'macho', name: 'Mach-O', magic: 'cefaedfe', hex: [0xce, 0xfa, 0xed, 0xfe], exts: [] },
  { kind: 'macho', name: 'Mach-O (fat)', magic: 'cafebabe', hex: [0xca, 0xfe, 0xba, 0xbe], exts: [] },
  { kind: 'dex', name: 'Android DEX', magic: 'dex\n0', exts: ['.dex'] },
  { kind: 'apk', name: 'APK/AAB (ZIP)', hex: [0x50, 0x4b, 0x03, 0x04], exts: ['.apk', '.aab'] },
  { kind: 'zip', name: 'ZIP', hex: [0x50, 0x4b, 0x03, 0x04], exts: ['.zip', '.jar', '.war', '.nupkg', '.vsix', '.docx', '.xlsx', '.pptx', '.asar'] },
  { kind: 'sevenz', name: '7z', hex: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], exts: ['.7z'] },
  { kind: 'rar', name: 'RAR', hex: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], exts: ['.rar'] },
  { kind: 'cab', name: 'Microsoft CAB', magic: 'MSCF', exts: ['.cab'] },
  { kind: 'lnk', name: 'Windows LNK', hex: [0x4c, 0x00, 0x00, 0x00], exts: ['.lnk'] },
  { kind: 'pdf', name: 'PDF', magic: '%PDF', exts: ['.pdf'] },
  { kind: 'java', name: 'Java class', hex: [0xca, 0xfe, 0xba, 0xbe], exts: ['.class'] },
  { kind: 'wasm', magic: '\0asm', exts: ['.wasm'] },
  { kind: 'shell', magic: '#!', name: 'Script med shebang', exts: ['.sh'] },
  { kind: 'hex', name: 'Intel HEX', magic: ':02000002', exts: ['.hex', '.ihex'] },
  { kind: 'bin', name: 'Unknown binary', exts: ['.bin', '.dat', '.raw'] },
];

export function detectFormat(buf) {
  const head = buf.subarray(0, 8);
  const hex = head.toString('hex');
  for (const s of SIGS) {
    if (s.hex && Buffer.from(s.hex).equals(head.subarray(0, s.hex.length))) return { ...s, detected: s.name };
    if (s.magic && head.toString('latin1', 0, s.magic.length) === s.magic) return { ...s, detected: s.name };
  }
  if (looksText(buf)) {
    const s = buf.subarray(0, 4096).toString('utf8');
    const kind = /<\?xml|^<[a-z!]/i.test(s) ? 'xml' : /^\s*[{[]/.test(s) ? 'json' : /^\s*(?:function|const|let|=>|import |require\()/m.test(s) ? 'js' : /(^|\n)\s*(def |class |import |from \w+ import)/.test(s) ? 'python' : /CREATE TABLE|SELECT .* FROM/i.test(s) ? 'sql' : /<html|<script/i.test(s) ? 'html' : 'text';
    return { kind, name: `Text (${kind})`, detected: `${kind} (text)`, text: true };
  }
  return { kind: 'unknown', name: 'Unknown format', detected: 'no known signature' };
}

export function looksText(buf) {
  const len = Math.min(buf.length, 2048);
  if (!len) return false;
  let ok = 0;
  for (let i = 0; i < len; i += 1) {
    const c = buf[i];
    if (c === 0 || (c < 9 && c !== 0) || (c > 13 && c < 32)) continue;
    ok += 1;
  }
  return ok / len > 0.92;
}

/** Kika i högen efter kända inre strukturer (zip i exe, pdf i allt, …). */
export function scanEmbedded(buf, { limit = 24 } = {}) {
  const marks = [
    { name: 'ZIP', sig: Buffer.from([0x50, 0x4b, 0x03, 0x04]), kind: 'zip' },
    { name: 'ZIP-empty', sig: Buffer.from([0x50, 0x4b, 0x05, 0x06]), kind: 'zip' },
    { name: '7z', sig: Buffer.from([0x37, 0x7a, 0xbc, 0xaf]), kind: '7z' },
    { name: 'RAR', sig: Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), kind: 'rar' },
    { name: 'CAB', sig: Buffer.from('MSCF\x00\x00\x00\x00', 'latin1'), kind: 'cab' },
    { name: 'ELF', sig: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), kind: 'elf' },
    { name: 'PE', sig: Buffer.from('MZ\x90\x00', 'latin1'), kind: 'pe' },
    { name: 'GZIP', sig: Buffer.from([0x1f, 0x8b]), kind: 'gzip' },
    { name: 'ZSTD', sig: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), kind: 'zstd' },
    { name: 'LZMA', sig: Buffer.from([0x5d, 0x00, 0x00]), kind: 'lzma' },
    { name: 'PDF', sig: Buffer.from('%PDF-'), kind: 'pdf' },
    { name: 'PNG', sig: Buffer.from([0x89, 0x50, 0x4e, 0x47]), kind: 'png' },
    { name: 'JPEG', sig: Buffer.from([0xff, 0xd8, 0xff]), kind: 'jpg' },
    { name: 'PKCS7-signatur', sig: Buffer.from([0x30, 0x82]), kind: 'authenticode', near: true },
  ];
  const hits = [];
  const step = buf.length > 4_000_000 ? 1 : 1;
  for (const m of marks) {
    let from = 0;
    let count = 0;
    while (count < 8) {
      const idx = buf.indexOf(m.sig, from);
      if (idx < 0) break;
      if (idx > 0x1000) hits.push({ kind: m.kind, name: m.name, offset: idx, size: Math.min(buf.length - idx, 0) });
      from = idx + 1;
      count += 1;
      if (from > buf.length) break;
    }
    if (hits.length > limit) break;
  }
  void step;
  return hits.sort((a, b) => a.offset - b.offset).slice(0, limit);
}

/** Tar bort "END" av en zip/7z för att se om filen faktiskt är ett arkiv med innehåll. */
export function peekContainer(buf, { name = '', strings = [] } = {}) {
  const out = [];
  const lower = name.toLowerCase();
  if (buf.length > 30) {
    const eocd = findEOCD(buf);
    if (eocd) {
      const entries = readZipEntries(buf, eocd);
      out.push({
        kind: entries.some((e) => e.name.endsWith('.dex') || e.name === 'AndroidManifest.xml') ? 'apk' : entries.some((e) => e.name.endsWith('.jar')) ? 'jar/zip' : 'zip',
        entries: entries.length,
        sample: entries.slice(0, 40).map((e) => ({ name: e.name, size: e.size, compressed: e.method !== 0 })),
        manifest: entries.find((e) => /manifest|\.json$/i.test(e.name))?.name || null,
      });
    }
  }
  const asar = strings.find((s) => s.includes('"header_size"') || s.includes('electron.asar'));
  if (asar || /\.asar$/i.test(lower)) out.push({ kind: 'asar', note: 'Electron-arkiv — packa upp med npx @electron/asar' });
  if (strings.some((s) => /classes\d*\.dex/.test(s))) out.push({ kind: 'dex', note: 'Android DEX in a container' });
  const nsis = strings.some((s) => /Nullsoft Inst|NSIS/i.test(s));
  if (nsis) out.push({ kind: 'nsis', note: 'NSIS-installationsprogram — Extrahera med 7z/unsis' });
  const inno = strings.some((s) => /Inno Setup/i.test(s));
  if (inno) out.push({ kind: 'inno', note: 'Inno Setup — extrahera med innounp' });
  const msi = buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (msi) out.push({ kind: 'ole', note: 'OLE/MSI container (compound file) — read the streams' });
  return out;
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

function readZipEntries(buf, eocd) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const total = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < total && i < 5000 && cd + 46 <= buf.length; i += 1) {
    if (view.getUint32(cd, true) !== 0x02014b50) break;
    const method = view.getUint16(cd + 10, true);
    const csize = view.getUint32(cd + 20, true);
    const usize = view.getUint32(cd + 24, true);
    const nameLen = view.getUint16(cd + 28, true);
    const extraLen = view.getUint16(cd + 30, true);
    const commentLen = view.getUint16(cd + 32, true);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    out.push({ name, method, size: usize, csize });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export const FORMATS = SIGS;
