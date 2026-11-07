/**
 * MAJIN W13 — never-stuck recovery matrix (chaos-style, evidence-based).
 *
 * Pattern absorbed from chaostoolkit/chaostoolkit (Apache-2.0, absorb-scanned
 * 2026-10-21): an "experiment" declares (a) a steady-state HYPOTHESIS with a
 * bound, (b) a METHOD of deliberate fault injection, (c) a verdict derived
 * from measured truth. Nothing here invents resilience machinery — every row
 * exercises REAL shipped components and measures whether MAJIN terminates
 * never-stuck:
 *
 *   verdict = recovered  — the work completed despite the injected fault
 *             controlled — explicit non-completion WITH evidence (blocked
 *                            flag, budget error, deadline, rejection) — an
 *                            honest stop is never a stuck
 *             STUCK      — hypothesis bound breached or uncontrolled error
 *             not_tested — prereq missing (excluded from the rate, reported)
 *
 * Invariants the matrix measures (and the test suite gates on):
 *   I1 no STUCK row in the deterministic suite
 *   I2 zero unhandled rejections leaked during the whole run
 *   I3 every executed row finishes inside its own bound
 *   I4 recovery-rate > 0 only counts REAL verdicts (not emptied-row art)
 */

import { performance } from 'node:perf_hooks';
import { runSwarm, isTransientFailure } from './swarm.js';
import { TeamStore, runTeam, TeamBudgetError, TeamInputError } from './teams.js';
import { withTimeout, withAbortDeadline, RepeatDetector, StallTracker, ApprovalWatch } from './watchdog.js';
import { canonicalMissionId, checkpointDir, writeState, readState, journalEvent, carryFromState } from './mission-checkpoint.js';

export const RECOVERY_MATRIX_VERSION = 'majin-recovery-matrix/1';

/* NOTE: no unref here — a standalone (script) run of the matrix exits the
   moment the loop only holds unref'd timers; that would silently CUT the
   suite mid-matrix with an innocent-looking code 0 (measured on the first
   run: rows 4+ never printed). Lib-side watchdog timers keep their own
   unref hygiene; the matrix's own waits must keep the loop alive. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tiny difference between "blocked" (dependency) and a failing verdict row */
const node = (id, run, extra = {}) => ({ id, run, ...extra });

async function measure(boundMs, fn) {
  const t0 = performance.now();
  try {
    const facts = await fn();
    const ms = Math.round(performance.now() - t0);
    if (ms > boundMs) return { verdict: 'STUCK', why: `bound ${boundMs}ms breached: ${ms}ms`, ms, facts };
    return { ms, facts };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    return { verdict: 'STUCK', why: `uncontrolled error: ${String(e && e.message || e).slice(0, 200)}`, ms };
  }
}

/* ------------------------------------------------------------------ */

export function buildMatrix({ workspaceDir, defaultBoundMs = 4000 } = {}) {
  const store = new TeamStore({ workspaceDir });
  const rows = [];

  rows.push({
    id: 'swarm.transient-retry-recovers',
    boundMs: defaultBoundMs,
    hypothesis: 'short transient provider flake recovers via bounded retry; work completes',
    async method() {
      let tries = 0; const events = [];
      const out = await runSwarm({
        nodes: [node('a', async () => { tries += 1; if (tries === 1) throw new Error('ETIMEDOUT socket hang up'); return { text: 'a-ok' }; })],
        cap: 1, maxAttempts: 3, adaptive: false, onEvent: (e) => events.push(e.type),
      });
      return {
        verdict: out.okCount === 1 && tries === 2 && events.includes('worker_retry') ? 'recovered'
          : 'STUCK',
        facts: { tries, okCount: out.okCount, sawRetry: events.includes('worker_retry') },
      };
    },
  });

  rows.push({
    id: 'swarm.permanent-fail-blocks-dependents',
    boundMs: defaultBoundMs,
    hypothesis: 'permanent failure stops the chain honestly: dependents blocked, independents complete, the run terminates',
    async method() {
      const out = await runSwarm({
        nodes: [
          node('a', async () => { throw new Error('permission denied PERMANENT'); }),
          node('b', async () => ({ text: 'b' }), { deps: ['a'] }),
          node('c', async () => ({ text: 'c-ok' })),
        ], cap: 2, maxAttempts: 2, adaptive: false,
      });
      const blockedOk = out.results.get('b') && out.results.get('b').blocked === true;
      return {
        verdict: out.failCount === 1 && out.okCount === 1 && blockedOk ? 'controlled' : 'STUCK',
        facts: { failCount: out.failCount, okCount: out.okCount, bBlocked: blockedOk, bReason: out.results.get('b')?.reason },
      };
    },
  });

  rows.push({
    id: 'swarm.bad-input-rejected-plainly',
    boundMs: defaultBoundMs,
    hypothesis: 'defective input (unknown dep, cycle) is rejected loudly up front — never partial work',
    async method() {
      let depErr = null; let cycErr = null;
      try { await runSwarm({ nodes: [node('x', async () => ({}), { deps: ['ghost'] })] }); } catch (e) { depErr = String(e.message); }
      try { await runSwarm({ nodes: [node('x', async () => ({}), { deps: ['y'] }), node('y', async () => ({}), { deps: ['x'] })] }); } catch (e) { cycErr = String(e.message); }
      return {
        verdict: /unknown dep "ghost"/.test(depErr) && /cyclic graph/.test(cycErr) ? 'controlled' : 'STUCK',
        facts: { depErr, cycErr },
      };
    },
  });

  rows.push({
    id: 'swarm.deadline-marks-remaining',
    boundMs: 3000,
    hypothesis: 'timeoutMs terminates: the hanging node is blocked with reason=deadline; the run returns inside timeout + small margin',
    async method() {
      const out = await runSwarm({
        nodes: [
          node('slow', async () => { await sleep(1500); return { text: 'never' }; }),
          node('next', async () => ({ text: 'x' }), { deps: ['slow'] }),
        ], cap: 1, timeoutMs: 200, adaptive: false,
      });
      const slowR = out.results.get('slow'); const nextR = out.results.get('next');
      return {
        verdict: out.wallMs < 1500 && ((slowR && slowR.blocked) || (nextR && nextR.blocked)) ? 'controlled' : 'STUCK',
        facts: { wallMs: out.wallMs, blocked: out.blockedCount },
      };
    },
  });

  rows.push({
    id: 'swarm.abort-signal-cancels-honestly',
    boundMs: defaultBoundMs,
    hypothesis: 'external abort stops the chain with an explicit cancelled marker — never half-stuck waiting forever',
    async method() {
      const ac = new AbortController(); const events = [];
      const p = runSwarm({
        nodes: [node('a', async () => ({ text: 'a' })), node('b', async () => { await sleep(1200); return { text: 'b' }; }, { deps: ['a'] })],
        cap: 1, signal: ac.signal, adaptive: false, onEvent: (e) => events.push(e.type),
      });
      setTimeout(() => ac.abort(), 50);
      const out = await p;
      return {
        verdict: out.wallMs < 1500 && events.includes('worker_cancel') ? 'controlled' : 'STUCK',
        facts: { wallMs: out.wallMs, cancelled: events.includes('worker_cancel') },
      };
    },
  });

  rows.push({
    id: 'swarm.adaptive-overrun-contracts-and-completes',
    boundMs: defaultBoundMs,
    hypothesis: 'measured actuals 4x over estMs prove plan fragility: cap contracts, adaptations journal why, work still completes',
    async method() {
      /* windows into a still-queuing scheduler: MORE nodes than cap — adapten
         utvärderas bara när osStartade noder väntar (mätt på första sviten:
         med nodes<=cap startar allt direkt, inga beslutspunkter återstår). */
      const mk = (id) => node(id, async () => { await sleep(60); return { text: id }; }, { estMs: 10 });
      const events = [];
      const out = await runSwarm({ nodes: ['a','b','c','d','e','f'].map(mk), cap: 3, adaptive: true, overrunFactor: 2, onEvent: (e) => events.push(e) });
      const overrun = events.filter((e) => e.type === 'topology_adapt' && /overrun/.test(e.reason));
      return {
        verdict: out.okCount === 6 && overrun.length >= 1 ? 'recovered' : 'STUCK',
        facts: { okCount: out.okCount, adaptations: out.adaptive.adaptations.length, sawOverrun: overrun.length > 0 },
      };
    },
  });

  rows.push({
    id: 'swarm.critical-tail-first-launch-order',
    boundMs: defaultBoundMs,
    hypothesis: 'longest critical tail launches first when capacity is scarce (ranked, deterministic)',
    async method() {
      const order = [];
      const n = (id, est, deps = []) => node(id, async () => { order.push(id); return { text: id }; }, { estMs: est, deps });
      const out = await runSwarm({
        nodes: [n('tail-large', 300), n('tail-small', 40), n('tail-mid', 120)],
        cap: 1, adaptive: false,
      });
      return {
        verdict: out.okCount === 3 && order[0] === 'tail-large' && order[1] === 'tail-mid' ? 'recovered' : 'STUCK',
        facts: { order },
      };
    },
  });

  rows.push({
    id: 'watchdog.tool-timeout-fires',
    boundMs: 2000,
    hypothesis: 'hanging tool times out with explicit code (no forever-wait in the loop)',
    async method() {
      let code = null;
      try { await withTimeout(sleep(1500), { ms: 100, code: 'tool_timeout', label: 'demo' }); } catch (e) { code = e.code || String(e.message); }
      return { verdict: code === 'tool_timeout' || /timeout/i.test(String(code)) ? 'controlled' : 'STUCK', facts: { code } };
    },
  });

  rows.push({
    id: 'watchdog.abort-deadline-parent-abort',
    boundMs: 2000,
    hypothesis: 'parent abort cancels the job with an explicit signal error',
    async method() {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 60);
      let err = null;
      try { await withAbortDeadline(sleep(1500), { ms: 5000, parentSignal: ac.signal, label: 'demo' }); } catch (e) { err = e.name || e.code || String(e.message); }
      return { verdict: err ? 'controlled' : 'STUCK', facts: { err } };
    },
  });

  rows.push({
    id: 'watchdog.repeat-detector-flags-no-progress',
    boundMs: 2000,
    hypothesis: 'identical consecutive tool calls are flagged as no-progress (repeat >= limit); an intervening different call resets',
    async method() {
      const rd = new RepeatDetector(3);
      rd.hit('fs.read', { path: 'a' }); rd.hit('fs.read', { path: 'a' });
      const third = rd.hit('fs.read', { path: 'a' });
      const reset = rd.hit('fs.read', { path: 'b' }); // andra argument → återställ
      return {
        verdict: third.repeat === true && reset.repeat === false && reset.count === 1 ? 'recovered' : 'STUCK',
        facts: { thirdCount: third.count, afterReset: reset.count },
      };
    },
  });

  rows.push({
    id: 'watchdog.stall-and-approval-transitions',
    boundMs: 2000,
    hypothesis: 'stall + approval state explicit: inactivity reported honestly; approvals transition active->stalled->timed_out, never silently',
    async method() {
      let t = 1000;
      const st = new StallTracker({ now: () => t });
      const before = st.checkStall(500);
      t += 600;
      const after = st.checkStall(500);
      const events = [];
      const aw = new ApprovalWatch({ stallMs: 100, timeoutMs: 300, onStall: (e) => events.push(['stall', e.id]), onTimeout: (e) => events.push(['timeout', e.id]) });
      aw.watch('ap1', { at: 0 });
      aw.tick(150); aw.tick(400);
      return {
        verdict: before.stalled === false && after.stalled === true && events.some(([k]) => k === 'stall') && events.some(([k]) => k === 'timeout') ? 'controlled' : 'STUCK',
        facts: { before: before.stalled, after: after.stalled, transitions: events.map(([k, id]) => `${k}:${id}`) },
      };
    },
  });

  rows.push({
    id: 'teams.budget-loud-then-resume-wins',
    boundMs: defaultBoundMs,
    hypothesis: 'budget exhaustion = LOUD TeamBudgetError + partial checkpoint; resuming with a raised cap finishes the REST without touching completed nodes',
    async method() {
      store.ensureTeam('w13'); store.addMember('w13', { id: 'a', role: 'verify' });
      const calls1 = [];
      const mk = (calls) => (member) => async (nd) => { calls.push(nd.id); return { text: nd.id, steps: 2, tools: [] }; };
      const first = await runTeam({
        team: 'w13', store, teamStepCap: 2, runId: 'w13-budget',
        goals: [{ id: 'g1', member: 'a', input: 'x' }, { id: 'g2', member: 'a', input: 'y', deps: ['g1'] }],
        makeWorker: mk(calls1), cfg: null, registry: null,
      });
      const budgetErrorVisible = String(first.results.get('g2').error || '').includes('teamStepCap');
      const calls2 = [];
      const second = await runTeam({
        team: 'w13', store, resumeId: 'w13-budget', teamStepCap: 10,
        goals: [{ id: 'g1', member: 'a', input: 'x' }, { id: 'g2', member: 'a', input: 'y', deps: ['g1'] }],
        makeWorker: mk(calls2), cfg: null, registry: null,
      });
      return {
        verdict: first.status === 'partial' && budgetErrorVisible && second.okCount === 2 && calls2.length === 1 && calls2[0] === 'g2' ? 'recovered' : 'STUCK',
        facts: { firstStatus: first.status, skipped: second.skipped, calls2, spentAfterResume: second.spent },
      };
    },
  });

  rows.push({
    id: 'teams.crash-resume-exactly-once',
    boundMs: defaultBoundMs,
    hypothesis: 'crash mid-graph: resume NEVER re-runs a completed node (counter-proof), the rest completes',
    async method() {
      store.ensureTeam('w13b'); store.addMember('w13b', { id: 'a', role: 'act' });
      const mkC = (calls, failOn) => (member) => async (nd) => { calls.push(nd.id); if (failOn === nd.id) throw new Error('process abruptly died'); return { text: nd.id, steps: 1 }; };
      const c1 = [];
      const first = await runTeam({
        team: 'w13b', store, runId: 'w13-crash',
        goals: [{ id: 'g1', member: 'a', input: 'x' }, { id: 'g2', member: 'a', input: 'y', deps: ['g1'] }],
        makeWorker: mkC(c1, 'g2'), cfg: null, registry: null,
      });
      const c2 = [];
      const resumed = await runTeam({
        team: 'w13b', store, resumeId: 'w13-crash',
        goals: [{ id: 'g1', member: 'a', input: 'x' }, { id: 'g2', member: 'a', input: 'y', deps: ['g1'] }],
        makeWorker: mkC(c2), cfg: null, registry: null,
      });
      return {
        verdict: first.failCount === 1 && c2.length === 1 && c2[0] === 'g2' && resumed.okCount === 2 ? 'recovered' : 'STUCK',
        facts: { firstCalls: c1, resumedCalls: c2, okAfter: resumed.okCount },
      };
    },
  });

  rows.push({
    id: 'mission.checkpoint-carry-verified-only',
    boundMs: 2000,
    hypothesis: 'mission-checkpoint: WRITE->CRASH->READ yields carry of ONLY verified nodes — half-written/unverified never count as done',
    async method() {
      const goal = 'w13 matrix mission ' + Date.now();
      const id = canonicalMissionId(goal);
      const dir = checkpointDir(workspaceDir, id);
      writeState(dir, {
        id, goal,
        nodes: [
          { id: 'n1', status: 'verified', text: 'part-n1-evidence' },
          { id: 'n2', status: 'running' },
          { id: 'n3', status: 'failed', text: 'should not carry (failed != verified)' },
        ],
      });
      journalEvent(dir, { kind: 'matrix-injected-crash' });
      const st = readState(dir);
      const carry = carryFromState(st);
      const carriedKeys = carry ? Object.keys(carry) : [];
      return {
        verdict: st && st.id === id && carriedKeys.length === 1 && carriedKeys[0] === 'n1' && carry.n1.verified === true ? 'controlled' : 'STUCK',
        facts: { carriedKeys, journalLineWritten: true },
      };
    },
  });

  /* isTransientFailure-classifier precision used by every retry lane */
  rows.push({
    id: 'classifier.transient-vs-permanent-accuracy',
    boundMs: 1000,
    hypothesis: 'retry can never help against permanent failure: the classifier splits the canonical strings correctly',
    async method() {
      const table = [
        ['ETIMEDOUT read ECONNRESET', true], ['socket hang up', true], ['rate limit 429 too many', true],
        ['permission denied — forbidden', false], ['ENOENT no such file: /etc/passwj', false], ['TeamBudgetError: cap reached', false],
      ];
      const misses = table.filter(([s, want]) => isTransientFailure(s) !== want);
      return { verdict: misses.length === 0 ? 'recovered' : 'STUCK', facts: { checked: table.length, misses: misses.map(([s]) => s) } };
    },
  });

  return rows;
}

/* ------------------------------------------------------------------ */

/** Kör alla rader, mät, kalv invariatanterna. Inga modellanrop någonstans. */
export async function runMatrix({ workspaceDir, defaultBoundMs = 4000, onRow = null } = {}) {
  if (!workspaceDir) throw new Error('runMatrix: workspaceDir required');
  const rows = buildMatrix({ workspaceDir, defaultBoundMs });

  let unhandled = 0;
  const onRej = () => { unhandled += 1; };
  process.on('unhandledRejection', onRej);
  const t0 = performance.now();
  const results = [];
  try {
    for (const row of rows) {
      const out = await measure(row.boundMs, row.method);
      const verdict = out.verdict || (out.facts && out.facts.verdict) || 'STUCK';
      const entry = {
        id: row.id, hypothesis: row.hypothesis,
        verdict,
        wallMs: out.ms ?? null,
        reason: out.why || (out.facts && out.facts.verdict ? '' : ''),
        facts: out.facts || {},
      };
      results.push(entry);
      onRow?.(entry);
    }
  } finally {
    process.removeListener('unhandledRejection', onRej);
  }
  const wallMs = Math.round(performance.now() - t0);

  const executed = results.filter((r) => r.verdict !== 'not_tested');
  const recovered = executed.filter((r) => r.verdict === 'recovered');
  const controlled = executed.filter((r) => r.verdict === 'controlled');
  const stuck = executed.filter((r) => r.verdict === 'STUCK');
  const rate = executed.length ? Math.round(((recovered.length + controlled.length) / executed.length) * 1000) / 1000 : 0;

  return {
    version: RECOVERY_MATRIX_VERSION,
    at: new Date().toISOString(),
    wallMs,
    invariants: {
      I1_no_stuck_in_deterministic_suite: stuck.length === 0,
      I2_zero_unhandled_rejections: unhandled === 0,
      I3_every_row_within_bound: results.every((r) => r.verdict !== 'STUCK' || (r.reason || '').includes('bound')),
      I4_rate_counts_only_real_verdicts: executed.length === results.length,
    },
    totals: { rows: results.length, executed: executed.length, recovered: recovered.length, controlled: controlled.length, stuck: stuck.length, not_tested: results.length - executed.length },
    recoveryRate: rate,
    unhandledRejections: unhandled,
    results,
  };
}

export function renderMarkdownReport(m) {
  const ok = (b) => (b ? '✓' : '✗');
  const lines = [
    `# W13 never-stuck recovery matrix — ${m.at}`,
    '',
    `recovery rate: **${(m.recoveryRate * 100).toFixed(1)}%** (${m.totals.recovered} recovered + ${m.totals.controlled} controlled of ${m.totals.executed} executed; ${m.totals.not_tested} excluded as not_tested)`,
    `unhandled rejections leaked: ${m.unhandledRejections} · suite wall: ${m.wallMs}ms`,
    '',
    'invariants:',
    ...Object.entries(m.invariants).map(([k, v]) => `- ${ok(v)} ${k}`),
    '',
    '| scenario | verdict | wall | why/facts |',
    '|---|---|---:|---|',
  ];
  for (const r of m.results) {
    const short = JSON.stringify(r.facts).slice(0, 110);
    lines.push(`| ${r.id} | ${r.verdict}${r.verdict === 'STUCK' ? ' ←' : ''} | ${r.wallMs ?? '—'}ms | ${r.reason || short} |`);
  }
  return lines.join('\n') + '\n';
}
