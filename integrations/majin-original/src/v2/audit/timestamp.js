/**
 * MAJIN V2 — RFC 3161 trusted timestamps for anchors.
 * The anchor's Ed25519 signature proves integrity; its `at` is self-asserted.
 * A TSA token proves the anchorHash EXISTED at time T independent of our clock
 * (same stack as the receipts ecosystem: Ed25519 + JCS + RFC 3161).
 *
 * Scope discipline:
 *  - imprint = sha256(anchorHash of the anchor CURRENT AT STAMP TIME)
 *  - stored: anchors.tsr (the token) + anchor-tsr.json {tsrForAseq, tsrForHash}
 *  - a later anchor WITHOUT a new stamp leaves the token honestly STALE
 *    (it proves aseq N, the head is aseq M > N) — never a false fresh OK
 *  - chain-trust verification needs the TSA's CA bundle (operator-supplied,
 *    downloaded once). Without it we report STRUCTURAL — parse + imprint
 *    proven, chain trust NOT established. Never upgraded by assumption.
 *  - the ONLY bytes that leave the machine are a 32-byte SHA-256 imprint
 *    (no chain data, no keys, no telemetry — privacy-clean by construction)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const TSR_FILE = 'anchors.tsr';
const TSR_META = 'anchor-tsr.json';
const ANCHOR_FILE = 'anchors.jsonl';
const TSA_TIMEOUT_MS = 15000;

// Git for Windows ships OpenSSL outside PATH. Reuse that installed binary;
// never download a verifier or infer certificate trust from its presence.
export function openSslBinary(env = process.env, platform = process.platform) {
  if (env.MAJIN_OPENSSL) return env.MAJIN_OPENSSL;
  if (platform === 'win32') {
    const bundled = path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'openssl';
}

export function hasOpenSsl({ execImpl = execFileSync } = {}) {
  try { execImpl(openSslBinary(), ['version'], { stdio: 'pipe', windowsHide: true, timeout: 10000 }); return true; } catch { return false; }
}

function latestAnchor(dir) {
  const file = path.join(dir, ANCHOR_FILE);
  if (!fs.existsSync(file)) return null;
  const last = fs.readFileSync(file, 'utf8').trim();
  return last ? JSON.parse(last.split('\n').pop()) : null;
}

function parseTsrText(dir, { execImpl = execFileSync } = {}) {
  const tsr = path.join(dir, TSR_FILE);
  const text = execImpl(openSslBinary(), ['ts', '-reply', '-in', tsr, '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 }).replace(/\r\n/g, '\n');
  const time = /Time stamp:\s*(.+)/.exec(text)?.[1]?.trim() ?? null;
  // OpenSSL 3.x hexdump: "Message data:\n    0000 - f4 ca d4 ...-70 4c ...   <ascii>"
  let imprint = null;
  const block = /Message data:\n((?:\s+\d{4} - .+\n)+)/.exec(text)?.[1];
  if (block) {
    imprint = block.split('\n').filter(Boolean).map((line) => {
      const after = line.replace(/^\s+\d{4} - /, '');
      const hexPart = after.split(/\s{2,}/)[0]; // cut at the ASCII column
      return hexPart.replace(/[^0-9a-fA-F]/g, '');
    }).join('').toLowerCase();
  }
  const granted = /Status:\s*Granted\./.test(text);
  return { time, imprint, granted };
}

/**
 * requestTimestamp(dir, url): stamp the CURRENT latest anchor. Refuses when
 * there is no anchor (a timestamp needs something real to stamp).
 */
export async function requestTimestamp(dir, url, { timeoutMs = TSA_TIMEOUT_MS, execImpl = execFileSync, fetchImpl = fetch } = {}) {
  const anchor = latestAnchor(dir);
  if (!anchor) {
    const err = new Error('no anchor to timestamp — run keygen/anchor first (timestamps are deliberate, never implicit)');
    err.cls = 'NO_ANCHOR';
    throw err;
  }
  const imprint = crypto.createHash('sha256').update(anchor.anchorHash).digest('hex');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tsq-'));
  const tsq = path.join(work, 'q.tsq');
  try {
    execImpl(openSslBinary(), ['ts', '-query', '-sha256', '-digest', imprint, '-cert', '-no_nonce', '-out', tsq], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query' },
      body: new Uint8Array(fs.readFileSync(tsq)),
      signal: ac.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) {
      const err = new Error(`TSA answered HTTP ${res.status} — token NOT stored, anchor unaffected (honest partial state)`);
      err.cls = 'TSA_REFUSED';
      throw err;
    }
    const token = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(dir, TSR_FILE), token);
    fs.writeFileSync(path.join(dir, TSR_META), JSON.stringify({
      tsrForAseq: anchor.aseq, tsrForHash: anchor.anchorHash, imprint, tsaUrl: url,
      requestedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    const info = parseTsrText(dir, { execImpl });
    return Object.freeze({ ok: true, aseq: anchor.aseq, imprint, genTime: info.time, bytes: token.length, url });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * verifyTimestamp(dir): honest verdict classes:
 *   TSR_NOT_REQUESTED — no token stored (inconclusive, not a failure)
 *   TSR_MISMATCH     — token imprint does not match meta (foreign token → ok:false)
 *   TSR_STALE        — token proves a seq the chain has since passed (inconclusive for HEAD)
 *   TSR_STRUCTURAL   — parse ok + imprint matches current anchor; CA trust NOT established
 *   TSR_OK           — openssl chain verification passed with supplied bundles
 */
export function verifyTimestamp(dir, { caFile = null, untrusted = null, execImpl = execFileSync } = {}) {
  const tsr = path.join(dir, TSR_FILE);
  const metaPath = path.join(dir, TSR_META);
  if (!fs.existsSync(tsr) || !fs.existsSync(metaPath)) {
    return { ok: true, cls: 'TSR_NOT_REQUESTED', inconclusive: true, detail: 'no timestamp token — existence-in-time of any anchor is unproven (chain + signature still verified separately)' };
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  let info;
  try {
    info = parseTsrText(dir, { execImpl });
  } catch (e) {
    return { ok: false, cls: 'TSR_UNPARSEABLE', detail: `openssl could not parse the token: ${e.message}` };
  }
  if (!info.granted) return { ok: false, cls: 'TSR_UNPARSEABLE', detail: 'token status is not Granted' };
  if (info.imprint !== meta.imprint) {
    return { ok: false, cls: 'TSR_MISMATCH', detail: `token imprint ${info.imprint} != recorded imprint ${meta.imprint} — this token proves nothing we hold` };
  }
  const anchor = latestAnchor(dir);
  const stale = !anchor || anchor.anchorHash !== meta.tsrForHash;
  const base = { genTime: info.time, aseq: meta.tsrForAseq, tsaUrl: meta.tsaUrl, imprint: meta.imprint };
  if (stale) {
    return { ok: true, cls: 'TSR_STALE', inconclusive: true, ...base, detail: `token proves anchor aseq ${meta.tsrForAseq}; the head has since advanced — fresher anchors exist un-stamped. Not fabricated: restamp deliberately` };
  }
  if (caFile && untrusted) {
    try {
      execImpl(openSslBinary(), ['ts', '-verify', '-digest', meta.imprint, '-in', tsr, '-CAfile', caFile, '-untrusted', untrusted], { stdio: 'pipe', windowsHide: true, timeout: 10000 });
      return { ok: true, cls: 'TSR_OK', chainTrusted: true, ...base, detail: `existence at ${info.time} proven under the TSA's certificate chain` };
    } catch (e) {
      return { ok: false, cls: 'TSR_TRUST_FAILED', ...base, detail: `chain verification failed: ${String(e.stderr || e.message).slice(0, 200)}` };
    }
  }
  return { ok: true, cls: 'TSR_STRUCTURAL', inconclusive: true, chainTrusted: false, ...base, detail: `token parses, imprint matches current anchor (aseq ${meta.tsrForAseq}), stamped ${info.time} — TSA chain trust NOT established without -CAfile/-untrusted (operator-supplied, see runbook)` };
}
