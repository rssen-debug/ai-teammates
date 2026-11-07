/**
 * MAJIN RE — opcode-skanning.
 * Ingen disassembler behövs för att hitta det som faktiskt sticker i ögonen:
 * syscall-ställen, shellcode-prolog, API-hashing-loopar, dekoder-loopar,
 * stack-strings och jmp-sleds. Detta är en byte-skanner, ärligt namngiven.
 */

const PATTERNS = [
  { name: 'x64 syscall (0f 05)', re: /0f05/g, risk: 3, what: 'direct syscall — skips ntdll hooks', max: 4000 },
  { name: 'int 0x2e (x86 syscall)', re: /cd2e/g, risk: 3, what: 'software interrupt for syscall on 32-bit', max: 2000 },
  { name: 'sysenter', re: /640f34/g, risk: 2, what: 'older syscall instruction', max: 2000 },
  { name: 'x64 function prologue', re: /554889e5/g, what: 'standard push rbp; mov rbp, rsp (function prologue)', max: 20000 },
  { name: 'shellcode getpc (call $+5; pop)', re: /e8[0-9a-f]{8}5d/g, risk: 4, what: 'call + pop — classic position-independent shellcode' },
  { name: 'ROR-13 API hashing', re: /c1c80d/g, risk: 4, what: 'ror eax, 0xd — Metasploit/Emotet-style API hash' },
  { name: 'stack-string build', re: /6a[0-9a-f]{2}58/g, risk: 3, what: 'push imm + pop rax — builds strings on the stack' },
  { name: 'xor-dekod loop', re: /8030[0-9a-f]{2}4075/g, risk: 4, what: 'xor [eax], imm; inc eax; jne — single-byte XOR-avpackning' },
  { name: 'jmp sled', re: /e9[0-9a-f]{8}e9/g, risk: 2, what: 'jmp after jmp — scrambled control flow (packed)' },
  { name: 'nop sled', re: /90{4,}/g, what: 'padding/nop landing (alignment or exploit filler)', max: 20000 },
  { name: 'PAGE_EXECUTE_READWRITE imm', re: /684010000|6a40/g, risk: 1, what: '0x40 is often loaded before VirtualAlloc' },
  { name: 'PEB fetch (fs:[0x30])', re: /64488b3d|65488b3d|64a130000000/g, risk: 4, what: 'reads the PEB — anti-debug / unhooking' },
  { name: 'dr0-dr3 check (mov from debug reg)', re: /0f21[0-9a-f]{2}/g, risk: 5, what: 'reads debug registrations — sandbox/anti-debug' },
  { name: 'cpuid vm-detect', re: /0fa2/g, risk: 2, what: 'cpuid — used to detect VMs' },
];

export function opcodeScan(buf, report, format) {
  const out = [];
  const targets = (report.sections || []).filter((s) => s.executable && s.rawSize > 0).slice(0, 6);
  const ranges = targets.length ? targets.map((s) => ({ name: s.name, start: s.rawPointer, end: Math.min(buf.length, s.rawPointer + s.rawSize) })) : [{ name: 'file', start: 0, end: Math.min(buf.length, 4_000_000) }];
  for (const r of ranges) {
    const slice = buf.subarray(r.start, r.end);
    if (!slice.length) continue;
    const hexStr = slice.toString('hex');
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let n = 0;
      const offsets = [];
      while (n < (p.max || 1000)) {
        const m = p.re.exec(hexStr);
        if (!m) break;
        n += 1;
        if (offsets.length < 6) offsets.push(r.start + m.index / 2);
      }
      if (n > 0 && (n >= 3 || (p.risk || 0) >= 3)) out.push({ name: p.name, section: r.name, count: n, risk: p.risk || 1, what: p.what, offsets: offsets.map((o) => `0x${o.toString(16)}`) });
    }
  }
  out.sort((a, b) => b.risk - a.risk || b.count - a.count);
  const entropyRise = (report.sections || []).filter((s) => s.entropy > 7.2).map((s) => `${s.name}:${s.entropy}`);
  return { format, hits: out.slice(0, 40), highEntropySections: entropyRise, scanned: ranges.map((r) => ({ section: r.name, bytes: r.end - r.start })) };
}

/** Hitta NUL-fri kördatabar (shellcode-kandidater) i en sektion. */
export function findCodeIslands(buf, { minBytes = 64, max = 12 } = {}) {
  const islands = [];
  let run = 0;
  let start = -1;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x00) {
      if (run >= minBytes && start >= 0) islands.push({ start, length: run });
      run = 0;
      start = -1;
    } else {
      if (start < 0) start = i;
      run += 1;
    }
    if (islands.length >= max * 40) break;
  }
  const scored = islands
    .map((x) => {
      const slice = buf.subarray(x.start, x.start + x.length);
      let printable = 0;
      for (const b of slice) if (b >= 32 && b < 127) printable += 1;
      return { ...x, printable: Number((printable / x.length).toFixed(2)) };
    })
    .filter((x) => x.printable < 0.12)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
  return scored.map((x) => ({ offset: `0x${x.start.toString(16)}`, bytes: x.length, printableRatio: x.printable, head: buf.subarray(x.start, x.start + 32).toString('hex').replace(/../g, '$1 ').trim() }));
}
