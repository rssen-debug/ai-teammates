/**
 * MAJIN PINK CURSOR / REAL COMPUTER USE — the reasoning loop.
 *
 *   OBSERVE  (screen.capture + control.list_windows via EXISTING tools)
 *   PLAN     (injected model Call — same seam pattern as mission/workerOverride)
 *   ACT      (registry.exec into the existing control.* lane; cursor mirror
 *             follows each action when coordinates are known)
 *   VERIFY   (read-back / screenshot-diff — never claim success from
 *             "the click command did not throw")
 *   RECOVER  (bounded retries, FORCED strategy change on no-progress —
 *             W13 RepeatDetector owns the "identical attempt" wall)
 *   CONTINUE (checkpoint evidence every step; explicit blocked-state end)
 *
 * DELIBERATE SEAM: modelCall + registry makes this fully testable offline;
 * the live path wires in the real agent/model + all real tool side-effects.
 * Everything measurable: steps.jsonl under workspace/computer-use/<id>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RepeatDetector } from './watchdog.js';

export const VERSION = 'majin-computer-use/1';

export function sessionId(goal) {
  return crypto.createHash('sha256').update(String(goal)).digest('hex').slice(0, 10);
}

export function evidenceDir(workspaceDir, id) {
  const d = path.join(workspaceDir, 'computer-use', id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function logStep(dir, entry) {
  fs.appendFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

/* Perception snapshot: what did observation PROVE? (tool results, nothing else) */
export async function observe({ registry, ctx }) {
  const out = { windows: [], screen: null, notes: [] };
  const wins = await registry.exec('control.list_windows', {}, ctx).catch((e) => ({ ok: false, error: { message: e.message } }));
  if (wins?.ok) {
    try {
      out.windows = (wins.meta?.windows || wins.result || []).slice(0, 40);
    } catch { out.notes.push('window list unparseable'); }
  } else {
    out.notes.push(`control.list_windows: ${wins?.error?.message || 'unavailable'}`);
  }
  const cap = await registry.exec('screen.capture', {}, ctx).catch(() => ({ ok: false }));
  if (cap?.ok) out.screen = { path: cap.meta?.path || 'captured', bytes: cap.meta?.bytes ?? null };
  return out;
}

/* VERIFY: what proof can we collect for this plan-intent? */
export async function verify({ registry, ctx, check }) {
  if (!check) return { ok: true, note: 'no verification requested — honesty: result UNPROVEN' };
  if (check.type === 'window_exists') {
    const o = await observe({ registry, ctx });
    const hit = o.windows.some((w) => String(w.title || '').toLowerCase().includes(String(check.title).toLowerCase()));
    return { ok: hit, note: hit ? `window "${check.title}" present after action` : `window "${check.title}" NOT found after action` };
  }
  if (check.type === 'read_contains') {
    const r = await registry.exec('control.read', { window: check.window }, ctx).catch((e) => ({ ok: false, error: { message: e.message } }));
    const txt = r?.meta?.text ?? r?.result ?? '';
    return { ok: Boolean(r?.ok && String(txt).includes(check.text)), note: r?.ok ? `read-back ${String(txt).includes(check.text) ? 'matched' : 'DID NOT match'} "${check.text}"` : `control.read: ${r?.error?.message || 'failed'}` };
  }
  return { ok: false, note: `unknown verification type "${check.type}"` };
}

/* PLAN → action normalization (model output is NEVER trusted blind) */
const ALLOWED_ACTIONS = new Set(['list_windows', 'type', 'read', 'click_button', 'capture', 'done', 'blocked']);
export function normalizeAction(plan) {
  if (!plan || typeof plan !== 'object') return { kind: 'invalid', error: 'plan was not an object' };
  const kind = String(plan.action || '').toLowerCase();
  if (!ALLOWED_ACTIONS.has(kind)) return { kind: 'invalid', error: `model proposed unallowed action "${kind}" — refused (allowlist only)` };
  if (kind === 'type' && (!plan.window || plan.text === undefined)) return { kind: 'invalid', error: 'type requires window + text' };
  if (kind === 'click_button' && !(plan.window && plan.caption)) return { kind: 'invalid', error: 'click_button requires window + caption' };
  return { kind, args: plan, verify: plan.verify || null };
}

/* The main loop. inject: { registry, modelCall(subjective state)->plan, ctx,
     cursor = async op => {...}, emit = (ev)=>{}, signal } */
export async function computerUse(goal, {
  workspaceDir,
  registry,
  modelCall,
  baseCtx = {},
  maxSteps = 12,
  cursor = async () => {},        /* pink cursor driver — injected, honest noop here */
  emit = () => {},
  signal = null,
} = {}) {
  const id = sessionId(goal + ':' + Date.now());
  const dir = evidenceDir(workspaceDir, id);
  const detect = new RepeatDetector(2);            /* the W13 wall: same plan twice = no progress */
  const attempts = [];
  let lastVerifyNote = '';
  emit({ type: 'cu_start', goal, id });
  logStep(dir, { phase: 'start', goal, maxSteps });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      logStep(dir, { phase: 'aborted', step });
      return { ok: false, status: 'aborted', id, dir, steps: step - 1, reason: 'aborted by user stop' };
    }
    const perception = await observe({ registry, ctx: { ...baseCtx, session: `cu:${id}` } });
    emit({ type: 'cu_observe', step, windows: perception.windows.length, screen: Boolean(perception.screen) });
    logStep(dir, { phase: 'observe', step, windows: perception.windows.length, notes: perception.notes });

    let raw;
    try {
      raw = await modelCall({ goal, step, perception, attempts: attempts.slice(-6), lastVerifyNote });
    } catch (e) {
      logStep(dir, { phase: 'blocked', step, reason: `modelCall threw: ${e.message}` });
      emit({ type: 'cu_done', ok: false, reason: 'model fail' });
      return { ok: false, status: 'blocked', id, dir, steps: step, reason: `planning failed: ${e.message}`, errorCategory: 'model' };
    }
    const plan = normalizeAction(raw);
    if (plan.kind === 'invalid') {
      emit({ type: 'cu_invalid_plan', step, error: plan.error });
      lastVerifyNote = plan.error;
      logStep(dir, { phase: 'invalid_plan', step, error: plan.error, raw: raw ?? null });
      continue;
    }
    if (plan.kind === 'done') {
      // "done" WITHOUT independent verification is not completion. The
      // previous implementation treated verify(null) as ok=true, allowing a
      // model to mark a desktop action complete without evidence.
      if (!plan.verify) {
        lastVerifyNote = 'The requested desktop outcome is NOT VERIFIED. Return a done action with a measurable verify check (window_exists or read_contains).';
        logStep(dir, { phase: 'unverified_done_claim', step, note: lastVerifyNote });
        emit({ type: 'cu_unverified', step, note: lastVerifyNote });
        continue;
      }
      const v = await verify({ registry, ctx: { ...baseCtx, session: `cu:${id}` }, check: plan.verify });
      logStep(dir, { phase: v.ok ? 'complete' : 'unverified_done_claim', step, verify: v });
      if (!v.ok) {
        lastVerifyNote = `the "done" claim was NOT proven: ${v.note}`;
        emit({ type: 'cu_unverified', step, note: v.note });
        continue;                                   /* model must PROVE done, not assert it */
      }
      emit({ type: 'cu_done', ok: true, id });
      return { ok: true, status: 'complete', id, dir, steps: step, verify: v.note };
    }
    if (plan.kind === 'blocked') {
      logStep(dir, { phase: 'blocked', step, reason: plan.args.reason || 'model reported genuine blocker' });
      emit({ type: 'cu_done', ok: false, reason: plan.args.reason });
      return { ok: false, status: 'blocked', id, dir, steps: step, reason: plan.args.reason || 'genuine blocker reported', errorCategory: plan.args.category || 'blocked' };
    }

    /* RepeatDetector: identical plan twice = forced strategy change, not a click again */
    const rep = detect.hit(plan.kind, plan.args);
    if (rep.repeat) {
      lastVerifyNote = `REPEAT WALL: identical action "${plan.kind}" proposed ${rep.count}x — you MUST change strategy (different window, alternative tool, or read state again). Repeats are refused.`;
      logStep(dir, { phase: 'repeat_wall', step, action: plan.kind, key: rep.key });
      emit({ type: 'cu_repeat_wall', step, action: plan.kind });
      continue;
    }

    /* ACT — through the real tool lane, approvals intact */
    const tool = plan.kind === 'capture' ? 'screen.capture'
      : plan.kind === 'type' ? 'control.type'
      : plan.kind === 'read' ? 'control.read'
      : plan.kind === 'click_button' ? 'control.click_button'
      : 'control.list_windows';
    emit({ type: 'cu_act', step, tool, args: plan.args });
    if (plan.args.x != null && plan.args.y != null) await cursor({ op: 'move', x: plan.args.x, y: plan.args.y, label: labelFor(plan.kind) }).catch(() => {});
    const out = await registry.exec(tool, plan.args, { ...baseCtx, session: `cu:${id}`, step });
    const ok = out?.ok === true;
    logStep(dir, { phase: 'act', step, tool, ok, error: ok ? null : out?.error?.message || 'unknown' });
    attempts.push({ step, action: plan.kind, ok });
    if (!ok) {
      lastVerifyNote = `action "${tool}" failed: ${out?.error?.message || 'unknown'} (${out?.error?.code || 'no-code'})`;
      emit({ type: 'cu_act_fail', step, tool, error: lastVerifyNote });
      continue;
    }
    /* VERIFY (when the plan declared how) */
    const v = await verify({ registry, ctx: { ...baseCtx, session: `cu:${id}` }, check: plan.verify });
    logStep(dir, { phase: 'verify', step, ok: v.ok, note: v.note });
    lastVerifyNote = v.ok ? `verified: ${v.note}` : `NOT verified: ${v.note}`;
    emit({ type: v.ok ? 'cu_verify' : 'cu_verify_fail', step, note: v.note });
  }
  logStep(dir, { phase: 'blocked', reason: `maxSteps=${maxSteps} without verified completion` });
  emit({ type: 'cu_done', ok: false, reason: 'max steps' });
  return { ok: false, status: 'blocked', id, dir, steps: maxSteps, reason: `the goal was not verified complete within ${maxSteps} steps`, errorCategory: 'budget' };
}

function labelFor(kind) {
  return { type: 'Typing…', click_button: 'Clicking…', read: 'Reading…', list_windows: 'Inspecting…', capture: 'Observing…' }[kind] || 'Working…';
}
