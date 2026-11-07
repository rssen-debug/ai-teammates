/**
 * MAJIN RE — entropi + stränghämtning.
 * Shannon-per-sektion är det snabbaste tecken vi har på packad/kryptad data,
 * och strings är den gemensamma nämnaren i all manuell RE.
 */

export function entropy(data, start = 0, end = data.length) {
  const len = Math.max(0, end - start);
  if (!len) return 0;
  const freq = new Array(256).fill(0);
  for (let i = start; i < end; i += 1) freq[data[i]] += 1;
  let e = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / len;
    e -= p * Math.log2(p);
  }
  return Number(e.toFixed(3));
}

/** 256-byte sliding entropy profile — packers look like a flat high band. */
export function entropyProfile(data, blockSize = 512, maxBlocks = 96) {
  const blocks = Math.min(maxBlocks, Math.ceil(data.length / blockSize));
  const out = [];
  const step = Math.max(blockSize, Math.floor(data.length / blocks));
  for (let i = 0; i < data.length && out.length < maxBlocks; i += step) {
    out.push({ off: i, entropy: entropy(data, i, Math.min(data.length, i + step)) });
  }
  return out;
}

const PRINT = /[ -~]/;

export function strings(buf, { min = 5, max = 4096, limit = 20000, encodings = ['ascii', 'utf16'], filter = null, start = 0, end = buf.length } = {}) {
  const out = [];
  const seen = new Set();
  const push = (s, off, kind) => {
    if (s.length < min || s.length > max) return;
    if (filter && !filter(s)) return;
    const key = `${kind}:${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value: s, offset: off, encoding: kind });
  };

  if (encodings.includes('ascii')) {
    let cur = '';
    let curStart = 0;
    for (let i = start; i < end; i += 1) {
      const c = buf[i];
      const ch = String.fromCharCode(c);
      if (c >= 32 && c < 127 && PRINT.test(ch)) {
        if (!cur) curStart = i;
        cur += ch;
      } else if (cur) {
        push(cur, curStart, 'ascii');
        cur = '';
        if (out.length >= limit) return finish(out, buf, limit);
      }
    }
    if (cur) push(cur, curStart, 'ascii');
  }

  if (encodings.includes('utf16')) {
    let cur = '';
    let curStart = 0;
    for (let i = start; i + 1 < end; i += 2) {
      const code = buf[i] | (buf[i + 1] << 8);
      const ok = code >= 32 && code < 127;
      if (ok) {
        if (!cur) curStart = i;
        cur += String.fromCharCode(code);
      } else if (cur) {
        push(cur, curStart, 'utf16le');
        cur = '';
        if (out.length >= limit) break;
      }
    }
    if (cur) push(cur, curStart, 'utf16le');
  }
  return finish(out, buf, limit);
}

function finish(out, buf, limit) {
  return out.slice(0, limit).map((s) => ({ ...s, printableRatio: printableRatio(buf, s.offset, s.value.length) }));
}

function printableRatio(buf, off, len) {
  let ok = 0;
  for (let i = off; i < Math.min(buf.length, off + len); i += 1) if (buf[i] >= 32 && buf[i] < 127) ok += 1;
  return Number((ok / Math.max(1, len)).toFixed(2));
}

/** Cheap classification: extractors are only useful if they sort the noise. */
export function classify(strs) {
  const buckets = { urls: new Set(), ips: new Set(), files: new Set(), registry: new Set(), mutexes: new Set(), emails: new Set(), guid: new Set(), suspicious: new Set(), version: new Set() };
  for (const s of strs) {
    const v = typeof s === 'string' ? s : s.value;
    if (v.length < 4) continue;
    for (const u of v.match(/https?:\/\/[^\s"'<>|)]{4,200}/g) || []) buckets.urls.add(u);
    for (const ip of v.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g) || []) buckets.ips.add(ip);
    for (const e of v.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g) || []) buckets.emails.add(e);
    for (const f of v.match(/\b[A-Za-z]:\\[^\s"'<>|*?]{2,160}|\b[\w.-]+\.(?:exe|dll|sys|dat|bin|cfg|ini|json|txt|pdb|tmp|ps1|vbs|bat|scr|jpg|png|pdf|docx?|xlsx?|zip|rar|7z|onion)\b/gi) || []) buckets.files.add(f);
    for (const r of v.match(/\b(?:HKLM|HKCU|HKCR|HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT))\\[^\s"']{2,140}/gi) || []) buckets.registry.add(r);
    for (const m of v.match(/\b(?:Global\\|Local\\)?[\w.-]{8,60}\.(?:Mutex|mtx|Event|sem)\b/g) || []) buckets.mutexes.add(m);
    for (const g of v.match(/\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?/g) || []) buckets.guid.add(g);
    if (/(cmd\.exe|powershell|-enc |Invoke-WebRequest|certutil|bitsadmin|rundll32|regsvr32|schtasks|vssadmin|bcdedit|whoami|mimikatz|lsass|CreateRemoteThread|VirtualAllocEx|WriteProcessMemory|SetWindowsHookEx|URLDownloadToFile|WinExec|NtUnmapViewOfSection|CryptEncrypt|LockVolume)/i.test(v)) buckets.suspicious.add(v.slice(0, 220));
    if (/\bv?\d+\.\d+\.\d+[\d.]*\b/.test(v) && v.length < 60) buckets.version.add(v);
  }
  const out = {};
  for (const [k, set] of Object.entries(buckets)) out[k] = [...set].slice(0, 120);
  return out;
}
