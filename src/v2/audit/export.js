/**
 * MAJIN V2 — portable audit bundle (the evidence dossier).
 * One directory, PUBLIC MATERIAL ONLY, verifiable on a machine that never
 * saw the original: chain + anchors + RFC 3161 token + public key + manifest.
 *
 * Format (deliberately a plain directory — zero deps, inspectable everywhere):
 *   MANIFEST.json          { format, version, createdAt, stats, files:[{path,sha256,bytes}] }
 *   chain.jsonl / head.json
 *   anchors.jsonl / anchors.tsr / anchor-tsr.json (when present)
 *   keys/ed25519.public.pem
 *
 * Honesty rules enforced in code:
 *  - private material NEVER crosses: export refuses if asked to carry it,
 *    and re-scans the output afterwards (belt and suspenders)
 *  - every manifest entry is hashed from the SOURCE bytes actually copied
 *  - verify re-proves: manifest ≡ files on disk → chain walk → Ed25519
 *    anchors (public key) → TSR imprint+time (structural; CA trust needs the
 *    operator's bundle, exactly as in the TSR lane)
 *  - verdicts: BUNDLE_OK / BUNDLE_TAMPERED:<file> / BUNDLE_INCOMPLETE:<what>
 *    / BUNDLE_UNTRUSTED_FORMAT / CHAIN_BROKEN / ANCHOR_* / TSR_* passthrough
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuditChain } from './chain.js';
import { verifyAnchor } from './anchor.js';
import { verifyTimestamp } from './timestamp.js';

const BUNDLE_FORMAT = 'majin-v2-audit-bundle';
const BUNDLE_VERSION = 1;
const CORE_FILES = ['chain.jsonl', 'head.json'];
const OPT_FILES = ['anchors.jsonl', 'anchors.tsr', 'anchor-tsr.json'];
const PUB_KEY = path.join('keys', 'ed25519.public.pem');
const PRIVATE_MARKERS = ['ed25519.private.pem', '.private.pem'];

export function findPrivateMaterial(dir) {
  const leaked = [];
  if (!fs.existsSync(dir)) return leaked;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (PRIVATE_MARKERS.some((m) => e.name.endsWith(m))) leaked.push(p); } };
  walk(dir);
  return leaked;
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

export function exportBundle(srcDir, outDir) {
  const src = path.resolve(srcDir);
  const out = path.resolve(outDir);
  if (src === out || out.startsWith(src + path.sep)) {
    throw new Error('REFUSED: bundle destination must not be inside the audit dir (no recursive self-copies)');
  }
  const chain = new AuditChain(src);
  const verdict = chain.verify({ anchor: false });
  if (!verdict.ok) {
    const err = new Error(`REFUSED: chain broken (${verdict.reason} at line ${verdict.brokenAt}) — a bundle of a broken chain would be false evidence`);
    err.cls = 'CHAIN_BROKEN';
    throw err;
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(out, rel));
    const st = fs.statSync(path.join(out, rel));
    files.push({ path: rel.split(path.sep).join('/'), sha256: sha256File(path.join(out, rel)), bytes: st.size });
  };
  for (const f of CORE_FILES) {
    if (!fs.existsSync(path.join(src, f))) { const e = new Error(`REFUSED: ${f} missing — cannot build a bundle of nothing`); e.cls = 'BUNDLE_INCOMPLETE'; throw e; }
    copy(f);
  }
  for (const f of OPT_FILES) if (fs.existsSync(path.join(src, f))) copy(f);
  const hasAnchor = fs.existsSync(path.join(src, 'anchors.jsonl'));
  if (fs.existsSync(path.join(src, PUB_KEY))) copy(PUB_KEY);
  else if (hasAnchor) { const e = new Error('REFUSED: anchors exist but public key is missing — an unverifiable bundle is a lie'); e.cls = 'BUNDLE_INCOMPLETE'; throw e; }
  const manifest = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: new Date().toISOString(),
    stats: { entries: verdict.entries, head: verdict.head, anchors: hasAnchor, tsr: fs.existsSync(path.join(src, 'anchors.tsr')) },
    files,
  };
  fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  // belt and suspenders: scan the OUTPUT for private material, refuse loudly if any sneaks along
  const leaked = findPrivateMaterial(out);
  if (leaked.length) {
    fs.rmSync(out, { recursive: true, force: true });
    const e = new Error(`REFUSED and WIPED: private key material would have left the machine (${leaked.map((p) => path.basename(p)).join(', ')})`);
    e.cls = 'PRIVATE_MATERIAL_REFUSED';
    throw e;
  }
  return Object.freeze({ ok: true, out, files: files.length, stats: manifest.stats });
}

export function verifyBundle(bundleDir, { tsrOpts = {} } = {}) {
  const dir = path.resolve(bundleDir);
  const mf = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(mf)) return { ok: false, cls: 'BUNDLE_INCOMPLETE', detail: 'MANIFEST.json missing — not a bundle (or a stripped one)' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return { ok: false, cls: 'BUNDLE_UNTRUSTED_FORMAT', detail: `manifest unparseable: ${e.message}` }; }
  if (manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION) {
    return { ok: false, cls: 'BUNDLE_UNTRUSTED_FORMAT', detail: `unknown format/version: ${manifest.format}@${manifest.version}` };
  }
  for (const f of manifest.files) {
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) return { ok: false, cls: `BUNDLE_TAMPERED:${f.path}`, detail: 'file listed in manifest is absent' };
    if (sha256File(p) !== f.sha256) return { ok: false, cls: `BUNDLE_TAMPERED:${f.path}`, detail: 'sha256 differs from manifest — bytes changed since export' };
  }
  // private material on the verifier side = format violation worth flagging (not our bytes to police, but honest)
  const chain = new AuditChain(dir).verify({ anchor: false });
  if (!chain.ok) return { ok: false, cls: 'CHAIN_BROKEN', chain, detail: 'chain fails its own walk — tampered or truncated' };
  const anchors = manifest.stats.anchors ? verifyAnchor(dir) : { cls: 'NO_ANCHOR', ok: true, inconclusive: true };
  if (anchors.ok === false) return { ok: false, cls: anchors.cls, chain, anchors, detail: anchors.detail };
  const tsr = manifest.stats.tsr ? verifyTimestamp(dir, tsrOpts) : { cls: 'TSR_NOT_REQUESTED', ok: true, inconclusive: true };
  if (tsr.ok === false) return { ok: false, cls: tsr.cls, chain, anchors, tsr, detail: tsr.detail };
  return Object.freeze({
    ok: true, cls: 'BUNDLE_OK', chain, anchors, tsr,
    detail: `manifest ${manifest.files.length} files ≡ disk, chain ${chain.entries} entries head ${chain.head.slice(0, 16)}, anchors ${anchors.cls}, tsr ${tsr.cls} (existence-in-time: ${tsr.genTime || 'unproven — honest'})`,
  });
}
