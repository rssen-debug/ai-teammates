/* MAJIN — brandkontraktet: vit M på rosa, i VARJE storlek, ÖVERALLT.
   Skrivs fail-first: bevisar att 16-48px-varianterna i majin.ico inte bär
   samma design som 128/256-varianten innan make-icon.mjs bygger om filen. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------- minimal PNG-dekoder (RGBA ut) ---------- */
function decodePNG(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'inte en PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  let plte = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  assert.equal(depth, 8, '8-bit-depth förväntas');
  const chansByCtype = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const chans = chansByCtype[ctype];
  assert.ok(chans, `colorType ${ctype} stöds`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chans;
  const px = Buffer.alloc(w * h * chans);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = Buffer.from(line);
    const bpp = chans;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) cur[x] = (cur[x] + a) & 0xff;
      else if (f === 2) cur[x] = (cur[x] + b) & 0xff;
      else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; }
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  // expandera till RGBA
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ctype === 6) { px.copy(out, i * 4, i * 4, i * 4 + 4); }
    else if (ctype === 2) { px.copy(out, i * 4, i * 3, i * 3 + 3); out[i * 4 + 3] = 255; }
    else if (ctype === 3) { const idx = px[i]; out[i * 4] = plte[idx * 3]; out[i * 4 + 1] = plte[idx * 3 + 1]; out[i * 4 + 2] = plte[idx * 3 + 2]; out[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255; }
    else if (ctype === 0) { const g = px[i]; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
    else if (ctype === 4) { const g = px[i * 2]; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = px[i * 2 + 1]; }
  }
  return { w, h, rgba: out };
}

/* ---------- ICO-läsare ---------- */
function readICO(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'inte ett .ico');
  assert.equal(buf.readUInt16LE(2), 1, 'inte ett .ico');
  const count = buf.readUInt16LE(4);
  const imgs = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf[off] || 256, h = buf[off + 1] || 256;
    const size = buf.readUInt32LE(off + 8);
    const pos = buf.readUInt32LE(off + 12);
    imgs.push({ w, h, data: buf.subarray(pos, pos + size) });
  }
  return imgs;
}

/* ---------- brandmätning ---------- */
// procent av icke-transparenta pixlar som är "M-vita" resp "rosa profil"
function brandProfile(rgba) {
  let white = 0, pink = 0, total = 0, other = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < 40) continue;
    total++;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 235 && max - min < 25) white++;                       // M-området
    else if (r > 150 && r > g + 40 && b > g + 20) pink++;         // rosa bakgrunden
    else other++;
  }
  return { white: white / total, pink: pink / total, other: other / total };
}

/* M:et är designat som en MJUKT vit/ljusrosa mark — absolut vit är fel
   mätpunkt (mätt: ljusaste pixel ≈ #F8E0E9). Brandkontraktet är därför:
   (1) rosa bakgrund dominerar, (2) ett tydligt markerat M-område är
   MARKBART ljusare än bakgrunden, (3) lumen-separationen håller i varje
   storlek. En främmande design (mörk, fel färg, M saknas) bryter det. */
function lum(r, g, b) { return r * 0.299 + g * 0.587 + b * 0.114; }
function brandContract(rgba) {
  let pink = 0, mcount = 0, total = 0, pinkLum = 0, mLum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < 40) continue;
    total++;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const l = lum(r, g, b);
    if (r > 120 && r > g + 40 && b > g + 10) { pink++; pinkLum += l; }         // rosa familj
    if (l > 180) { mcount++; mLum += l; }                                     // M:ets ljusa ytter
  }
  return {
    pink: pink / total,
    mArea: mcount / total,
    separation: (mcount ? mLum / mcount : 0) - (pink ? pinkLum / pink : 0),
  };
}

const CANON = path.join(ROOT, 'assets', 'majin.png');
const ICO = path.join(ROOT, 'assets', 'majin.ico');
const UI = path.join(ROOT, 'src', 'ui', 'logo.png');

test('kanoniska varianterna finns och bär vit M på rosa', () => {
  for (const f of [CANON, ICO, UI]) assert.ok(fs.existsSync(f), `${f} saknas`);
  for (const f of [CANON, UI]) {
    const prof = brandContract(decodePNG(fs.readFileSync(f)).rgba);
    assert.ok(prof.pink > 0.5, `${path.basename(f)}: bakgrunden måste vara rosa (${(prof.pink * 100).toFixed(0)}%)`);
    assert.ok(prof.mArea > 0.003, `${path.basename(f)}: M:et fattas (${(prof.mArea * 100).toFixed(1)}% ljus yta)`);
    assert.ok(prof.separation > 60, `${path.basename(f)}: M:et urskiljer sig inte från bakgrunden (lumnivå ${prof.separation.toFixed(0)})`);
  }
});

test('majin.ico bär alla storlekar från 16 till 256', () => {
  const imgs = readICO(fs.readFileSync(ICO));
  const sizes = new Set(imgs.map((i) => i.w));
  for (const s of [16, 24, 32, 48, 64, 128, 256]) assert.ok(sizes.has(s), `storlek ${s} saknas i .ico`);
});

test('VARJE storlek i majin.ico bär samma vit-M-på-rosa-design som 256px', () => {
  const canon = brandContract(decodePNG(fs.readFileSync(CANON)).rgba);
  const imgs = readICO(fs.readFileSync(ICO));
  const largest = imgs.find((i) => i.w === 256) || imgs.at(-1);
  const ref = brandContract(decodePNG(largest.data).rgba);
  assert.ok(Math.abs(ref.pink - canon.pink) < 0.1, 'storvarianten matchar inte kanonen');
  for (const img of imgs) {
    assert.equal(img.data.readUInt32BE(0), 0x89504e47, `${img.w}px är inte PNG-inbäddad`);
    const prof = brandContract(decodePNG(img.data).rgba);
    assert.ok(prof.pink > 0.5, `${img.w}px: bakgrunden är inte rosa (${(prof.pink * 100).toFixed(0)}%)`);
    assert.ok(prof.mArea > 0.002, `${img.w}px: M:et fattas (ljus yta ${(prof.mArea * 100).toFixed(1)}%)`);
    assert.ok(prof.separation > 45, `${img.w}px: M:et smälter ihop med bakgrunden (separation ${prof.separation.toFixed(0)} — den där ikonen ser ut som en rosa fläck)`);
  }
});

test('UI-logo.png är samma design som kanonen (kvadrat, rimlig storlek)', () => {
  const { w, h } = decodePNG(fs.readFileSync(UI));
  assert.equal(w, h, 'loggan måste vara kvadratisk');
  assert.ok(w >= 128 && w <= 512, `UI-loggan ${w}px är utanför rimligt intervall`);
});
