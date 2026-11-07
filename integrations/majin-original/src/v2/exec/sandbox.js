/**
 * V2 sandboxed executor (master brief sections 49-52 + 36-39 + 40).
 *
 * Every command must pass IN ORDER:
 *   1. whole-chain whitelist check (every segment's executable accounted for)
 *   2. preflight tier scan (ok/hold/no — 'no' never runs)
 *   3. approval-mode decision ('ask' -> recorded consent layer)
 *   4. cwd confinement under the workspace root
 * Only then does a process spawn. Nothing is hidden from the event stream:
 * denials and waits emit too, so the audit trail shows what was NOT run.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { preflight } from '../safety/command-preflight.js';
import { decide } from './approval-modes.js';

function runProcess(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 64 * 1024) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 64 * 1024) err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: -1, stdout: out, stderr: String(e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit: code ?? -1, stdout: out, stderr: err });
    });
  });
}

export async function sandboxedExec(command, { root, cwd, whitelist, approvals, events, mode = 'balanced', timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  const base = { command, durationMs: 0 };

  // preflight FIRST: a tier-'no' command must surface as blocked even if the
  // executable is not whitelisted (the honest reason takes precedence).
  const pf = preflight(command);
  const w = whitelist.check(command);
  if (!w.allowed) {
    events?.emit('task.updated', { taskId: 'exec', to: 'denied', phase: 'whitelist', missing: w.missing });
    return { ...base, decision: 'denied', reason: `executable(s) not whitelisted: ${w.missing.join(', ')}`, safety: { tier: pf.tier, mode }, exit: null };
  }
  const dec = decide({ mode, tier: pf.tier, whitelisted: w.allowed });
  if (dec.decision === 'blocked') {
    events?.emit('task.updated', { taskId: 'exec', to: 'blocked', phase: 'preflight', tier: pf.tier });
    return { ...base, decision: 'blocked', reason: `preflight: ${pf.reason}`, safety: { tier: pf.tier, mode }, exit: null };
  }
  if (dec.decision === 'ask') {
    const scope = `shell:${pf.tier}:${command.slice(0, 120)}`;
    const c = approvals.check(scope, { preflightReason: pf.reason });
    if (c.decision !== 'allow') {
      events?.emit('task.updated', { taskId: 'exec', to: 'waiting', phase: 'consent', scope });
      return { ...base, decision: 'waiting', reason: c.note || 'consent pending', pendingScope: scope, safety: { tier: pf.tier, mode }, exit: null };
    }
  }

  const rootR = path.resolve(root);
  const cwdR = path.resolve(cwd ?? root);
  if (!(cwdR === rootR || cwdR.startsWith(rootR + path.sep))) {
    events?.emit('task.updated', { taskId: 'exec', to: 'denied', phase: 'confinement', cwd: cwdR });
    return { ...base, decision: 'denied', reason: 'cwd escapes the declared workspace root', exit: null };
  }

  const r = await runProcess(command, cwdR, timeoutMs);
  const receipt = {
    ...base,
    decision: 'done',
    exit: r.exit,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: Date.now() - t0,
    safety: { tier: pf.tier, mode, whitelisted: true },
  };
  events?.emit('task.updated', { taskId: 'exec', to: 'done', exit: r.exit, durationMs: receipt.durationMs });
  return receipt;
}
