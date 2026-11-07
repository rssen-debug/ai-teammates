/**
 * MAJIN — W11 desktop task eval harness (majin-desktop-eval/1)
 * Layout reused from absorb laude-institute/terminal-bench (Apache-2.0 task
 * dir+verifier contract: spawn verifier, exit 0 = solved) + microsoft/UFO
 * (MIT: HostAgent/AppAgent task≤app split & deferred-hardware discipline).
 * Content is NEVER copied — every task below is written by MAJIN.
 *
 * Discrimination contract (same discipline as competitive-bench):
 *   - environment 'simulated': harness materializes good/bad end-states from
 *     the task's fixture spec; verifier MUST pass good AND fail bad, else the
 *     VERIFIER is flagged (cheat vs broken distinguished in why).
 *   - environment 'windows-real' on non-Windows host → DEFERRED:
 *     hardware-required (declared, never fabricated, never counted pass/fail).
 *   - Live agent lanes: 'pending-hardware — declared, never fabricated'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const VERSION = 'majin-desktop-eval/1';

export function loadDesktopTasks(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root).sort()) {
    const dir = path.join(root, d);
    const taskFile = path.join(dir, 'task.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(taskFile)) continue;
    const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    out.push({ ...task, id: task.id || d, dir });
  }
  return out;
}

export function materialize(base, fixtures = {}) {
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(fixtures)) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.isBuffer(content) ? content : String(content));
  }
  return base;
}

function runVerifier(task, candidateDir) {
  const script = path.isAbsolute(task.verify.script) ? task.verify.script : path.join(task.dir, task.verify.script);
  const t0 = Date.now();
  const r = spawnSync(task.verify.cmd || 'node', [script, candidateDir], {
    cwd: candidateDir, encoding: 'utf8', timeout: task.verify.timeoutMs || 15000,
    env: { ...process.env, MAJIN_DESKTOP_TASK: task.id },
  });
  return { passed: r.status === 0, wallMs: Date.now() - t0, stdoutTail: String(r.stdout || '').slice(-400), stderrTail: String(r.stderr || '').slice(-400) };
}

/** Simulated contract lane: verifier must discriminate the scripted end-states. */
export function contractDesktopLane(task, { tmpRoot, platform = process.platform }) {
  if ((task.environment || 'simulated') === 'windows-real' && platform !== 'win32') {
    return { task: task.id, environment: 'windows-real', status: 'deferred', reason: 'hardware-required — live Windows desktop; declared, never fabricated' };
  }
  if (!task.fixtures?.good || !task.fixtures?.bad) {
    return { task: task.id, environment: task.environment || 'simulated', status: 'unverified', reason: 'no discrimination fixtures (contract unenforceable)' };
  }
  const goodDir = materialize(path.join(tmpRoot, `${task.id}__good`), task.fixtures.good);
  const badDir = materialize(path.join(tmpRoot, `${task.id}__bad`), task.fixtures.bad);
  const good = runVerifier(task, goodDir);
  const bad = runVerifier(task, badDir);
  const discriminates = good.passed === true && bad.passed === false;
  return {
    task: task.id,
    environment: task.environment || 'simulated',
    status: discriminates ? 'verified' : 'flagged',
    goodPasses: good.passed, badPasses: bad.passed,
    why: discriminates ? 'good end-state passes, bad end-state fails — the verifier measures the desktop state, not a story'
      : !good.passed ? 'verifier REJECTED the known-good end-state — verifier or fixture broken'
      : 'verifier ACCEPTED the known-bad end-state — measurement cheat, desktop scores through it mean nothing',
    wallMs: good.wallMs + bad.wallMs,
  };
}

export function aggregateDesktop(rows, { lanesDeclared = [], lanesRun = [] } = {}) {
  const verified = rows.filter((r) => r.status === 'verified');
  const flagged = rows.filter((r) => r.status === 'flagged');
  const deferred = rows.filter((r) => r.status === 'deferred');
  const unverified = rows.filter((r) => r.status === 'unverified');
  return {
    version: VERSION,
    tasks: rows.length,
    verifiersVerified: verified.length,
    verifiersFlagged: flagged.length,
    verifiersDeferred: deferred.length,
    verifiersUnverified: unverified.length,
    deferredTasks: deferred.map((r) => ({ task: r.task, reason: r.reason })),
    flaggedTasks: flagged.map((r) => ({ task: r.task, why: r.why })),
    lanes: {
      declared: lanesDeclared,
      run: lanesRun,
      agentLanesLive: 'pending-hardware — declared, never fabricated',
    },
    healthy: flagged.length === 0 && verified.length > 0,
  };
}

export function renderDesktopMarkdown(report, rows) {
  const lines = [
    `# MAJIN W11 desktop eval harness — verifier contract (${new Date().toISOString().slice(0, 10)})`,
    '',
    `tasks: ${report.tasks} · verified: ${report.verifiersVerified} · flagged: ${report.verifiersFlagged} · deferred (hardware-required): ${report.verifiersDeferred} · unverified: ${report.verifiersUnverified}`,
    `agent lanes live: ${report.lanes.agentLanesLive}`,
    '',
    '| task | env | contract | good | bad | why |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.task} | ${r.environment} | ${r.status} | ${typeof r.goodPasses === 'boolean' ? String(r.goodPasses) : '—'} | ${typeof r.badPasses === 'boolean' ? String(r.badPasses) : '—'} | ${r.why ?? r.reason ?? ''} |`),
    '',
    report.verifiersDeferred > 0 ? `> ${report.verifiersDeferred} task(s) DEFERRED — hardware-required, declared above, never fabricated or counted.` : '',
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}
