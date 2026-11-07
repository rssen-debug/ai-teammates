#!/usr/bin/env node
/**
 * Generate the MAJIN app icons with zero dependencies.
 *
 * A soft pink/violet orb on a near-black rounded square, encoded as PNG
 * (RGBA, filter 0, zlib). Deterministic: same input bytes every run.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../src/v4/ui/icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function renderIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const orbR = size * (maskable ? 0.30 : 0.34);
  const corner = size * 0.22;
  const BG = [6, 5, 11];
  const PINK = [255, 79, 184];
  const VIOLET = [139, 92, 246];
  const DEEP = [43, 16, 96];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = 255;

      // rounded-square background with transparent corners (maskable stays square)
      if (!maskable) {
        const dx = Math.max(0, Math.abs(x - c) - (size / 2 - corner));
        const dy = Math.max(0, Math.abs(y - c) - (size / 2 - corner));
        const d = Math.hypot(dx, dy) - corner;
        a = Math.round(255 * (1 - smooth(-1, 1, d)));
      }

      // aurora glow
      const gd = Math.hypot(x - c, y - c) / size;
      const glow = Math.max(0, 0.42 - gd * 0.9);
      r += glow * 90;
      g += glow * 20;
      b += glow * 90;

      // orb
      const ox = x - c;
      const oy = y - c;
      const od = Math.hypot(ox, oy);
      if (od < orbR * 1.3) {
        const t = clamp(od / orbR);
        const light = clamp(1 - (od / orbR) * 0.9);
        let col = mix(PINK, VIOLET, Math.pow(t, 0.9));
        col = mix(col, DEEP, Math.pow(t, 2.6));
        const spec = Math.max(0, 1 - Math.hypot(ox + orbR * 0.32, oy + orbR * 0.36) / (orbR * 0.9));
        const k = smooth(orbR * 0.94, orbR * 1.02, od);
        const alpha = (1 - k) * (0.55 + 0.45 * light);
        const rr = col[0] * (0.55 + 0.45 * light) + 255 * Math.pow(spec, 2) * 0.5;
        const gg = col[1] * (0.55 + 0.45 * light) + 255 * Math.pow(spec, 2) * 0.5;
        const bb = col[2] * (0.55 + 0.45 * light) + 255 * Math.pow(spec, 2) * 0.5;
        r = r * (1 - alpha) + rr * alpha;
        g = g * (1 - alpha) + gg * alpha;
        b = b * (1 - alpha) + bb * alpha;
      }

      buf[i] = Math.round(clamp(r, 0, 255));
      buf[i + 1] = Math.round(clamp(g, 0, 255));
      buf[i + 2] = Math.round(clamp(b, 0, 255));
      buf[i + 3] = a;
    }
  }
  return encodePng(size, size, buf);
}

fs.mkdirSync(outDir, { recursive: true });
const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of jobs) {
  const png = renderIcon(size, opts);
  fs.writeFileSync(path.join(outDir, name), png);
  process.stdout.write(`${name} ${size}x${size} ${png.length} bytes\n`);
}
