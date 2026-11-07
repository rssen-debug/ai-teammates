/**
 * MAJIN — desktop vision grounding lane (majin-desktop-vision/1)
 * Pattern reused from absorb microsoft/UFO (MIT): HostAgent→AppAgent LAYOUT
 * and the conditional-hardware-import discipline (their basic.py refuses to
 * load pywinauto on non-Windows instead of crashing; we refuse to CLAIM a
 * capture/grounding without real bytes). UFO code/content never copied —
 * the composition is MAJIN's (vision.js analyzer + computer-use observe).
 *
 * Rules:
 * - captureFn is INJECTED. No captureFn → refusal to observe (never fabricate
 *   a screenshot; a "vision answer" about a screen we never saw is a lie).
 * - Screenshot evidence = bytes + sha256, written to disk BEFORE analysis.
 * - Grounding accepts ONLY a strict JSON coordinates contract from the vision
 *   model; malformed prose never becomes a click target.
 * - Verification uses a caller-supplied accept() — never "the model said yes".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 'majin-desktop-vision/1';

export class DesktopVisionError extends Error { constructor(msg) { super(msg); this.name = 'DesktopVisionError'; } }

/** Honest platform gate — the live lane exists ONLY on Windows (pattern: UFO conditional import). */
export function platformGate(platform = process.platform) {
  return {
    platform,
    canCaptureLive: platform === 'win32',
    lane: platform === 'win32' ? 'live-windows' : 'deferred-hardware-required',
  };
}

export function evidenceDir(workspaceDir, id) {
  const d = path.join(workspaceDir, 'desktop-vision', String(id));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** capture → bytes + sha256 written to disk. No bytes from captureFn = hard refusal. */
export async function captureEvidence({ captureFn, dir, name = 'shot' }) {
  if (typeof captureFn !== 'function') throw new DesktopVisionError('no captureFn injected — core will not claim a screenshot it never took (live lane: wincontrol/screen.capture on Windows)');
  const out = await captureFn();
  const buf = Buffer.isBuffer(out) ? out : (typeof out === 'string' && fs.existsSync(out) ? fs.readFileSync(out) : null);
  if (!buf || buf.length === 0) throw new DesktopVisionError('captureFn produced no bytes — refusing to ground vision on an empty screen');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const file = path.join(dir, `${name}-${sha256.slice(0, 8)}.png`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, sha256, capturedAt: new Date().toISOString() };
}

/** Extract the strict [{label,x,y}] grounding contract out of a vision answer. Malformed = NO targets (never guessed). */
export function parseGroundingContract(answer) {
  if (typeof answer !== 'string') return null;
  const m = answer.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  for (const t of arr) {
    if (typeof t !== 'object' || t === null) return null;
    if (typeof t.label !== 'string' || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
  }
  return arr;
}

/** capture → analyze → STRICT-COORDINATES targets. Malformed answers refuse loudly. */
export async function groundTargets({ captureFn, analyzeFn, dir, question }) {
  const ev = await captureEvidence({ captureFn, dir, name: 'ground' });
  if (typeof analyzeFn !== 'function') throw new DesktopVisionError('no analyzeFn injected — vision requires a real model call, core will not invent coordinates');
  const answer = String(await analyzeFn({ imagePath: ev.file, question }));
  const targets = parseGroundingContract(answer);
  if (!targets) throw new DesktopVisionError(`vision answer did not satisfy the strict grounding contract [{"label","x","y"}] — refusing to act on prose. answer head: ${JSON.stringify(answer.slice(0, 120))}`);
  return { evidence: ev, targets, answerTail: answer.slice(0, 400) };
}

/** Full observe→verify: capture evidence FIRST, analyze, then caller's accept() decides. Evidence written always. */
export async function verifyOnScreen({ captureFn, analyzeFn, dir, question, accept }) {
  if (typeof accept !== 'function') throw new DesktopVisionError('no accept-supplied verifier — "model said yes" is never a proof');
  const ev = await captureEvidence({ captureFn, dir, name: 'verify' });
  if (typeof analyzeFn !== 'function') throw new DesktopVisionError('no analyzeFn injected');
  const answer = String(await analyzeFn({ imagePath: ev.file, question }));
  const passed = accept(answer) === true;
  const record = { version: VERSION, evidence: ev, question, answer: answer.slice(0, 800), passed, at: new Date().toISOString() };
  fs.appendFileSync(path.join(dir, 'verdicts.jsonl'), JSON.stringify(record) + '\n');
  return { record, passed };
}
