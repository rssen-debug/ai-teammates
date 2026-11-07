/**
 * MAJIN — WAVE 4 (§6): speculative execution lab.
 *
 * EXPERIMENTAL. Disabled by default. A speculation is a PURE, side-effect-free
 * computation that might be needed and is silently discarded if not. The lab
 * measures what speculation actually costs and earns — wins (a speculative
 * answer beat the confirming path), losses (discarded work), wastedMs and an
 * honest savedMsEstimate — and it SELF-LIMITS: once cumulative wastedMs passes
 * the waste budget, speculation stops instead of pretending compute is free.
 *
 * Nothing in this module calls a model. It is a scheduling primitive with an
 * audit trail; production adoption is a separate, evidence-gated decision.
 */
const DEFAULTS = {
  enabled: false,        // §6: disabled by default, always
  wasteMsMax: 60_000,    // per-store lifetime waste budget; 0 = unlimited
  timeoutMs: 8_000,      // per-speculation cap (confirm path is NEVER timeboxed)
  settleGraceMs: 250,    // post-abort accounting window for losers
};

export class SpecLab {
  constructor(cfg = null, store = null) {
    this.cfg = cfg;
    /* In-process cumulative counters; a shared store (usage tracker) may be
       attached later — the lab never invents persistence it was not given. */
    this.store = store || { wasteMs: 0, runs: 0, wins: 0, losses: 0, savedMsEstimate: 0 };
  }

  get enabled() {
    const v = this.cfg?.get?.('speculation.enabled');
    return v === true || v === 'on' || v === 1;
  }

  _budget() { return Number(this.cfg?.get?.('speculation.wasteMsMax') ?? DEFAULTS.wasteMsMax); }
  _timeout() { return Number(this.cfg?.get?.('speculation.timeoutMs') ?? DEFAULTS.timeoutMs); }
  _overBudget() { const b = this._budget(); return b > 0 && this.store.wasteMs >= b; }

  stats() {
    const s = this.store;
    const b = this._budget();
    return {
      enabled: this.enabled,
      runs: s.runs,
      wins: s.wins,
      losses: s.losses,
      wastedMs: Math.round(s.wasteMs),
      savedMsEstimate: Math.round(s.savedMsEstimate),
      wasteBudgetMs: b,
      wasteRemainingMs: b > 0 ? Math.max(0, b - Math.round(s.wasteMs)) : null,
    };
  }

  /**
   * Gate-aware entry. Disabled (default) or over budget → the authority path
   * runs alone; speculation never starts. That is a measurable zero-cost
   * pass-through, not a hidden spend.
   */
  async maybeSpeculate({ speculations = [], confirm }) {
    if (!this.enabled || this._overBudget()) {
      const t0 = performance.now();
      const value = await confirm();
      return { value, from: 'confirm', gated: true, wallMs: Math.round(performance.now() - t0) };
    }
    return speculate({ speculations, confirm, timeoutMs: this._timeout(), lab: this });
  }
}

/**
 * Race N pure speculative tasks against the confirm (authoritative) path.
 * First fulfilled result wins; losers get AbortSignal. Losers that ignore the
 * signal may not hang the return: accounting waits at most settleGraceMs and
 * then records their burn as elapsed-time-at-abort, flagged pending:true.
 *
 * speculations: [{ name, run(signal) -> Promise<value> }]
 * confirm: () -> Promise<value>
 */
export async function speculate({ speculations = [], confirm, timeoutMs = DEFAULTS.timeoutMs, settleGraceMs = DEFAULTS.settleGraceMs, lab = null }) {
  if (!Array.isArray(speculations) || !speculations.length) {
    const t0 = performance.now();
    const value = await confirm();
    return { value, from: 'confirm', gated: false, wallMs: Math.round(performance.now() - t0) };
  }
  const t0 = performance.now();
  const controllers = speculations.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), Math.max(50, timeoutMs));
  if (timer.unref) timer.unref();

  /* each contestant records its own settle state so accounting never awaits
     a straggler more than the grace window. */
  const mkRec = (runner, kind, name, i) => {
    const rec = { kind, name, i, settled: false, rejected: false, value: undefined, ms: 0, start: performance.now() };
    rec.p = (async () => {
      try {
        const v = await runner(rec);
        rec.value = v;
      } catch (err) {
        rec.rejected = true;
        rec.error = String(err && err.message || err);
        throw err;
      } finally {
        rec.ms = performance.now() - rec.start;
        rec.settled = true;
      }
    })();
    return rec;
  };

  const confirmRec = mkRec(async () => confirm(), 'confirm', 'confirm', -1);
  const specRecs = speculations.map((sp, i) =>
    mkRec(async (rec) => sp.run(controllers[i].signal, rec), 'spec', sp.name || `spec${i}`, i));

  const racers = [...specRecs.map((r) => r.p), confirmRec.p];
  const allRecs = [confirmRec, ...specRecs];

  let winnerRec = null;
  try {
    await Promise.race(racers);
    winnerRec = allRecs.find((r) => r.settled && !r.rejected);
  } catch {
    /* first finisher was a REJECTION — keep racing until something fulfills */
    while (!winnerRec) {
      const pending = allRecs.filter((r) => !r.settled);
      if (!pending.length) { clearTimeout(timer); throw new Error('speculate: every lane failed'); }
      try { await Promise.race(pending.map((r) => r.p)); } catch { /* swallow, rescan */ }
      winnerRec = allRecs.find((r) => r.settled && !r.rejected) || null;
    }
  }
  clearTimeout(timer);
  const winnerMs = winnerRec.ms;

  /* the losers get the abort; the confirm path is aborted TOO when a spec won
     — no: confirm is authoritative input for savedMsEstimate timing, and the
     caller already has the winner. Aborting confirm would orphan real work,
     so confirm is never signaled: instead its COMPLETION (if it settles
     inside the grace window) refines savedMsEstimate; otherwise savings are
     reported as 0 (underestimating is honest, inventing is not). */
  controllers.forEach((c) => c.abort());
  const grace = new Promise((r) => setTimeout(r, Math.max(1, settleGraceMs)));
  if (grace.unref) grace.unref();
  await Promise.race([Promise.allSettled(racers), grace]);

  const abortAt = performance.now();
  const discarded = [];
  let wasted = 0;
  for (const r of specRecs) {
    if (r === winnerRec) continue;
    const ms = r.settled ? r.ms : abortAt - r.start;
    wasted += ms;
    discarded.push({ name: r.name, ms: Math.round(ms), rejected: r.rejected, pendingAfterAbort: !r.settled });
  }

  const from = winnerRec.kind === 'spec' ? winnerRec.name : 'confirm';
  /* measured savings: only if the confirm actually SETTLED do we know its
     real duration for comparison. Otherwise 0 — never estimate phantom time. */
  const saved = winnerRec.kind === 'spec' && confirmRec.settled && !confirmRec.rejected
    ? Math.max(0, confirmRec.ms - winnerMs)
    : 0;

  if (lab) {
    lab.store.runs += 1;
    if (winnerRec.kind === 'spec') { lab.store.wins += 1; lab.store.savedMsEstimate += saved; }
    else if (discarded.length) lab.store.losses += 1;
    lab.store.wasteMs += wasted;
  }
  return {
    value: winnerRec.value,
    from,
    winnerMs: Math.round(winnerMs),
    savedMsEstimate: Math.round(saved),
    discarded,
    wastedMs: Math.round(wasted),
    wallMs: Math.round(performance.now() - t0),
  };
}

export const SPEC_DEFAULTS = DEFAULTS;
