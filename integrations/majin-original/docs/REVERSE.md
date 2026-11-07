# MAJIN RE

Everything below runs **in-process** in plain JavaScript — no python, no native modules, no
required install. External tools are an upgrade, never a dependency.

## The twenty-two `re.*` tools

| tool | what it answers |
|---|---|
| `re.analyze` | the whole picture: format, headers, sections, imports, exports, strings, IOCs, entropy, packers, yara hits, overlay, risk score + next steps |
| `re.strings` | printable runs with offsets, min length, encoding filter, dedupe |
| `re.hexdump` | hex+offset+ascii window, `at`/`len`, and a `raw` block for saving |
| `re.search` | find bytes/patterns/regex in a file, returns offsets and context |
| `re.entropy` | overall entropy plus a per-window profile (blocks over the threshold) |
| `re.sections` | section table with per-section entropy, characteristics, anomalies |
| `re.imports` | import table grouped per dll, flagged by behaviour (inject, keylog, creds, ransom, anti-debug, downloader) |
| `re.exports` | export list (ordinal + name), useful for DLL triage |
| `re.yara` | run YARA rules — built-in mini engine, or the real `yara` binary if installed |
| `re.spec` | turn the investigation into `SPEC.md`: behaviour, inputs/outputs, formats, error handling, plus an `Uncertain` list — every claim carries the offset it came from, so a rebuild has evidence instead of a story |
| `re.rules` | `list` / `save` / `delete` YARA rules in `<home>/rules/majin.yar`, built-ins counted separately |
| `re.iocs` | extract URLs, IPs, registry keys, paths, e-mails, filenames, mutex-like strings |
| `re.overlay` | data after the last section, and carve it out if you want |
| `re.extract` | carve embedded containers (ZIP/APK/PE/gzip/7z …) with a per-byte scan |
| `re.apk` | zip-aware APK/ZIP peek: entries, manifest, dex list, sizes |
| `re.pcap` | read capture headers, packet counts, and the first endpoints/hosts |
| `re.diff` | byte/section/import diff between two files (variants, versions) |
| `re.modules` | modules loaded in a running process (Windows: `Get-Process -Module`) |
| `re.disasm` | linear disassembly (capstone if installed, otherwise an x86-64/ARM subset) |
| `re.unpack` | try known packers: `upx -d` when present, heuristics otherwise |
| `re.hash` | MD5/SHA1/SHA256 + imphash (`meta.hashes` carries the full values for reuse) |
| `re.tool` | drive an external tool: ghidra (headless), rizin, objdump, binwalk, upx, yara, jadx, apktool, ilspycmd, nm |
| `re.tools` | what of the above is installed and at which version |

## Formats handled natively

* **PE** (`.exe`, `.dll`, `.sys`): DOS header, COFF, optional header 32/64, sections + raw vs
  virtual entropy, data directories, import/export tables, resource tree, TLS callbacks,
  load config (ASLR/CFG), certificate presence (signed / not signed), debug directory
  (PDB paths), `.reloc` counts, delay imports, and the classic anomalies: entry point outside any
  section, writable+executable section, future/zeroed timestamp, overlay, high-entropy tail.
* **ELF**: class, endianness, type, machine, entry, program headers, section headers, symbols,
  dynamic dependencies, RPATH/RUNPATH, stripped detection.
* **Mach-O** (best effort): magic/endian, commands, arch.
* **Containers**: ZIP/JAR/APK/AAB (central directory, `AndroidManifest`, `classes*.dex`),
  gzip/zlib/bzip2/xz, PE resources, APK signing block, pcap (four magics, nanosecond variants).
* **Text**: script/language detection, key and endpoint grep, JSON/TOML/YAML notes.

## Risk score

`re.analyze` ends with a score 0–100, a `low / medium / elevated / high` band, and the reason
list — so a claim is never unexplained. Points come from severity-5 APIs (24), injection
patterns (up to 24), keylogging (14), shadow-copy deletion (16), credential access (12), an
anti-debug cluster (8), a downloader (10), RWX sections (10), an identified packer (8),
an entry point outside any section (14), a future/zeroed timestamp (6/4), a high-entropy last
section (6+), overlay (up to 6), unsigned PE (6), a high-severity YARA hit (15), hard-coded IP
URLs (8) and suspicious strings (10).

## YARA without yara

`src/core/binary/yara.js` is a working subset: ASCII strings, `wide`, `nocase`, hex patterns with
`??` wildcards and `(aa|bb)` alternatives, `/regex/`, and conditions with `and`, `or`, `not`,
`any of them`, `all of them`, `N of them`, `filesize > N`, `pe.number_of_sections`, `pe.entrypoint`.
It compiles to a small matcher and scans in pure JS — which means MAJIN can run rules *while
answering*, without shelling out. Install real yara and `re.yara` prefers the binary when `yara` is on PATH
(external "auto"), and falls back to the mini engine when it is not.

`rules/majin.yar` ships with the app and is seeded into `<home>/rules/` on first run, so you can
add your own `.yar` files there (or point `tools.re.yaraRules` at a directory) and get them on
every analysis. The built-in set catches packers/protectors, macro-heavy Office, embedded PE,
suspicious IOCs, script droppers and known-family markers.

## CLI, no server

```bash
majin re C:\Users\you\Downloads\invoice.exe          # report as text
majin re sample.bin --json | jq '.strings.iocs'      # machine-readable
majin doctor --full                                  # which RE parts are real: parsers, rules,
                                                     # yara, capstone, ghidra, rizin, objdump, upx
```

## Working rules MAJIN follows

* **Never execute the sample.** The `re.*` tools only read. If you need behaviour, ask for a
  sandbox run — the agent will say it cannot rather than run it on the host.
* **Evidence with offsets.** Strings and IOC rows carry file offsets, so a claim points at bytes.
* **`re.analyze` first**, then narrow with `re.strings`/`re.search`/`re.disasm`; do not re-read a
  whole 300 MB file when a window is enough.
* **Missing tools are refused politely.** `re.tool` returns `<tool> is not installed on this
  machine` and names the install command. The agent then falls back to the built-in path.
