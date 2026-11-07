/**
 * MAJIN — HYPERSWARM execution core (fas 1).
 *
 * Beslutet om hur många workers ett arbete förtjänar är DETERMINISTISK KOD —
 * kritiskt spår, uppskattade makespans och spawn-overhead räknas, aldrig
 * frågas en modell (GENESIS ZERO). Logiken träder in via mission-compilern;
 * den här modulen vet både hur man VÄLJER workers och hur man KÖR dem.
 */
import { run as subagentRun } from './subagent.js';

export const SWARM_DEFAULTS = {
  /* konservativt: spawn-kostnad för en worker (registrering, prompt-bygge,
     routing, första-token golvet) — hellre ensam än överdimenstionerad */
  overheadMs: 1500,
  /* okända arbetstid → swarma inte i blindo */
  cap: 4,
  margin: 0.1, // minst 10% planmässig vinst innan fler workers fyller ett syfte
};

export class SwarmInputError extends Error {
  constructor(msg, cause = null) { super(msg); this.name = 'SwarmInputError'; this.cause = cause; }
}

export function validateGraph(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new SwarmInputError('nodes: empty graph');
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) throw new SwarmInputError('node: missing id');
    if (ids.has(n.id)) throw new SwarmInputError(`node: duplicate id "${n.id}"`);
    ids.add(n.id);
    for (const d of n.deps || []) {
      if (typeof d !== 'string') throw new SwarmInputError(`node ${n.id}: dep must be a node id`);
    }
  }
  for (const n of nodes) for (const d of n.deps || []) {
    if (!ids.has(d)) throw new SwarmInputError(`node ${n.id}: unknown dep "${d}"`);
  }
  // cykelkontroll (Kahn)
  const indeg = new Map(nodes.map((n) => [n.id, (n.deps || []).filter((d) => true).length]));
  const q = nodes.filter((n) => !(n.deps || []).length).map((n) => n.id);
  const seen = new Set(q);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (q.length) {
    const cur = q.shift();
    for (const n of nodes) {
      if ((n.deps || []).includes(cur)) {
        indeg.set(n.id, indeg.get(n.id) - 1);
        if (indeg.get(n.id) === 0 && !seen.has(n.id)) { seen.add(n.id); q.push(n.id); }
      }
    }
  }
  if (seen.size !== nodes.length) throw new SwarmInputError('nodes: cyclic graph');
  return byId;
}

/* WAVE 2 (§8): per-node critical-tail rank — own estimate plus the longest
   downstream tail. Missing estMs ranks 0, so unannotated grids keep stable
   declaration order (pure tie-break). Deterministic, model-free (GENESIS ZERO). */
export function criticalTailRanks(nodes, of = (n) => n.estMs ?? 0) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /* O(n) children index once — the first perf-lab version scanned the whole
     node array per node (O(n²): ~69ms at 2 000 nodes). With the index the
     2 000-node guard drops to single-digit ms; production grids (tens of
     nodes) are free either way, but the lab exists to catch exactly this. */
  const children = new Map();
  for (const x of nodes) {
    for (const d of x.deps || []) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(x.id);
    }
  }
  const ranks = new Map();
  const visiting = new Set();
  const rankOf = (id) => {
    if (ranks.has(id)) return ranks.get(id);
    if (visiting.has(id)) return 0; // cycles are rejected by validateGraph earlier
    visiting.add(id);
    const n = byId.get(id);
    if (!n) return 0;
    const kids = children.get(id) || [];
    let tail = 0;
    for (const k of kids) tail = Math.max(tail, rankOf(k));
    visiting.delete(id);
    const r = of(n) + tail;
    ranks.set(id, r);
    return r;
  };
  for (const n of nodes) rankOf(n.id);
  return ranks;
}

/* kritiskt spår: längsta kedja av estMs */
export function criticalPathMs(nodes, of = (n) => n.estMs ?? 0) {
  const memo = new Map();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const walk = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.size > nodes.length) return 0; // skydd, cyklar ska fångats redan
    const n = byId.get(id);
    stack.add(id);
    const best = Math.max(0, ...(n.deps || []).map((d) => walk(d, stack)));
    memo.set(id, of(n) + best);
    return memo.get(id);
  };
  return nodes.length ? Math.max(...nodes.map((n) => walk(n.id, new Set()))) : 0;
}

/* makespan-simulering: list scheduling, kritisk-väg-först (ärlig, inte optimistisk) */
export function simulateMakespan(nodes, workers, overheadPerWorkerMs = 0) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const remaining = new Map(nodes.map((n) => [n.id, new Set(n.deps || [])]));
  /* aPriorita: ju längre restspår, desto tidigare ska noden köras */
  const restRank = new Map();
  const rankOf = (id) => {
    if (restRank.has(id)) return restRank.get(id);
    const n = byId.get(id);
    const r = (n.estMs ?? 0) + Math.max(0, ...nodes.filter((x) => (x.deps || []).includes(id)).map((x) => rankOf(x.id)));
    restRank.set(id, r);
    return r;
  };
  const ready = [], running = [], done = [];
  let t = 0, spawns = 0;
  for (const n of nodes) if (!remaining.get(n.id).size) ready.push({ id: n.id, at: 0 });
  const freeWorkers = () => workers - running.length;
  while (done.length < nodes.length) {
    ready.sort((a, b) => rankOf(b.id) - rankOf(a.id));
    while (ready.length && freeWorkers() > 0) {
      const r = ready.shift();
      const n = byId.get(r.id);
      spawns += 1;
      running.push({ id: r.id, endsAt: t + (n.estMs ?? 0) });
    }
    if (!running.length && ready.length && freeWorkers() <= 0) break;
    if (!running.length) { /* blockat: deps aldrig klara */ break; }
    t = Math.min(...running.map((x) => x.endsAt));
    const finished = running.filter((x) => x.endsAt <= t + 1e-6);
    for (const f of finished) {
      done.push(f.id);
      for (const n of nodes) {
        if (remaining.get(n.id).has(f.id)) {
          remaining.get(n.id).delete(f.id);
          if (!remaining.get(n.id).size) ready.push({ id: n.id, at: t });
        }
      }
    }
    for (const f of finished) running.splice(running.indexOf(f), 1);
  }
  return t + spawns * overheadPerWorkerMs;
}

export function analyzeSwarm(nodes, opts = {}) {
  const overheadMs = Number(opts.overheadMs ?? SWARM_DEFAULTS.overheadMs);
  const hardCap = Math.max(1, Math.min(8, Number(opts.cap ?? SWARM_DEFAULTS.cap)));
  const margin = Number(opts.margin ?? SWARM_DEFAULTS.margin);
  const byId = validateGraph(nodes);

  const unknown = nodes.some((n) => !Number.isFinite(n.estMs) || n.estMs < 0);
  const sequentialMs = nodes.reduce((a, n) => a + (n.estMs ?? 0), 0);
  const critMs = criticalPathMs(nodes);
  const maxReady = Math.max(1, ...nodes.map(() => 0), ...(() => {
    const levels = new Set();
    const indeg = new Map(nodes.map((n) => [n.id, (n.deps || []).length]));
    const q = nodes.filter((n) => !(n.deps || []).length).map((n) => n.id);
    let layer = q.length;
    let best = q.length;
    const seen = new Set(q);
    const QQ = [...q];
    while (QQ.length) {
      layer = QQ.length;
      best = Math.max(best, layer);
      const next = [];
      while (QQ.length) {
        const cur = QQ.shift();
        for (const n of nodes) {
          if ((n.deps || []).includes(cur) && !seen.has(n.id)) {
            indeg.set(n.id, indeg.get(n.id) - 1);
            if (indeg.get(n.id) === 0) { seen.add(n.id); next.push(n.id); }
          }
        }
      }
      QQ.push(...next);
    }
    return [best];
  })());

  if (nodes.length < 2) {
    return { decision: 'single', workers: 1, sequentialMs, criticalMs: critMs, parallelMs: sequentialMs, overheadMs, reason: 'one node — a swarm has nothing to parallelize' };
  }
  if (unknown) {
    return { decision: 'single', workers: 1, sequentialMs, criticalMs: critMs, parallelMs: sequentialMs, overheadMs, reason: 'unknown work estimates — spawn decision must NOT become a guess, so: conservative single until durations are measured (unknown)' };
  }
  if (critMs >= sequentialMs) {
    return { decision: 'single', workers: 1, sequentialMs, criticalMs: critMs, parallelMs: sequentialMs, overheadMs, reason: `the critical path IS the whole job (${critMs}ms of ${sequentialMs}ms) — extra workers change nothing but cost` };
  }

  /* minsta worker-antal som nästan når oändlig-kapacitet (ärlig planering, ej maximalism) */
  const unlimited = simulateMakespan(nodes, 99, overheadMs);
  let bestWorkers = 1, bestMs = simulateMakespan(nodes, 1, overheadMs);
  for (let w = 2; w <= Math.min(hardCap, maxReady, nodes.length); w++) {
    const m = simulateMakespan(nodes, w, overheadMs);
    if (m <= bestMs * 0.96) { bestMs = m; bestWorkers = w; }
  }
  const gainMs = sequentialMs - bestMs;
  const needsMs = Math.max(overheadMs * 2, sequentialMs * margin);
  if (bestWorkers < 2 || gainMs < needsMs) {
    return {
      decision: 'single', workers: 1, sequentialMs, criticalMs: critMs, parallelMs: sequentialMs, overheadMs,
      reason: `modeled gain ${Math.round(gainMs)}ms < required ${Math.round(needsMs)}ms — spawning workers costs more in overhead/coordination than it buys back`,
    };
  }
  return {
    decision: 'swarm', workers: bestWorkers, sequentialMs, criticalMs: critMs, parallelMs: bestMs, overheadMs, reason: `independent work exists: modeled ${Math.round(bestMs)}ms vs ${sequentialMs}ms sequential — net gain ${Math.round(gainMs)}ms after spawn overhead`,
  };
}

/**
 * runSwarm - WORK-CONSERVING DAG-schemalaggare.
 * Sa fort en worker blir ledig tillelas den nasta korbara nod direkt:
 * aldrig batch-vantan. Blockade noder bubblar transitivt (om a failar ar
 * aven barn-till-barn blocked, med arlig orsak), sa inget vantar for evigt.
 * Stoder AbortSignal: avbruten paus = resterande markeras cancelled.
 */
/** Del 3C: what counts as RETRYABLE. Only network/rate-limit/transient shapes —
   an unknown error is never retried blindly (that is how duplicate side effects
   are born). */
export function isTransientFailure(msg) {
  return /fetch failed|econnreset|econnrefused|enotfound|etimedout|socket hang up|rate.?limit|\b429\b|\b5[0-9][0-9]\b|temporarily|broken pipe|reset by peer/i.test(String(msg || ''));
}

/**
 * WAVE 2 (§5+§8): adaptive topology dispatch.
 *  - §8 launch order is critical-path-first via criticalTailRanks (ties keep
 *    declaration order — unannotated grids behave exactly as before).
 *  - §5 contraction: once measured actuals materially overrun the estMs the
 *    parallelism plan was built on, the scheduler STOPS widening — adding
 *    lanes on a broken model multiplies spawn overhead. cap freezes at the
 *    width active when the overrun was proven. Deterministic, evented, and
 *    reported in the result; `adaptive:false` restores the legacy fixed cap.
 */
export async function runSwarm({ nodes, cap = 4, timeoutMs = 0, signal = null, onEvent = () => {}, maxAttempts = 1, adaptive = true, overrunFactor = 2, maxAdaptations = 50 }) {
  validateGraph(nodes);
  const attempts = new Map(nodes.map((n) => [n.id, 0]));
  const maxAttemptsN = Math.max(1, Math.min(4, Number(maxAttempts) || 1));
  const capN = Math.max(1, Math.min(16, Number(cap) || 4));
  const results = new Map(nodes.map((n) => [n.id, null]));
  const done = new Set(), failed = new Set();
  const t0 = performance.now();
  const deadline = timeoutMs > 0 ? t0 + timeoutMs : Infinity;
  const aborted = () => Boolean(signal && signal.aborted);

  /* transitivt: en dep ar "dod" om den failat ELLER sjalv markerats blocked */
  const deadDep = (n) => (n.deps || []).find((d) => failed.has(d) || (results.get(d) && results.get(d).blocked));
  const readyFor = (n) => (n.deps || []).every((d) => done.has(d));

  function markBlocked() {
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of nodes) {
        if (results.get(n.id) !== null) continue;
        const d = deadDep(n);
        if (d) {
          results.set(n.id, { ok: undefined, blocked: true, by: d, reason: `dependency ${d} failed` });
          onEvent({ type: 'worker_blocked', id: n.id, by: d });
          moved = true;
        }
      }
    }
  }

  const inFlight = new Set();
  const started = new Set(); /* started men INTE klar: aldrig en dublettkörning */

  /* WAVE 2 plumbing: rank map (computed once — a node's tail cannot change),
     stable declaration-order tie-break, launch audit trail, adaptive state. */
  const rankMap = criticalTailRanks(nodes);
  const declIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const byIdLocal = new Map(nodes.map((n) => [n.id, n]));
  const launchOrder = [];
  const adaptations = [];
  const adaptiveOn = adaptive !== false;
  const factorN = Math.max(1, Number(overrunFactor) || 2);
  const recoveryRatio = 1.25;      /* reopen only on proven within-estimate work */
  const maxAdaptN = Math.max(1, Math.min(500, Number(maxAdaptations) || 50)); /* bounded: floods end adaptive control LOUDLY */
  let frozenCap = null; // null = full capN; frozen to the width at proof-time
  let adaptationsMuted = false;

  const measuredRatio = () => {
    let est = 0, act = 0;
    for (const [id, r] of results) {
      if (r && r.ok === true && Number.isFinite(r.ms)) {
        const e = byIdLocal.get(id) && byIdLocal.get(id).estMs;
        if (Number.isFinite(e) && e > 0) { est += e; act += r.ms; }
      }
    }
    return est > 0 ? act / est : 1; // unannotated grids never adapt — legacy behavior
  };

  /* WAVE 11 (user directive): every cap change MUST clearly log WHY, the new
     cap, and HOW capped per input — the evidence, not a vibe. */
  const adaptEvidence = () => {
    const per = [];
    let estSum = 0, actSum = 0;
    for (const [id, r] of results) {
      if (r && r.ok === true && Number.isFinite(r.ms)) {
        const e = byIdLocal.get(id) && byIdLocal.get(id).estMs;
        if (Number.isFinite(e) && e > 0) {
          estSum += e; actSum += r.ms;
          per.push({ id, estMs: e, ms: r.ms, ratio: Math.round((r.ms / e) * 100) / 100 });
        }
      }
    }
    per.sort((a, b) => b.ratio - a.ratio);
    return { samples: per.length, estSumMs: Math.round(estSum), actSumMs: Math.round(actSum), worstInputs: per.slice(0, 3) };
  };

  const logAdapt = (kind, capBefore, capNext, evidence, measured) => {
    if (adaptations.length >= maxAdaptN) {
      if (!adaptationsMuted) {
        adaptationsMuted = true;
        const flood = { type: 'topology_adapt', reason: 'adaptive_flood_mute', why: `adaptation flood: ${maxAdaptN} decisions reached — adaptive control muted so silence cannot hide oscillation`, evidence };
        adaptations.push(flood); onEvent(flood);
      }
      return false;
    }
    const round = (x) => Math.round(x * 100) / 100;
    const ev = {
      type: 'topology_adapt', reason: kind,
      why: kind === 'overrun'
        ? `measured overrun ${round(measured)}x >= factor ${factorN} across ${evidence.samples} annotated input(s) (est ${evidence.estSumMs}ms vs actual ${evidence.actSumMs}ms) — concurrency contracts to the proven width`
        : `recovery: measured ratio ${round(measured)}x <= ${recoveryRatio} after contraction — reopened one lane toward cap ${capN}`,
      measuredRatio: round(measured), factor: factorN,
      capBefore, capNow: capNext,
      evidence, perInput: evidence.worstInputs,
    };
    adaptations.push(ev);
    onEvent(ev);
    return true;
  };

  const launchOne = (n) => {
    launchOrder.push(n.id);
    started.add(n.id);
    const attempt = (attempts.get(n.id) || 0) + 1;
    attempts.set(n.id, attempt);
    const job = (async () => {
      const startedAt = performance.now();
      onEvent({ type: 'worker_start', id: n.id, attempt });
      try {
        const value = await n.run({ ...n, attempt }, { signal });
        const endedAt = performance.now();
        if (aborted()) {
          results.set(n.id, { ok: undefined, blocked: true, reason: 'cancelled', ms: Math.round(endedAt - startedAt) });
          onEvent({ type: 'worker_cancel', id: n.id });
          return;
        }
        results.set(n.id, { ok: true, value, ms: Math.round(endedAt - startedAt), startedAt: Math.round(startedAt), endedAt: Math.round(endedAt) });
        done.add(n.id);
        onEvent({ type: 'worker_done', id: n.id, ok: true });
      } catch (err) {
        const endedAt = performance.now();
        const msg = String(err && err.message || err);
        /* Del 3C: bounded transient retry = safe REPLACEMENT. A fresh attempt runs
           a fresh subagent session (node.attempt) — no half-state bleeds over, and
           the error must LOOK transient before we ever re-run: permanent failures
           stay permanent, exactly once. */
        if (!aborted() && isTransientFailure(msg) && attempt < maxAttemptsN) {
          results.set(n.id, null);
          onEvent({ type: 'worker_retry', id: n.id, attempt: attempt + 1, why: msg.slice(0, 160) });
          return;
        }
        results.set(n.id, { ok: false, error: msg.slice(0, 300), ms: Math.round(endedAt - startedAt), startedAt: Math.round(startedAt), endedAt: Math.round(endedAt) });
        failed.add(n.id);
        onEvent({ type: 'worker_done', id: n.id, ok: false, error: err && err.message });
      }
    })();
    inFlight.add(job);
    job.finally(() => { inFlight.delete(job); started.delete(n.id); });
  };

  while (true) {
    markBlocked();
    if (aborted()) {
      for (const n of nodes) {
        if (results.get(n.id) === null) {
          results.set(n.id, { ok: undefined, blocked: true, reason: 'cancelled' });
          onEvent({ type: 'worker_cancel', id: n.id });
        }
      }
      break;
    }
    /* pending = INTE igang och inget svar än (started-noder räknas aldrig dubbelt) */
    const pending = nodes.filter((n) => results.get(n.id) === null && !started.has(n.id));
    if (!pending.length && inFlight.size === 0) break;

    /* ledig kapacitet rullar genast ut pa korbar ett arbete */
    const launchable = pending.filter((n) => readyFor(n));
    /* §8: longest critical tail first; ties keep declaration order. */
    launchable.sort((a, b) => (rankMap.get(b.id) - rankMap.get(a.id)) || (declIndex.get(a.id) - declIndex.get(b.id)));
    /* §5 + WAVE 11: adaptive cap control, BOTH directions, every decision
       logged with why/evidence per input.
       DOWN (contraction): proven overrun >= factorN → freeze at measured width.
       UP (recovery): after a freeze, proven within-estimate work (<= 1.25x)
       reopens ONE lane per tick, never past capN. Every change: logAdapt —
       or silence itself, if floods mute adaptation, gets logged. */
    let capNow = capN;
    if (adaptiveOn && launchable.length && !adaptationsMuted) {
      const ratio = measuredRatio();
      if (ratio >= factorN) {
        const next = Math.max(1, Math.min(frozenCap ?? inFlight.size, inFlight.size || 1, capN));
        if (frozenCap === null || next !== frozenCap) {
          const before = frozenCap ?? capN;
          frozenCap = next;
          logAdapt('overrun', before, next, adaptEvidence(), ratio);
        } else {
          frozenCap = next;
        }
      } else if (frozenCap !== null && frozenCap < capN && ratio <= recoveryRatio) {
        logAdapt('recovery', frozenCap, frozenCap + 1, adaptEvidence(), ratio);
        frozenCap += 1;
      }
      if (frozenCap !== null) capNow = Math.min(capN, frozenCap);
    }
    while (launchable.length && inFlight.size < capNow) {
      launchOne(launchable.shift());
    }
    if (inFlight.size === 0 && pending.filter((n) => readyFor(n)).length === 0) {
      const rest = nodes.filter((n) => results.get(n.id) === null && !started.has(n.id));
      if (!rest.length) break;
      /* alla rest blockerade redan ovan - garanti for terminering */
    }

    if (inFlight.size > 0) {
      const hbMs = Math.max(10, Math.min(250, deadline === Infinity ? 250 : Math.max(1, deadline - performance.now())));
      let hb;
      const hbP = new Promise((r) => { hb = setTimeout(r, hbMs); });
      if (hb.unref) hb.unref();
      await Promise.race([...inFlight, hbP]);
      clearTimeout(hb);
    }
    if (performance.now() > deadline) {
      for (const n of nodes) {
        if (results.get(n.id) === null) results.set(n.id, { ok: undefined, blocked: true, reason: 'deadline' });
      }
      break;
    }
  }
  const wallMs = Math.round(performance.now() - t0);
  return {
    results: new Map(results.entries()),
    wallMs,
    okCount: [...results.values()].filter((r) => r && r.ok === true).length,
    failCount: [...results.values()].filter((r) => r && r.ok === false).length,
    blockedCount: [...results.values()].filter((r) => r && r.blocked).length,
    launchOrder,
    adaptive: { enabled: adaptiveOn, overrunFactor: factorN, adaptations },
  };
}

/**
 * Worker-adapter ovanpå den befintliga subagenten: varje nod får ett TYPAT
 * litet kontrakt (input + id), inga konversationshistorier. Om subagenten
 * fejar kommer felet upp till runSwarm, som markerar noden ärligt.
 */
export function subagentWorker({ cfg, registry, sessionPrefix = 'swarm', emit = null, memory = null, job = 'tasks', maxSteps = 8 }) {
  return async (node) => {
    const res = await subagentRun({
      cfg,
      task: String(node.input ?? node.goal ?? node.id).slice(0, 6000),
      job,
      maxSteps,
      registry,
      session: `${sessionPrefix}:${node.id}${(node.attempt || 1) > 1 ? ':a' + node.attempt : ''}`,
      emit: (e) => emit?.({ ...e, worker: node.id, sub: true }),
      memory,
      /* Del 3C: the scheduler owns replacement. A worker must not hide a provider
         flake behind up to 4 silent inner retries — first error surfaces, the
         scheduler classifies transient vs permanent and decides bounded retry. */
      providerErrorCap: 0,
      providerRetries: 0,
    });
    if (res.error) throw new Error(String(res.error).slice(0, 300));
    return { text: res.text, steps: res.steps, tools: res.tools || [], usage: res.usage || null };
  };
}
