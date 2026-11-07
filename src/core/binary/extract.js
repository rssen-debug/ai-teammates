/**
 * MAJIN RE — extraktion utan externa beroenden.
 * ZIP-poster (deflate via node:zlib), AndroidManifest AXML-strängpool,
 * PE-overlay/resurser, pcap-sammanfattning. Allt detta är det som gör att
 * "triage" räcker långt innan man väcker ghidra.
 */
import zlib from 'node:zlib';

/* --------------------------------- ZIP ------------------------------------ */

export function zipEntries(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEOCD(buf);
  if (eocd < 0) return null;
  const cd = view.getUint32(eocd + 16, true);
  const total = view.getUint16(eocd + 10, true);
  const entries = [];
  let p = cd;
  for (let i = 0; i < total && p + 46 <= buf.length; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, csize, usize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

export function zipRead(buf, entry) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lh = entry.localOff;
  if (lh + 30 > buf.length || view.getUint32(lh, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(lh + 26, true);
  const extraLen = view.getUint16(lh + 28, true);
  const start = lh + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.usize, 1) * 2 + 1024 });
    } catch {
      try {
        return zlib.inflateRawSync(data);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* --------------------------------- AXML ----------------------------------- */

/** Läs strängpoolen i binär AndroidManifest.xml → paketnamn, permissions, aktiviteter. */
export function axmlStrings(xml) {
  const view = new DataView(xml.buffer, xml.byteOffset, xml.byteLength);
  if (xml.length < 8 || view.getUint16(0, true) !== 0x0003) return null;
  const poolOff = 8;
  if (view.getUint16(poolOff, true) !== 0x0001) return null;
  const stringCount = view.getUint32(poolOff + 8, true);
  const flags = view.getUint32(poolOff + 16, true);
  const stringsStart = view.getUint32(poolOff + 20, true);
  const isUtf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < Math.min(stringCount, 6000); i += 1) {
    const off = view.getUint32(poolOff + 28 + i * 4, true);
    const abs = poolOff + stringsStart + off;
    if (abs >= xml.length) break;
    if (isUtf8) {
      let p = abs;
      const len = xml[p] & 0x7f;
      p += len > 0x7f ? 2 : 1;
      const byteLen = xml[p] & 0x7f;
      p += byteLen > 0x7f ? 2 : 1;
      out.push(xml.toString('utf8', p, p + byteLen));
    } else {
      const len = view.getUint16(abs, true);
      out.push(xml.toString('utf16le', abs + 2, abs + 2 + len * 2));
    }
  }
  return out.filter(Boolean);
}

export function apkPeek(buf) {
  const entries = zipEntries(buf);
  if (!entries) return null;
  const names = entries.map((e) => e.name);
  const manifest = entries.find((e) => e.name === 'AndroidManifest.xml');
  let strings = null;
  if (manifest) {
    const raw = zipRead(buf, manifest);
    if (raw) strings = axmlStrings(raw);
  }
  const dex = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  return {
    entries: entries.length,
    dex: dex.map((d) => ({ name: d.name, size: d.usize })),
    libs: names.filter((n) => n.startsWith('lib/')).slice(0, 40),
    resources: names.filter((n) => n.startsWith('res/')).length,
    meta: names.filter((n) => n.startsWith('META-INF/')).slice(0, 20),
    v2Signer: names.some((n) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(n)),
    packageGuess: strings?.find((s) => /^[a-z][\w]+(\.[a-z][\w]+)+$/.test(s) && !s.includes('android.')) || null,
    permissions: (strings || []).filter((s) => s.startsWith('android.permission.') || /^\w+(\.\w+)*\.permission[s]?\.\w+/.test(s)).slice(0, 60),
    components: (strings || []).filter((s) => /^[A-Z]\w*(Activity|Service|Receiver|Provider)$/.test(s)).slice(0, 60),
    debuggable: (strings || []).some((s) => s === 'debuggable'),
    networkSecurity: names.includes('res/xml/network_security_config.xml'),
  };
}

/* --------------------------------- PE res ----------------------------------- */

export function peOverlay(buf, pe) {
  if (!pe?.overlay?.size) return Buffer.alloc(0);
  return buf.subarray(pe.overlay.offset, Math.min(buf.length, pe.overlay.offset + pe.overlay.size));
}

export function peResources(buf, pe, { max = 40 } = {}) {
  const d = (pe.directories || []).find((x) => x.name === 'RESOURCE');
  if (!d || d.offset < 0) return [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  const walk = (off, depth, typeName) => {
    if (depth > 2 || off + 16 > buf.length || out.length >= max * 6) return;
    const named = view.getUint16(off + 12, true);
    const ids = view.getUint16(off + 14, true);
    for (let i = 0; i < Math.min(named + ids, 300); i += 1) {
      const e = off + 16 + i * 8;
      if (e + 8 > buf.length) return;
      const id = view.getUint32(e, true);
      const next = view.getUint32(e + 4, true);
      if (next & 0x80000000) {
        const child = (pe._rvaToOffset || (() => -1))(next & 0x7fffffff);
        if (child < 0) continue;
        walk(child, depth + 1, depth === 0 ? String(id) : typeName);
      } else if (depth === 2 && next >= 0) {
        const size = view.getUint32(next, true);
        const dataRva = view.getUint32(next + 4, true);
        const dataOff = (pe._rvaToOffset || (() => -1))(dataRva);
        if (dataOff >= 0 && size > 0) out.push({ type: typeName, id, rva: dataRva, offset: dataOff, size });
      }
    }
  };
  try {
    walk(d.offset, 0, null);
  } catch {
    /* trasig resursträd */
  }
  const TYPE_NAMES = { 10: 'RCDATA', 3: 'ICON', 16: 'VERSION', 24: 'MANIFEST', 2: 'BITMAP', 9: 'ACCELERATOR', 5: 'DIALOG', 6: 'STRING', 14: 'GROUP_ICON' };
  return out
    .map((r) => ({ ...r, typeName: TYPE_NAMES[r.type] || `TYPE_${r.type}` }))
    .filter((r) => ['RCDATA', 'MANIFEST', 'VERSION', 'DIALOG', 'BITMAP'].includes(r.typeName) || r.size > 400)
    .slice(0, max);
}

/** PE version-info-block (VS_VERSIONINFO) → CompanyName/FileDescription/… */
export function peVersionInfo(buf, resources) {
  const v = (resources || []).find((r) => r.typeName === 'VERSION');
  if (!v) return null;
  const txt = buf.toString('utf16le', v.offset, Math.min(buf.length, v.offset + v.size));
  const out = {};
  const pairs = txt.match(/\w{3,24}/g) || [];
  const known = ['CompanyName', 'FileDescription', 'FileVersion', 'InternalName', 'LegalCopyright', 'OriginalFilename', 'ProductName', 'ProductVersion'];
  for (let i = 0; i < pairs.length; i += 1) {
    if (known.includes(pairs[i]) && pairs[i + 1] && !known.includes(pairs[i + 1])) out[pairs[i]] = pairs[i + 1].slice(0, 160);
  }
  return Object.keys(out).length ? out : null;
}

/* --------------------------------- pcap ------------------------------------- */

export function pcapSummary(buf, { maxPackets = 4000 } = {}) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let magic = view.getUint32(0, true);
  let le = true;
  if (magic === 0xa1b4c6d7 || magic === 0xa1b2c3d4) le = true;
  else if (magic === 0xd7c6b4a1 || magic === 0xd4c3b2a1) le = false;
  else return null;
  const linkType = view.getUint32(20, le);
  let p = 24;
  let n = 0;
  const hosts = new Map();
  const ports = new Map();
  const http = new Set();
  const dns = new Set();
  while (p + 16 <= buf.length && n < maxPackets) {
    const caplen = view.getUint32(p + 8, le);
    const pkt = buf.subarray(p + 16, p + 16 + caplen);
    n += 1;
    p += 16 + caplen;
    if (pkt.length < 34) continue;
    let ipOff = 14;
    if (linkType === 101 || linkType === 113) ipOff = 0;
    if (ipOff + 20 > pkt.length) continue;
    const verIhl = pkt[ipOff];
    if ((verIhl >> 4) !== 4) continue;
    const ihl = (verIhl & 0xf) * 4;
    const proto = pkt[ipOff + 9];
    const src = ip(pkt, ipOff + 12);
    const dst = ip(pkt, ipOff + 16);
    hosts.set(src, (hosts.get(src) || 0) + 1);
    hosts.set(dst, (hosts.get(dst) || 0) + 1);
    const l4 = ipOff + ihl;
    if (proto === 6 || proto === 17) {
      if (l4 + 4 > pkt.length) continue;
      const sport = pkt.readUIntBE(l4, 2);
      const dport = pkt.readUIntBE(l4 + 2, 2);
      const key = `${dport}/${proto === 6 ? 'tcp' : 'udp'}`;
      ports.set(key, (ports.get(key) || 0) + 1);
      const payload = pkt.subarray(l4 + (proto === 6 ? (pkt[l4 + 12] >> 4) * 4 : 8));
      const text = payload.toString('latin1');
      if (/^(GET|POST|PUT|HEAD|OPTIONS) \S+ HTTP\//m.test(text)) http.add(`${text.split(' ')[1]} ${src}→${dst}`);
      const host = /Host: ([^\r\n]+)/i.exec(text);
      if (host) http.add(`host ${host[1]}`);
      if (dport === 53 || sport === 53) for (const q of text.match(/[a-z0-9-]{2,60}(\.[a-z0-9-]{2,60}){1,4}/gi) || []) dns.add(q);
    }
  }
  const top = (m, n2) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n2).map(([k, v]) => `${k}×${v}`);
  return {
    packets: n,
    linkType,
    hosts: top(hosts, 12),
    ports: top(ports, 12),
    http: [...http].slice(0, 25),
    dns: [...dns].slice(0, 25),
  };
}

function ip(buf, off) {
  return [buf[off], buf[off + 1], buf[off + 2], buf[off + 3]].join('.');
}

/* ---------------------------------- misc ------------------------------------ */

/** Mönsterhunt i binären: "4d 5a ?? (61|62)" → träffoffset. */
export function findBytes(buf, pattern, { limit = 200 } = {}) {
  const tokens = String(pattern)
    .toLowerCase()
    .replace(/0x/g, '')
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return [];
  const seq = tokens.map((t) => {
    if (t === '??' || t === '?') return { any: true };
    const alt = t.match(/^\((.+)\)$/);
    if (alt) return { alt: alt[1].split('|').map((x) => parseInt(x, 16)) };
    const val = parseInt(t, 16);
    return Number.isFinite(val) ? { value: val } : { any: true };
  });
  const hits = [];
  outer: for (let i = 0; i + seq.length <= buf.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      const s = seq[j];
      const b = buf[i + j];
      if (s.any) continue;
      if (s.alt) {
        if (!s.alt.includes(b)) continue outer;
        continue;
      }
      if (b !== s.value) continue outer;
    }
    hits.push(i);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function entropyWindow(buf, { block = 1024, threshold = 7.0 } = {}) {
  const out = [];
  for (let i = 0; i + block <= buf.length; i += block) {
    const slice = buf.subarray(i, i + block);
    const freq = new Array(256).fill(0);
    for (const b of slice) freq[b] += 1;
    let e = 0;
    for (const f of freq) {
      if (!f) continue;
      const p = f / slice.length;
      e -= p * Math.log2(p);
    }
    if (e >= threshold) out.push({ offset: i, entropy: Number(e.toFixed(2)) });
  }
  return out;
}
