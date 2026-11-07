/**
 * MAJIN — räkning. Varje anrop skrivs till en månadsfil; budget och UI-läsning
 * läser samma fil. Inget DB, ingen server: JSON on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';

const FILE = path.join(dirs.root, 'usage.json');

function month() {
  return new Date().toISOString().slice(0, 7);
}

export class Usage {
  constructor(cfg) {
    this.cfg = cfg;
    this.data = load();
  }

  record({ job, ref, usage, ms, moa = false, escalated = false, unpriced = false }) {
    const m = month();
    this.data[m] ||= { requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byJob: {}, byModel: {}, days: {} };
    const e = this.data[m];
    e.requests += 1;
    e.tokensIn += usage?.input || 0;
    e.tokensOut += usage?.output || 0;
    e.costUsd = round(e.costUsd + (usage?.costUsd || 0));
    e.byJob[job || '?'] = round((e.byJob[job || '?'] || 0) + (usage?.costUsd || 0));
    e.byModel[ref || '?'] = round((e.byModel[ref || '?'] || 0) + (usage?.costUsd || 0)) ;
    const d = new Date().toISOString().slice(8, 10);
    e.days[d] = round((e.days[d] || 0) + (usage?.costUsd || 0));
    e.lastMs = ms || 0;
    if (moa) {
      e.moaRequests = (e.moaRequests || 0) + 1;
      e.moaCost = round((e.moaCost || 0) + (usage?.costUsd || 0));
    }
    if (escalated) e.escalations = (e.escalations || 0) + 1;
    if (unpriced) {
      e.unpricedCount = (e.unpricedCount || 0) + 1;
      e.unpricedRefs = [...new Set([...(e.unpricedRefs || []), ref || '?'])];
    }
    save(this.data);
    return e;
  }

  reset() {
    this.data[month()] = { requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byJob: {}, byModel: {}, days: {} };
    save(this.data);
    return true;
  }

  thisMonth() {
    return this.data[month()] || { requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byJob: {}, byModel: {}, days: {} };
  }

  summary() {
    const e = this.thisMonth();
    const budget = this.cfg?.get('budget') || {};
    const used = e.costUsd || 0;
    const cap = Number(budget.monthlyUsd) || 0;
    return {
      month: month(),
      requests: e.requests,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      tokens: e.tokensIn + e.tokensOut,
      costUsd: round(used),
      budgetUsd: cap,
      budgetUsed: cap ? round((used / cap) * 100) : null,
      byJob: e.byJob,
      byModel: e.byModel,
      days: e.days,
      /* honesty chip: requests whose price we never knew. NOT part of costUsd —
         the number is a floor, and this says how much of the month hides
         behind \"unknown\". */
      unpricedCount: e.unpricedCount || 0,
      unpricedRefs: e.unpricedRefs || [],
    };
  }

  overBudget() {
    const cap = Number(this.cfg?.get('budget.monthlyUsd')) || 0;
    if (!cap) return false;
    return (this.thisMonth().costUsd || 0) >= cap;
  }

  shouldThrottle() {
    const cap = Number(this.cfg?.get('budget.monthlyUsd')) || 0;
    if (!cap || this.cfg?.get('budget.mode') === 'track') return false;
    return (this.thisMonth().costUsd || 0) >= cap * (Number(this.cfg?.get('budget.warnAt')) || 0.8);
  }
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let pending = null;
function save(data) {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    try {
      fs.mkdirSync(dirs.root, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
    } catch {
      /* ok */
    }
  }, 1500);
  pending.unref?.();
}

const round = (n) => Math.round(n * 1e6) / 1e6;
