/**
 * V2 verifier registry (master brief section 22).
 *
 * The executor asks "how do I do this"; the verifier asks "what evidence proves
 * it happened". Each verifier is an independent check that returns
 * { verified:boolean, evidence } or { verified:false, error:{cls,...} }.
 * Kinds shipped now: file, json, http, pixel, dom, memory (dom degrades
 * honestly when Playwright is not installed — registry never fabricates a pass).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { MemoryStore, MEMORY_KINDS } from '../memory/store.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * kind='file' — a target file must exist, and optionally match size/hash/contains.
 * spec: { path, minBytes?, hash?, contains? }  (hash = sha256 hex of exact bytes)
 */
export function verifyFile(spec) {
  const p = spec.path;
  if (!p || !fs.existsSync(p)) {
    return { verified: false, error: { cls: 'DEPENDENCY_MISSING', message: `file missing: ${p}` } };
  }
  const buf = fs.readFileSync(p);
  if (spec.minBytes != null && buf.length < spec.minBytes) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `size ${buf.length} < minBytes ${spec.minBytes}` } };
  }
  let hash = null;
  if (spec.hash != null) {
    hash = sha256(buf);
    if (hash !== spec.hash.toLowerCase()) {
      return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: 'hash mismatch' } };
    }
  }
  if (spec.contains != null && !buf.toString('utf8').includes(spec.contains)) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: 'expected content absent' } };
  }
  return { verified: true, evidence: { kind: 'file', path: p, bytes: buf.length, sha256: hash || sha256(buf) } };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const jsonDeepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function jsonValuePreview(value) {
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.slice(0, 80);
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (typeof value === 'object') return `<object:${Object.keys(value).length} keys>`;
  return String(value).slice(0, 80);
}

/**
 * kind='json' — a target file must parse as JSON, and optionally a dot-path
 * pointer (for example "result.items.0.status") must exist and deep-equal
 * `equals`, or contain `contains` (substring for strings, element deep-equal
 * for arrays). Evidence carries only a bounded scalar preview, never the
 * whole document.
 * spec: { path, pointer?, equals?, contains? }
 */
export function verifyJson(spec) {
  const p = spec?.path;
  if (!p || !fs.existsSync(p)) {
    return { verified: false, error: { cls: 'DEPENDENCY_MISSING', message: `json file missing: ${p}` } };
  }
  const buf = fs.readFileSync(p);
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return { verified: false, error: { cls: 'INVALID_TOOL_OUTPUT', message: `json parse failed: ${err.message}` } };
  }
  const evidence = { kind: 'json', path: p, bytes: buf.length, sha256: sha256(buf) };
  let actual = data;
  if (spec.pointer != null && String(spec.pointer) !== '') {
    const pointer = String(spec.pointer);
    evidence.pointer = pointer;
    let found = true;
    for (const segment of pointer.split('.')) {
      if (['__proto__', 'constructor', 'prototype'].includes(segment)) {
        return { verified: false, error: { cls: 'UNKNOWN', message: `json pointer segment not allowed: ${segment}` } };
      }
      if (Array.isArray(actual)) {
        const idx = /^\d+$/.test(segment) ? Number(segment) : -1;
        if (idx < 0 || idx >= actual.length) { found = false; break; }
        actual = actual[idx];
      } else if (actual && typeof actual === 'object' && Object.hasOwn(actual, segment)) {
        actual = actual[segment];
      } else { found = false; break; }
    }
    if (!found) {
      return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `json pointer not found: ${pointer}` } };
    }
  }
  evidence.value = jsonValuePreview(actual);
  if (Object.hasOwn(spec, 'equals') && !jsonDeepEqual(actual, spec.equals)) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `json value mismatch at ${spec.pointer || '(root)'}` } };
  }
  if (spec.contains !== undefined) {
    const ok = typeof actual === 'string'
      ? actual.includes(String(spec.contains))
      : Array.isArray(actual)
        ? actual.some((item) => jsonDeepEqual(item, spec.contains))
        : false;
    if (!ok) {
      return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `json contains check failed at ${spec.pointer || '(root)'}` } };
    }
    evidence.contains = jsonValuePreview(spec.contains);
  }
  return { verified: true, evidence };
}

/**
 * kind='http' — URL must answer with expected status (default 200), and may
 * optionally require text in the response body. Verification is read-only:
 * only GET/HEAD are accepted. Native fetch, zero deps, hard timeout so the
 * kernel never hangs a goal here.
 * spec: { url, status?, method?, contains? }
 */
export async function verifyHttp(spec, { timeoutMs = 5000 } = {}) {
  const url = spec?.url;
  if (!url) return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier requires url' } };
  let parsed;
  try { parsed = new URL(String(url)); } catch {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier requires a valid URL' } };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier only supports http(s) URLs' } };
  }
  if (parsed.username || parsed.password) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier URL must not embed credentials' } };
  }
  const method = String(spec.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier is read-only and only supports GET/HEAD' } };
  }
  if (method === 'HEAD' && spec.contains != null) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'http verifier contains check requires GET' } };
  }
  const expect = spec.status || 200;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, { method, signal: ctrl.signal });
    if (res.status !== expect) {
      return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `status ${res.status} != ${expect}` } };
    }
    const evidence = { kind: 'http', url: parsed.toString(), status: res.status, method };
    if (spec.contains != null) {
      const body = Buffer.from(await res.arrayBuffer());
      evidence.bytes = body.length;
      evidence.sha256 = sha256(body);
      if (!body.toString('utf8').includes(String(spec.contains))) {
        return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: 'expected content absent' } };
      }
      evidence.contains = String(spec.contains);
    }
    return { verified: true, evidence };
  } catch (err) {
    const cls = err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_FAILURE';
    return { verified: false, error: { cls, message: String(err.message || err) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * kind='pixel' — PNG must contain expected color inside a region (W12-style proof).
 * spec: { pngPath, region: {x,y,w,h} (optional: full image), rgba: [r,g,b,a?], tolerance?, minHits? }
 */
export function verifyPixel(spec) {
  if (!spec.pngPath || !fs.existsSync(spec.pngPath)) {
    return { verified: false, error: { cls: 'DEPENDENCY_MISSING', message: `png missing: ${spec.pngPath}` } };
  }
  if (!Array.isArray(spec.rgba) || spec.rgba.length < 3) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'pixel verifier needs rgba [r,g,b]' } };
  }
  let png;
  try {
    png = PNG.sync.read(fs.readFileSync(spec.pngPath));
  } catch (err) {
    return { verified: false, error: { cls: 'INVALID_TOOL_OUTPUT', message: `png decode failed: ${err.message}` } };
  }
  const [rT, gT, bT, aT = 255] = spec.rgba;
  const tol = spec.tolerance == null ? 8 : spec.tolerance;
  const reg = spec.region || { x: 0, y: 0, w: png.width, h: png.height };
  const minHits = spec.minHits == null ? 1 : spec.minHits;
  let hits = 0;
  for (let y = reg.y; y < Math.min(reg.y + reg.h, png.height); y += 1) {
    for (let x = reg.x; x < Math.min(reg.x + reg.w, png.width); x += 1) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i]; const g = png.data[i + 1]; const b = png.data[i + 2]; const a = png.data[i + 3];
      if (Math.abs(r - rT) <= tol && Math.abs(g - gT) <= tol && Math.abs(b - bT) <= tol && Math.abs(a - aT) <= tol) hits += 1;
    }
  }
  if (hits < minHits) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `${hits}/${minHits} matching pixels in region` } };
  }
  return { verified: true, evidence: { kind: 'pixel', pngPath: spec.pngPath, region: reg, hits, width: png.width, height: png.height } };
}

/**
 * kind='dom' — Playwright-backed DOM observation (real browser evidence).
 * Degrades honestly when Playwright isn't installed: DEPENDENCY_MISSING,
 * never a fabricated pass. Accepts either the full `playwright` package or
 * `playwright-core` with a system browser supplied via executablePath.
 * spec: { url, selector, expectText?|contains?, executablePath? }
 */
export async function verifyDom(spec, { timeoutMs = 15000, launchTimeoutMs = 45000, executablePath = spec?.executablePath } = {}) {
  if (!spec?.url || !spec?.selector) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'dom verifier requires url and selector' } };
  }
  let parsed;
  try { parsed = new URL(String(spec.url)); } catch {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'dom verifier requires a valid URL' } };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'dom verifier only supports http(s) URLs' } };
  }
  if (parsed.username || parsed.password) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'dom verifier URL must not embed credentials' } };
  }
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    try {
      ({ chromium } = await import('playwright-core'));
    } catch {
      return { verified: false, error: { cls: 'DEPENDENCY_MISSING', message: 'playwright not installed — dom verification unavailable' } };
    }
  }
  if (process.platform === 'win32') {
    // Same Windows profile guard as the browser tools: Edge/Chromium cannot
    // resolve LocalAppData under an empty sandboxed %USERPROFILE% and then
    // refuses remote debugging before Playwright can connect.
    const userProfile = process.env.USERPROFILE || os.homedir();
    if (userProfile) {
      for (const appDataDir of [
        path.join(userProfile, 'AppData', 'Local'),
        path.join(userProfile, 'AppData', 'Roaming'),
      ]) {
        try { fs.mkdirSync(appDataDir, { recursive: true }); } catch { /* launch will surface the real error */ }
      }
    }
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: launchTimeoutMs,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.goto(parsed.toString(), { waitUntil: 'load', timeout: timeoutMs });
    const el = page.locator(spec.selector).first();
    const visible = await el.isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) {
      return { verified: false, error: { cls: 'ELEMENT_NOT_FOUND', message: `selector not visible: ${spec.selector}` } };
    }
    const expectedText = spec.expectText ?? spec.contains ?? spec.text;
    let text = null;
    if (expectedText != null) {
      text = await el.textContent();
      if (!(text || '').includes(String(expectedText))) {
        return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: 'expected text absent' } };
      }
    }
    return { verified: true, evidence: { kind: 'dom', url: parsed.toString(), selector: spec.selector, text: text == null ? null : text.slice(0, 80) } };
  } catch (err) {
    const message = String(err.message || err);
    const cls = /Executable doesn't exist|browser.*not found|Please run.*playwright install/i.test(message)
      ? 'DEPENDENCY_MISSING'
      : 'UNKNOWN';
    return { verified: false, error: { cls, message: message.slice(0, 2000) } };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * kind='memory' — one exact long-term memory entry must exist in the host
 * MemoryStore, optionally with exact text (`equals`) or a required substring
 * (`contains`). This makes "remember that …" goals independently provable
 * instead of relying on a receipt file. `storeDir` is always injected by the
 * host (never accepted from the model), and evidence carries only a bounded
 * preview plus the text hash — memory entries are non-sensitive by
 * construction, but a full text is still not copied into receipts.
 * spec: { memoryKind, key, contains?, equals?, storeDir }
 */
export function verifyMemory(spec) {
  const memoryKind = spec?.memoryKind;
  if (!MEMORY_KINDS.includes(memoryKind)) {
    return { verified: false, error: { cls: 'UNKNOWN', message: `memory criterion requires a valid memoryKind (${MEMORY_KINDS.join(', ')})` } };
  }
  if (typeof spec?.key !== 'string' || !spec.key.trim()) {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'memory criterion requires key' } };
  }
  if (spec.contains !== undefined && typeof spec.contains !== 'string') {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'memory contains must be a string' } };
  }
  if (spec.equals !== undefined && typeof spec.equals !== 'string') {
    return { verified: false, error: { cls: 'UNKNOWN', message: 'memory equals must be a string' } };
  }
  const storeDir = spec?.storeDir;
  if (typeof storeDir !== 'string' || !storeDir || !fs.existsSync(storeDir)) {
    return { verified: false, error: { cls: 'DEPENDENCY_MISSING', message: 'memory store is not available on this host' } };
  }
  let entry;
  try {
    entry = new MemoryStore(storeDir, { create: false }).get(memoryKind, spec.key);
  } catch (error) {
    return { verified: false, error: { cls: 'UNKNOWN', message: `memory store read failed: ${String(error?.message || error).slice(0, 300)}` } };
  }
  if (!entry) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `memory entry not found: ${memoryKind}:${spec.key}` } };
  }
  if (entry.sensitive === true) {
    // MemoryStore.put refuses sensitive entries; fail closed without echoing
    // any text if a foreign writer ever produced one.
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `memory entry ${memoryKind}:${spec.key} is marked sensitive and cannot be used as evidence` } };
  }
  const text = String(entry.text ?? '');
  if (spec.equals !== undefined && text !== spec.equals) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `memory text mismatch for ${memoryKind}:${spec.key}` } };
  }
  if (spec.contains !== undefined && !text.includes(spec.contains)) {
    return { verified: false, error: { cls: 'VERIFICATION_FAILURE', message: `memory text for ${memoryKind}:${spec.key} does not contain the expected fragment` } };
  }
  return {
    verified: true,
    evidence: {
      kind: 'memory',
      memoryKind,
      key: spec.key,
      textPreview: text.slice(0, 80),
      sha256: sha256(Buffer.from(text, 'utf8')),
      importance: entry.importance ?? null,
      at: entry.at ?? null,
      rememberedBy: entry.meta?.rememberedBy ?? null,
    },
  };
}

export const verifierRegistry = { file: verifyFile, json: verifyJson, http: verifyHttp, pixel: verifyPixel, dom: verifyDom, memory: verifyMemory };

export async function runVerifier(kind, spec, o) {
  const fn = verifierRegistry[kind];
  if (!fn) throw new Error(`unknown verifier kind: ${kind}`);
  return fn(spec, o);
}
