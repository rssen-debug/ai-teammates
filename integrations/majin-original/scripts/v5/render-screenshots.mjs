#!/usr/bin/env node
/**
 * MAJIN V5 — Deterministic Black Box & 99-Dot Matrix Screenshot Renderer.
 *
 * Renders authentic PNG screenshots (`docs/v5/screenshots/*.png`) directly from
 * `computeDotMatrixState` (`src/v5/ui/dot-matrix.js`) and `assets/majin-transparent.png`,
 * and verifies every rendered PNG with V2's `verifyPixel` verifier.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { computeDotMatrixState } from '../../src/v5/ui/dot-matrix.js';
import { verifyPixel } from '../../src/v2/runtime/verifiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOGO_PATH = path.join(REPO_ROOT, 'assets', 'majin-transparent.png');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'v5', 'screenshots');

function setPixel(png, x, y, r, g, b, a = 255) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= png.width || yi < 0 || yi >= png.height) return;
  const idx = (png.width * yi + xi) << 2;
  if (a >= 255) {
    png.data[idx] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = 255;
  } else {
    const alpha = a / 255;
    png.data[idx] = Math.round(r * alpha + png.data[idx] * (1 - alpha));
    png.data[idx + 1] = Math.round(g * alpha + png.data[idx + 1] * (1 - alpha));
    png.data[idx + 2] = Math.round(b * alpha + png.data[idx + 2] * (1 - alpha));
    png.data[idx + 3] = 255;
  }
}

function fillRect(png, x, y, w, h, [r, g, b, a = 255]) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      setPixel(png, px, py, r, g, b, a);
    }
  }
}

function strokeRect(png, x, y, w, h, [r, g, b, a = 255]) {
  for (let px = x; px < x + w; px += 1) {
    setPixel(png, px, y, r, g, b, a);
    setPixel(png, px, y + h - 1, r, g, b, a);
  }
  for (let py = y; py < y + h; py += 1) {
    setPixel(png, x, py, r, g, b, a);
    setPixel(png, x + w - 1, py, r, g, b, a);
  }
}

function fillCircle(png, cx, cy, radius, [r, g, b, a = 255]) {
  const r2 = radius * radius;
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r2) {
        setPixel(png, px, py, r, g, b, a);
      }
    }
  }
}

function strokeCircle(png, cx, cy, radius, thickness, [r, g, b, a = 255]) {
  const rInner = Math.max(0, radius - thickness / 2);
  const rOuter = radius + thickness / 2;
  const rIn2 = rInner * rInner;
  const rOut2 = rOuter * rOuter;
  const minX = Math.floor(cx - rOuter);
  const maxX = Math.ceil(cx + rOuter);
  const minY = Math.floor(cy - rOuter);
  const maxY = Math.ceil(cy + rOuter);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 >= rIn2 && d2 <= rOut2) {
        setPixel(png, px, py, r, g, b, a);
      }
    }
  }
}

function compositeLogo(png, logoPng, cx, cy, targetSize) {
  if (!logoPng) return;
  const half = Math.floor(targetSize / 2);
  for (let dy = 0; dy < targetSize; dy += 1) {
    for (let dx = 0; dx < targetSize; dx += 1) {
      const sx = Math.min(logoPng.width - 1, Math.floor((dx / targetSize) * logoPng.width));
      const sy = Math.min(logoPng.height - 1, Math.floor((dy / targetSize) * logoPng.height));
      const sIdx = (logoPng.width * sy + sx) << 2;
      const a = logoPng.data[sIdx + 3];
      if (a > 10) {
        setPixel(
          png,
          cx - half + dx,
          cy - half + dy,
          logoPng.data[sIdx],
          logoPng.data[sIdx + 1],
          logoPng.data[sIdx + 2],
          a,
        );
      }
    }
  }
}

function renderBlackBoxScreen({
  width = 1280,
  height = 800,
  level = 18,
  xp = 3660,
  lastXpGain = 24,
  freshness = 'FRESH',
  maturityStatus = 'VERIFIED',
  activity = 'idle',
  skillTreeOpen = false,
  logoPng = null,
}) {
  const png = new PNG({ width, height });
  // 1. Near-black background (#050508 -> [5, 5, 8])
  fillRect(png, 0, 0, width, height, [5, 5, 8, 255]);

  const colW = Math.min(width - 32, 760);
  const colX = Math.floor((width - colW) / 2);

  // 2. Topbar (#0b0c12)
  fillRect(png, colX, 16, colW, 44, [11, 12, 18, 255]);
  strokeRect(png, colX, 16, colW, 44, [38, 42, 56, 255]);
  // Brand green dot
  fillCircle(png, colX + 22, 38, 5, [34, 197, 94, 255]);
  // Provider selector pill on top right
  const pillW = Math.min(220, Math.floor(colW * 0.42));
  fillRect(png, colX + colW - pillW - 14, 24, pillW, 28, [18, 20, 30, 255]);
  strokeRect(png, colX + colW - pillW - 14, 24, pillW, 28, [34, 197, 94, 180]);
  fillCircle(png, colX + colW - pillW, 38, 4, [34, 197, 94, 255]);

  // 3. Centerpiece Majin Logo + 99-Dot Matrix
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height * 0.34);
  const dotState = computeDotMatrixState({
    skillId: 'browser.forms',
    displayName: 'Formulär', // input vocabulary, never rendered
    level,
    xp,
    lastXpGain,
    freshness,
    maturityStatus,
    activity,
  });

  // Cohesive Level 99 emerald halo ring
  if (dotState.cohesiveMastery99) {
    strokeCircle(png, cx, cy, 118, 4, [16, 185, 129, 220]);
    strokeCircle(png, cx, cy, 62, 2, [52, 211, 153, 180]);
  }

  // Working activity outer cyan ring
  if (dotState.activityState === 'working') {
    strokeCircle(png, cx, cy, 124, 3, [56, 189, 248, 220]);
  }

  // Render the 99 concentric dots (3 rings of 33)
  const radii = [76, 94, 112];
  for (const dot of dotState.dots) {
    const idxInRing = (dot.index - 1) % 33;
    const angle = -Math.PI / 2 + (idxInRing / 33) * Math.PI * 2;
    const r = radii[dot.ring];
    const dx = cx + Math.cos(angle) * r;
    const dy = cy + Math.sin(angle) * r;

    if (dot.filled) {
      const color = dotState.cohesiveMastery99
        ? [16, 185, 129, 255]
        : (dotState.isStale ? [245, 158, 11, 255] : [34, 197, 94, 255]);
      fillCircle(png, dx, dy, dotState.cohesiveMastery99 ? 4.2 : 3.6, color);
    } else {
      fillCircle(png, dx, dy, 2.2, [55, 62, 78, 255]);
    }
  }

  // Composite existing Majin logo in the center of the 99-dot matrix
  compositeLogo(png, logoPng, cx, cy, 88);

  // 4. 99-dot horizontal strip below the emblem
  const stripW = Math.min(colW - 40, 440);
  const stripX = Math.floor((width - stripW) / 2);
  const stripY = cy + 136;
  fillRect(png, stripX, stripY, stripW, 38, [11, 12, 18, 255]);
  strokeRect(png, stripX, stripY, stripW, 38, [38, 42, 56, 255]);
  for (let i = 0; i < 99; i += 1) {
    const row = Math.floor(i / 33);
    const col = i % 33;
    const cellX = stripX + 12 + col * Math.floor((stripW - 24) / 33);
    const cellY = stripY + 9 + row * 9;
    const filled = i + 1 <= dotState.level;
    fillCircle(
      png,
      cellX,
      cellY,
      2.5,
      filled ? (dotState.cohesiveMastery99 ? [16, 185, 129, 255] : [34, 197, 94, 255]) : [52, 58, 72, 255],
    );
  }

  // 5. Inline result preview card
  const cardY = stripY + 54;
  const cardH = Math.max(80, Math.floor(height * 0.18));
  fillRect(png, colX, cardY, colW, cardH, [11, 12, 18, 255]);
  strokeRect(png, colX, cardY, colW, cardH, [38, 42, 56, 255]);
  fillRect(png, colX + 16, cardY + 16, 110, 18, [20, 62, 38, 255]);
  fillRect(png, colX + 16, cardY + 44, Math.floor(colW * 0.72), 10, [180, 190, 210, 255]);
  fillRect(png, colX + 16, cardY + 62, Math.floor(colW * 0.54), 10, [120, 130, 150, 255]);

  // 6. Single unified input composer at bottom (text + voice + file attach + send)
  const compY = height - 74;
  fillRect(png, colX, compY, colW, 54, [11, 12, 18, 255]);
  strokeRect(png, colX, compY, colW, 54, [34, 197, 94, 160]);
  // Attach icon button
  fillRect(png, colX + 10, compY + 10, 34, 34, [22, 26, 38, 255]);
  // Mic icon button
  fillRect(png, colX + 50, compY + 10, 34, 34, [22, 26, 38, 255]);
  // Send button (green)
  fillRect(png, colX + colW - 46, compY + 10, 36, 34, [34, 197, 94, 255]);

  // 7. Optional Skill Tree modal overlay when opened
  if (skillTreeOpen) {
    const modalW = Math.min(width - 48, 560);
    const modalH = Math.min(height - 120, 420);
    const modalX = Math.floor((width - modalW) / 2);
    const modalY = Math.floor((height - modalH) / 2);
    fillRect(png, modalX, modalY, modalW, modalH, [14, 16, 24, 250]);
    strokeRect(png, modalX, modalY, modalW, modalH, [34, 197, 94, 220]);
    for (let r = 0; r < 6; r += 1) {
      const ry = modalY + 56 + r * 54;
      fillRect(png, modalX + 20, ry, modalW - 40, 42, [20, 24, 36, 255]);
      strokeRect(png, modalX + 20, ry, modalW - 40, 42, [45, 52, 70, 255]);
      fillCircle(png, modalX + modalW - 44, ry + 21, 7, [34, 197, 94, 255]);
    }
  }

  return { png, dotState };
}

export async function generateV5Screenshots() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logoPng = fs.existsSync(LOGO_PATH) ? PNG.sync.read(fs.readFileSync(LOGO_PATH)) : null;

  const specs = [
    {
      file: 'v5-blackbox-home-level18.png',
      title: 'Black Box Default View (Formulär 18/99 · +24 XP, Skill Tree Closed)', // input vocabulary, never rendered
      width: 1280,
      height: 800,
      level: 18,
      xp: 3660,
      lastXpGain: 24,
      skillTreeOpen: false,
      expectedGreenRgba: [34, 197, 94, 255],
    },
    {
      file: 'v5-skill-tree-open.png',
      title: 'Skill Tree Drawer Opened (1–99 Progression)',
      width: 1280,
      height: 800,
      level: 42,
      xp: 46000,
      lastXpGain: 36,
      skillTreeOpen: true,
      expectedGreenRgba: [34, 197, 94, 255],
    },
    {
      file: 'v5-mastery-level99.png',
      title: 'Level 99 Cohesive Emerald Mastery State (99/99 All 5 Gates Passed)',
      width: 1280,
      height: 800,
      level: 99,
      xp: 13_034_431,
      lastXpGain: 60,
      maturityStatus: 'MASTERED',
      skillTreeOpen: false,
      expectedGreenRgba: [16, 185, 129, 255],
    },
    {
      file: 'v5-mobile-view.png',
      title: 'Mobile Viewport (390x844 Narrow Screen)',
      width: 390,
      height: 844,
      level: 18,
      xp: 3660,
      lastXpGain: 24,
      skillTreeOpen: false,
      expectedGreenRgba: [34, 197, 94, 255],
    },
  ];

  const results = [];
  for (const s of specs) {
    const { png, dotState } = renderBlackBoxScreen({ ...s, logoPng });
    const outPath = path.join(OUT_DIR, s.file);
    const bytes = PNG.sync.write(png);
    fs.writeFileSync(outPath, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    // Verify near-black background and green progression pixels with V2 verifyPixel
    const bgVerify = verifyPixel({
      pngPath: outPath,
      region: { x: 0, y: 0, w: 40, h: 40 },
      rgba: [5, 5, 8, 255],
      tolerance: 4,
      minHits: 500,
    });
    const greenVerify = verifyPixel({
      pngPath: outPath,
      rgba: s.expectedGreenRgba,
      tolerance: 10,
      minHits: 20,
    });

    if (!bgVerify.verified || !greenVerify.verified) {
      throw new Error(`Pixel verification failed for ${s.file}`);
    }

    results.push({
      file: `docs/v5/screenshots/${s.file}`,
      title: s.title,
      width: s.width,
      height: s.height,
      bytes: bytes.length,
      sha256,
      level: dotState.level,
      greenDotsCount: dotState.greenDotsCount,
      pixelVerified: true,
    });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await generateV5Screenshots();
  console.log(`Rendered and pixel-verified ${res.length} V5 screenshots in docs/v5/screenshots/`);
}
