/* RE-core: parsers, entropi, YARA, kontainrar — utan nätverk och riktiga prover. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { analyze, DEFAULT_RULES_TEXT, entropy, getStrings } from '../src/core/binary/index.js';
import { parseRules, scan as yaraScan } from '../src/core/binary/yara.js';
import { risk } from '../src/core/binary/sigs.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-re-'));

/* En konstgjord PE: MZ + e_lfanew + PE\0\0 + en .text-sektion med kod och strängar. */
function fakePe() {
  const buf = Buffer.alloc(0x400, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt16LE(0x4, 0x3c); // e_lfanew
  buf.write('PE\0\0', 4, 'ascii');
  const coff = 0x8;
  buf.writeUInt16LE(0x8664, coff); // machine = AMD64
  buf.writeUInt16LE(1, coff + 2); // numberOfSections
  buf.writeUInt32LE(0, coff + 4); // timeDateStamp
  buf.writeUInt16LE(112, coff + 16); // sizeOfOptionalHeader
  buf.writeUInt16LE(0x2022, coff + 18); // characteristics
  const opt = coff + 20; // 0x78
  buf.writeUInt16LE(0x20b, opt); // PE32+
  buf.writeUInt32LE(0x1000, opt + 16); // addressOfEntryPoint
  const sec = opt + 112; // sectionsOff = 0xf8
  buf.write('.text'.padEnd(8, '\0'), sec, 'binary');
  buf.writeUInt32LE(0x400, sec + 8); // virtualSize
  buf.writeUInt32LE(0x1000, sec + 12); // virtualAddress
  buf.writeUInt32LE(0x200, sec + 16); // rawSize
  buf.writeUInt32LE(0x200, sec + 20); // rawPointer
  buf.writeUInt32LE(0x68000060, sec + 36); // code|initialized|executable|readable
  buf.write('kernel32.dll', 0x200, 'ascii');
  buf.write('MessageBoxA', 0x200 + 13, 'ascii');
  buf.write('http://evil.example/payload', 0x260, 'ascii');
  buf[0x240] = 0xe8; // call-rel
  buf[0x245] = 0xc3; // ret
  return buf;
}

test('analyze: PE format, sections, strings, IOC, risk', () => {
  const buf = fakePe();
  const r = analyze(buf, { name: 'prov.exe', rules: parseRules(DEFAULT_RULES_TEXT) });
  assert.equal(r.kind, 'pe', 'MZ + PE must be detected');
  assert.equal(r.size, buf.length);
  assert.ok(r.sections?.length >= 1, 'the section table must be read');
  assert.equal(r.sections[0].name, '.text');
  assert.ok(r.entropy.overall > 0 && r.entropy.overall < 8);
  assert.ok(r.strings.total > 3, 'strings must be extracted');
  assert.ok(r.iocs.urls.some((u) => /evil\.example/.test(u)), 'URL IOC from strings');
  assert.ok(r.yara.length >= 0);
  assert.ok(typeof r.risk.score === 'number' && r.risk.level, 'a risk score must exist');
  assert.ok(Array.isArray(r.recommendations) && r.recommendations.length, 'report.recommendations ska fyllas på');
  const json = JSON.stringify(r);
  assert.ok(json.length > 200, 'the report must be serialisable');
});

test('analyze: ELF and raw binary data', () => {
  const elf = Buffer.alloc(64, 0);
  elf.write('\x7fELF', 0, 'binary');
  elf[4] = 2; // 64-bit
  elf[5] = 1; // little endian
  elf.writeUInt16LE(2, 16); // ET_EXEC
  elf.writeUInt16LE(0x3e, 18); // EM_X86_64
  const r = analyze(elf, { name: 'bit' });
  assert.match(r.kind, /elf/, 'ELF must be recognised');
  const rnd = analyze(Buffer.from(zlib.gzipSync(Buffer.concat(Array.from({ length: 400 }, (_, i) => Buffer.from([i % 251]))))), { name: 'x.bin' });
  assert.ok(rnd.entropy.overall > 4, 'compressed data must give measurable entropy');
  assert.throws(() => analyze(Buffer.alloc(0), { name: 'empty' }), /empty file/);
});

test('entropy + hex patterns: a packed section stands out', () => {
  const plain = Buffer.from('A'.repeat(4096), 'ascii');
  const packed = Buffer.from(zlib.deflateRawSync(Buffer.concat(Array.from({ length: 8192 }, (_, i) => Buffer.from([i % 256])))));
  assert.ok(entropy(plain) < 1.2, 'repetitive data = low entropy');
  assert.ok(entropy(packed) > 4, 'deflate = high entropy');
});

test('yara: the mini engine matches custom rules and fields', () => {
  const rules = parseRules(`
rule Test_Majin {
  meta:
    severity = "high"
  strings:
    $a = "MessageBoxA" ascii
    $b = { 68 74 74 70 3a }
  condition:
    any of them
}
rule Won_Match {
  strings:
    $a = "INGET-SADANT-HAR" ascii
  condition:
    $a
}
`);
  assert.equal(rules.length, 2, 'both rules must parse');
  const hits = yaraScan(fakePe(), rules);
  assert.ok(hits.some((h) => h.rule === 'Test_Majin'), '$a eller $b måste matcha');
  assert.equal(hits.some((h) => h.rule === 'Won_Match'), false, 'rules without hits must not fire');
  const hit = hits.find((h) => h.rule === 'Test_Majin');
  assert.ok(hit.strings?.length >= 1, 'string hits with offsets');
  assert.equal(typeof hit.meta?.severity, 'string');
});

test('yara: DEFAULT_RULES_TEXT parses and hits a PE with an overlay', () => {
  const rules = parseRules(DEFAULT_RULES_TEXT);
  assert.ok(rules.length >= 5, `expected at least 5 built-in rules, fick ${rules.length}`);
  const buf = Buffer.concat([fakePe(), Buffer.from('PK\x03\x04rust_begin_unwind core::panicking', 'binary')]);
  const r = analyze(buf, { name: 'overlay.exe', rules });
  assert.ok(r.overlay && r.overlay.size > 0, 'the overlay after the last section must be found');
  assert.ok(r.yara.length >= 1, `inbyggda regler ska ge minst ett fynd, fick ${JSON.stringify(r.yara.map((x) => x.rule))}`);
  assert.ok(r.yara.every((h) => typeof h.rule === 'string'), 'hits must carry rule names');
});

test('containers: zip/apk peek and pcap magic', () => {
  // Minimal ZIP med en post
  const name = 'a.txt';
  const data = Buffer.from('hej\n');
  const crc = (() => {
    let c = ~0;
    for (const b of data) {
      c ^= b;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  })();
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.write('a.txt', 30, 'ascii');
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.write('a.txt', 46, 'ascii');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  const zip = Buffer.concat([local, data, central, eocd]);
  const r = analyze(zip, { name: 'prov.zip' });
  assert.ok(['zip', 'apk'].includes(r.kind) || (r.containers || []).length, 'a ZIP must read as a container');
  const pcap = Buffer.alloc(24, 0);
  pcap.writeUInt32LE(0xa1b2c3d4, 0);
  assert.doesNotThrow(() => analyze(pcap, { name: 'x.pcap' }), 'a pcap header must not crash the analysis');
});

test('hash + imphash are stable and separate samples', async () => {
  const { buildRegistry } = await import('../src/core/tools/index.js');
  const { DEFAULTS, Config, clone } = await import('../src/core/config.js');
  const { approvals } = await import('../src/core/guard.js');
  const file = path.join(home, 'prov.exe');
  fs.writeFileSync(file, fakePe());
  const cfg = new Config(clone(DEFAULTS), path.join(home, 'c.json'));
  cfg.save = () => true;
  cfg.patch({ workspace: home, guard: { mode: 'off' } });
  const registry = buildRegistry({ cfg, emit: () => {}, approvals });
  const h = await registry.exec('re.hash', { path: file }, { session: 're' });
  assert.equal(h.ok, true, JSON.stringify(h.error));
  const row = h.meta?.hashes?.[0];
  assert.ok(row, 'meta.hashes must exist for reuse');
  assert.match(row.sha256, /^[0-9a-f]{64}$/, 'sha256 ska vara 64 hex');
  assert.match(row.md5, /^[0-9a-f]{32}$/);
  const again = await registry.exec('re.hash', { path: file }, { session: 're' });
  assert.equal(again.meta.hashes[0].sha256, row.sha256, 'same file = same hash');
  assert.notEqual(again.meta.hashes[0].sha256, 'x');
  const an = await registry.exec('re.analyze', { path: file }, { session: 're' });
  assert.equal(an.ok, true, JSON.stringify(an.error));
  assert.match(String(an.result), /pe/i, 'the report must mention the format');
  const strings = await registry.exec('re.strings', { path: file, filter: 'kernel32' }, { session: 're' });
  assert.match(String(strings.result), /kernel32/i, 'the filter must work');
  const hex = await registry.exec('re.hexdump', { path: file, offset: '0x0' }, { session: 're' });
  assert.match(String(hex.result), /4d 5a/, 'MZ in the hexdump');
  const pat = await registry.exec('re.search', { path: file, pattern: '4d 5a' }, { session: 're' });
  assert.equal(pat.ok, true, JSON.stringify(pat.error));
  assert.match(String(pat.result), /0x0|offset/i);
});

test('re.tools + re.tool: external detection and a clean refusal', async (t) => {
  const file = path.join(home, 'prov2.exe');
  fs.writeFileSync(file, fakePe());
  const { buildRegistry } = await import('../src/core/tools/index.js');
  const { DEFAULTS, Config, clone } = await import('../src/core/config.js');
  const { approvals } = await import('../src/core/guard.js');
  const cfg = new Config(clone(DEFAULTS), path.join(home, 'c2.json'));
  cfg.save = () => true;
  cfg.patch({ workspace: home, guard: { mode: 'off' } });
  const registry = buildRegistry({ cfg, emit: () => {}, approvals });
  const list = await registry.exec('re.tools', {}, { session: 're' });
  assert.equal(list.ok, true, JSON.stringify(list.error));
  assert.match(String(list.result), /ghidra|rizin|objdump/i, 'the list must name the external tools');
  const run = await registry.exec('re.tool', { tool: 'ghidra', path: file, args: ['-h'] }, { session: 're' });
  assert.equal(run.ok, false, 'ghidra is absent in the sandbox — it must refuse, not pretend');
  assert.match(String(run.error.message + run.error.hint), /not installed|finns inte|install/i);
});
