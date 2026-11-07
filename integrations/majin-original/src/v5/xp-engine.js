/**
 * MAJIN V5 — RuneScape-inspired XP & Level 1–99 Progression Engine.
 *
 * Schema: majin.v5.xp-curve/v1
 *
 * Hard invariants enforced here:
 *  1. Every skill starts untrained at Level 1 (0 XP). Existing code never
 *     grants a higher level automatically.
 *  2. XP is awarded ONLY for independently verified outcome receipts (file,
 *     http, dom, pixel, script_artifact). Model claims, chat persistence,
 *     elapsed time, model call counts, or writing a skill file grant 0 XP.
 *  3. Each unique verified receipt (receiptId) can grant XP at most once,
 *     enforced across parallel calls and restarts via an append-only JSONL
 *     ledger and atomic state snapshots.
 *  4. Identical task signatures face steep diminishing returns (1.0 -> 0.5 ->
 *     0.25 -> 0.0) so trivial repetition farming yields 0 XP.
 *  5. Each task has a bounded XP budget (MAX_TASK_XP_BUDGET = 60) distributed
 *     between a primary skill (75% when support skills exist, 100% otherwise)
 *     and optional support skills (25% shared), preventing XP inflation from
 *     many substeps.
 *  6. Level 99 requires BOTH sufficient XP AND 5 documented quality gates
 *     (versioned test suite, >=5 varied scenarios, >=2 verified failure
 *     recoveries, fresh compatibility with reliability >=0.90, and explicit
 *     mastery scope boundaries). Without all 5 gates, level caps at 98.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const XP_CURVE_SCHEMA = 'majin.v5.xp-curve/v1';
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 99;
export const BASE_TASK_XP = 24;
export const MAX_TASK_XP_BUDGET = 60;

export const LEVEL_99_REQUIREMENTS = Object.freeze({
  minDistinctScenarios: 5,
  minVerifiedRecoveries: 2,
  minReliability: 0.90,
  requiredFreshness: 'FRESH',
});

/** Receipts that only prove chat/text persistence never count as outcome proof. */
const NON_OUTCOME_KINDS = new Set([
  'persistence',
  'chat.reply',
  'chat.persistence',
  'model.claim',
  'skill.file.write',
  'unverified',
]);

/** Build the deterministic 1..99 XP table for majin.v5.xp-curve/v1. */
function buildXpTable() {
  const table = new Array(MAX_LEVEL + 1).fill(0);
  table[1] = 0;
  let acc = 0;
  for (let lvl = 1; lvl < MAX_LEVEL; lvl += 1) {
    const delta = Math.floor(10 + 1.8 * Math.pow(lvl, 1.55) + 12 * Math.pow(2, lvl / 14));
    acc += delta;
    table[lvl + 1] = acc;
  }
  return Object.freeze(table);
}

export const XP_TABLE = buildXpTable();

/** Classic RuneScape reference curve (for documentation/comparison). */
export function classicRuneScapeXpForLevel(level) {
  const target = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.floor(Number(level) || 1)));
  let points = 0;
  for (let lvl = 1; lvl < target; lvl += 1) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
  }
  return Math.floor(points / 4);
}

/** Required cumulative XP for a given level (1..99). */
export function xpForLevel(level) {
  const target = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.floor(Number(level) || 1)));
  return XP_TABLE[target];
}

/** Uncapped level (1..99) derived purely from cumulative XP. */
export function rawLevelForXp(xp) {
  const val = Math.max(0, Math.floor(Number(xp) || 0));
  let low = MIN_LEVEL;
  let high = MAX_LEVEL;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (XP_TABLE[mid] <= val) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Evaluate the 5 mandatory Level 99 mastery gates.
 *
 * "100 %" means 100 % of defined requirements for this skill version are met;
 * never a guarantee that the agent will pass all future tasks.
 */
export function evaluateLevel99Gates(skill = {}) {
  const version = String(skill.version || '1.0.0');
  const gates = {
    versionedTestSuite: Boolean(
      skill.qualityGates?.versionedTestSuitePassed === true
      && skill.qualityGates?.testSuiteVersion === version,
    ),
    variedTasks: (Number(skill.distinctScenariosCount) || 0) >= LEVEL_99_REQUIREMENTS.minDistinctScenarios,
    errorRecovery: (Number(skill.verifiedRecoveryCount) || 0) >= LEVEL_99_REQUIREMENTS.minVerifiedRecoveries,
    freshEvidence: skill.freshness === LEVEL_99_REQUIREMENTS.requiredFreshness
      && (Number(skill.reliability) || 0) >= LEVEL_99_REQUIREMENTS.minReliability
      && Boolean(skill.lastVerifiedAt),
    definedScope: Boolean(
      skill.masteryScope
      && typeof skill.masteryScope.mastered === 'string'
      && skill.masteryScope.mastered.trim().length > 0
      && typeof skill.masteryScope.limitations === 'string'
      && skill.masteryScope.limitations.trim().length > 0,
    ),
  };
  const missing = Object.entries(gates)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    passed: missing.length === 0,
    gates,
    missing,
    versionDisclaimer: '100% indicates fulfilled requirements for this skill version only, never a guarantee for all future tasks.',
  };
}

/**
 * Effective level (1..99) accounting for the Level 99 quality gates.
 * A skill with >=73,599 XP remains at Level 98 until all 5 gates pass.
 */
export function effectiveLevelForSkill(skill = {}) {
  const raw = rawLevelForXp(skill.xp || 0);
  if (raw < MAX_LEVEL) {
    return { level: raw, rawLevel: raw, gatedAt98: false, missingGates: [] };
  }
  const eval99 = evaluateLevel99Gates(skill);
  if (eval99.passed) {
    return { level: MAX_LEVEL, rawLevel: raw, gatedAt98: false, missingGates: [] };
  }
  return {
    level: MAX_LEVEL - 1,
    rawLevel: raw,
    gatedAt98: true,
    missingGates: eval99.missing,
  };
}

/** Validate that a receipt represents an independently verified outcome. */
export function isVerifiedOutcomeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.verified !== true) return false;
  const kind = String(receipt.kind || receipt.verifier || '').toLowerCase().trim();
  if (!kind || NON_OUTCOME_KINDS.has(kind)) return false;
  const id = String(receipt.id || receipt.receiptId || '').trim();
  if (!id) return false;
  return true;
}

/** Diminishing returns multiplier for repeated identical task signatures. */
export function variationMultiplier(priorCount = 0) {
  const count = Math.max(0, Math.floor(Number(priorCount) || 0));
  if (count === 0) return 1.0;
  if (count === 1) return 0.5;
  if (count === 2) return 0.25;
  return 0.0; // Farming guard: 4th+ identical trivial/repeated task gives 0 XP
}

const DIFFICULTY_MULTIPLIERS = Object.freeze({
  trivial: 0.5,
  standard: 1.0,
  complex: 1.5,
  advanced: 2.0,
});

/**
 * Compute the bounded XP budget for a task and split across primary & support skills.
 *
 * Notice what is ignored on purpose: `modelCalls`, `elapsedMs`, `skillFileWritten`.
 */
export function computeTaskXpAllocation({
  receipts = [],
  difficulty = 'standard',
  autonomous = true,
  priorSignatureCount = 0,
  primarySkillId,
  supportSkillIds = [],
} = {}) {
  const validReceipts = (Array.isArray(receipts) ? receipts : []).filter(isVerifiedOutcomeReceipt);
  if (validReceipts.length === 0 || !primarySkillId) {
    return {
      eligible: false,
      reason: validReceipts.length === 0 ? 'NO_VERIFIED_OUTCOME_RECEIPT' : 'NO_PRIMARY_SKILL',
      totalBudget: 0,
      primaryXp: 0,
      supportXpBySkill: {},
      validReceipts: [],
    };
  }

  const varMult = variationMultiplier(priorSignatureCount);
  if (varMult === 0) {
    return {
      eligible: false,
      reason: 'REPETITION_FARMING_GUARD',
      totalBudget: 0,
      primaryXp: 0,
      supportXpBySkill: {},
      validReceipts,
    };
  }

  const diffMult = typeof difficulty === 'number'
    ? Math.max(0.25, Math.min(2.5, difficulty))
    : (DIFFICULTY_MULTIPLIERS[difficulty] ?? 1.0);
  const autoMult = autonomous === false ? 0.75 : 1.0;

  const rawBudget = Math.round(BASE_TASK_XP * diffMult * autoMult * varMult);
  const totalBudget = Math.max(1, Math.min(MAX_TASK_XP_BUDGET, rawBudget));

  const uniqueSupport = [...new Set(
    (Array.isArray(supportSkillIds) ? supportSkillIds : [])
      .map((s) => String(s || '').trim())
      .filter((s) => s && s !== primarySkillId),
  )];

  if (uniqueSupport.length === 0) {
    return {
      eligible: true,
      reason: 'VERIFIED_OUTCOME',
      totalBudget,
      primaryXp: totalBudget,
      supportXpBySkill: {},
      validReceipts,
    };
  }

  const primaryXp = Math.max(1, Math.round(totalBudget * 0.75));
  const remaining = Math.max(0, totalBudget - primaryXp);
  const perSupport = Math.max(1, Math.floor(remaining / uniqueSupport.length));
  const supportXpBySkill = {};
  let allocatedSupport = 0;
  for (const sid of uniqueSupport) {
    const grant = Math.min(perSupport, Math.max(0, totalBudget - primaryXp - allocatedSupport));
    if (grant > 0) {
      supportXpBySkill[sid] = grant;
      allocatedSupport += grant;
    }
  }

  return {
    eligible: true,
    reason: 'VERIFIED_OUTCOME',
    totalBudget: primaryXp + allocatedSupport,
    primaryXp,
    supportXpBySkill,
    validReceipts,
  };
}

/**
 * Concurrency-safe, crash-safe XP Ledger.
 *
 * Uses an in-process promise queue AND an atomic lockfile (`xp.lock`) +
 * append-only `xp-ledger.jsonl` so neither `Promise.all` nor process crashes
 * can double-award a receipt or lose XP.
 */
export class XpLedger {
  constructor({ dir }) {
    if (!dir) throw new Error('XpLedger requires a directory');
    this.dir = dir;
    this.ledgerFile = path.join(dir, 'xp-ledger.jsonl');
    this.lockFile = path.join(dir, 'xp.lock');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#queue = Promise.resolve();
  }

  #queue;

  /** Serialize operations in-process and across processes via atomic lockfile. */
  async #withLock(fn) {
    const run = async () => {
      await this.#acquireFileLock();
      try {
        return await fn();
      } finally {
        this.#releaseFileLock();
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #acquireFileLock(timeoutMs = 5000) {
    const start = Date.now();
    while (true) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`);
        fs.closeSync(fd);
        return;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(this.lockFile);
          if (Date.now() - stat.mtimeMs > 15_000) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch { /* lock disappeared */ }
        if (Date.now() - start > timeoutMs) {
          throw new Error('Timed out acquiring XP ledger lock');
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  }

  #releaseFileLock() {
    try {
      if (fs.existsSync(this.lockFile)) fs.unlinkSync(this.lockFile);
    } catch { /* ignore */ }
  }

  /** Read all valid entries from the append-only JSONL ledger (ignoring any torn tail line). */
  readEntries() {
    if (!fs.existsSync(this.ledgerFile)) return [];
    const raw = fs.readFileSync(this.ledgerFile, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.eventId === 'string' && typeof parsed.receiptId === 'string') {
          out.push(parsed);
        }
      } catch {
        // Ignore corrupt/torn tail line after simulated power loss
      }
    }
    return out;
  }

  /** Count how many times a taskSignature has already been awarded XP. */
  signatureCount(taskSignature) {
    if (!taskSignature) return 0;
    const seenGoals = new Set();
    for (const entry of this.readEntries()) {
      if (entry.taskSignature === taskSignature) {
        seenGoals.add(entry.goalId || entry.receiptId);
      }
    }
    return seenGoals.size;
  }

  /**
   * Record a verified XP award atomically.
   *
   * Returns `{ awarded: boolean, reason, grants: [{skillId, xp, receiptId, eventId}], totalXpAwarded }`.
   */
  async recordVerifiedAward({
    goalId,
    receipts = [],
    taskSignature = '',
    difficulty = 'standard',
    autonomous = true,
    primarySkillId,
    supportSkillIds = [],
    scenarioId = '',
    recoveredFromFailure = false,
    origin = 'verified-execution',
    now = new Date().toISOString(),
  } = {}) {
    return this.#withLock(async () => {
      const validReceipts = (Array.isArray(receipts) ? receipts : []).filter(isVerifiedOutcomeReceipt);
      if (validReceipts.length === 0) {
        return { awarded: false, reason: 'NO_VERIFIED_OUTCOME_RECEIPT', grants: [], totalXpAwarded: 0 };
      }
      const existing = this.readEntries();
      const awardedReceiptIds = new Set(existing.map((e) => e.receiptId));

      // Filter out any receipt that has already granted XP
      const freshReceipts = validReceipts.filter((r) => !awardedReceiptIds.has(String(r.id || r.receiptId)));
      if (freshReceipts.length === 0) {
        return { awarded: false, reason: 'DUPLICATE_RECEIPT', grants: [], totalXpAwarded: 0 };
      }

      const canonicalReceipt = freshReceipts[0];
      const receiptId = String(canonicalReceipt.id || canonicalReceipt.receiptId);

      // Count prior awards for this taskSignature
      const priorSigGoals = new Set(
        existing
          .filter((e) => taskSignature && e.taskSignature === taskSignature)
          .map((e) => e.goalId || e.receiptId),
      );

      const allocation = computeTaskXpAllocation({
        receipts: freshReceipts,
        difficulty,
        autonomous,
        priorSignatureCount: priorSigGoals.size,
        primarySkillId,
        supportSkillIds,
      });

      if (!allocation.eligible) {
        return { awarded: false, reason: allocation.reason, grants: [], totalXpAwarded: 0 };
      }

      const grants = [];
      const primaryEventId = crypto
        .createHash('sha256')
        .update(`${receiptId}:${primarySkillId}`)
        .digest('hex')
        .slice(0, 24);

      grants.push({
        eventId: primaryEventId,
        receiptId,
        goalId: String(goalId || ''),
        skillId: primarySkillId,
        role: 'primary',
        xp: allocation.primaryXp,
        taskSignature: String(taskSignature || ''),
        scenarioId: String(scenarioId || taskSignature || goalId || receiptId),
        recoveredFromFailure: Boolean(recoveredFromFailure),
        verifierKind: String(canonicalReceipt.kind || canonicalReceipt.verifier || 'outcome'),
        origin,
        at: now,
      });

      for (const [supportId, xp] of Object.entries(allocation.supportXpBySkill)) {
        if (xp <= 0) continue;
        const eventId = crypto
          .createHash('sha256')
          .update(`${receiptId}:${supportId}`)
          .digest('hex')
          .slice(0, 24);
        grants.push({
          eventId,
          receiptId,
          goalId: String(goalId || ''),
          skillId: supportId,
          role: 'support',
          xp,
          taskSignature: String(taskSignature || ''),
          scenarioId: String(scenarioId || taskSignature || goalId || receiptId),
          recoveredFromFailure: Boolean(recoveredFromFailure),
          verifierKind: String(canonicalReceipt.kind || canonicalReceipt.verifier || 'outcome'),
          origin,
          at: now,
        });
      }

      const lines = `${grants.map((g) => JSON.stringify(g)).join('\n')}\n`;
      const fd = fs.openSync(this.ledgerFile, 'a', 0o600);
      try {
        fs.writeFileSync(fd, lines, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      return {
        awarded: true,
        reason: 'VERIFIED_OUTCOME',
        grants,
        totalXpAwarded: grants.reduce((sum, g) => sum + g.xp, 0),
      };
    });
  }
}
