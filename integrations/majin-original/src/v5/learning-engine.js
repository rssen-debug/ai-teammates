/**
 * MAJIN V5 — Procedural Learning Engine (Section 10).
 *
 * Reuses and extends V4's `src/v4/learning.js` and connects directly to V5's
 * canonical `SkillTree` and `XpLedger`.
 *
 * Enforces:
 *  - Only goals with independently verified outcome receipts produce learned
 *    procedures (never model prose or chat persistence).
 *  - User-specific values (CV text, names, paths, emails, tokens, URLs) are
 *    replaced with typed parameter slots (`{{file_path}}`, `{{location}}`,
 *    `{{query}}`, `{{url}}`). Zero secrets or CV data ever enter a procedure.
 *  - Learned procedures never widen permissions (`requiredLanes` is the
 *    intersection of granted lanes and actually used lanes).
 *  - Failure attribution isolates the specific failing step and argument
 *    pattern: it NEVER blocks an entire tool just because one argument failed.
 *  - Explicit separation between procedural learning, user memory,
 *    verification history, and model training (`weightsTrained: false`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  sanitizeInstruction,
  goalKeywords,
  taskSignature,
  induceSlots,
  attributeFailure,
} from '../v4/learning.js';
import { isVerifiedOutcomeReceipt } from './xp-engine.js';

const TRANSIENT_ERROR_RE = /TIMEOUT|NETWORK_FAILURE|MODEL_RATE_LIMIT|MODEL_FAILURE|MODEL_CONTEXT_LIMIT|ECONNRESET|503/i;

export function isTransientError(failureClass = '') {
  return TRANSIENT_ERROR_RE.test(String(failureClass || ''));
}

/** Map an argument key to a clean parameter placeholder (`{{file_path}}`, etc.). */
export function parameterizeArgKey(argKey = '') {
  const key = String(argKey || '').trim();
  const lower = key.toLowerCase();
  if (/path|file|filename|cv|document/.test(lower)) return '{{file_path}}';
  if (/url|href|link|endpoint/.test(lower)) return '{{target_url}}';
  if (/query|search|keyword|term/.test(lower)) return '{{search_query}}';
  if (/city|location|region|country|ort|stad/.test(lower)) return '{{location}}'; // input vocabulary, never rendered
  if (/role|title|position|yrke/.test(lower)) return '{{role}}'; // input vocabulary, never rendered
  if (/selector|ref|element/.test(lower)) return '{{semantic_field}}';
  return `{{${key.replace(/[^a-zA-Z0-9_]/g, '_') || 'param'}}}`;
}

/** Build a parameterized, secret-free step template from a raw tool trace step. */
export function parameterizeStep(step = {}) {
  const tool = String(step.tool || step.name || '').trim();
  const argKeys = Array.isArray(step.argKeys)
    ? step.argKeys
    : (step.args && typeof step.args === 'object' ? Object.keys(step.args) : []);
  const paramMap = {};
  for (const k of argKeys) {
    paramMap[k] = parameterizeArgKey(k);
  }
  return {
    tool,
    argKeys: [...argKeys].sort(),
    parameters: paramMap,
  };
}

/** Compute a hash of tool + specific argument values so avoid-rules only block the exact bad call. */
export function callArgsFingerprint(tool, args = {}) {
  const normalized = JSON.stringify({
    tool: String(tool || ''),
    args: args && typeof args === 'object'
      ? Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))
      : args,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export class LearningEngine {
  constructor({ dataDir, skillTree, memoryStore = null }) {
    if (!dataDir) throw new Error('LearningEngine requires dataDir');
    if (!skillTree) throw new Error('LearningEngine requires skillTree');
    this.dataDir = dataDir;
    this.skillTree = skillTree;
    this.memoryStore = memoryStore;
    this.proceduresFile = path.join(dataDir, 'learned-procedures.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  #load() {
    if (fs.existsSync(this.proceduresFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.proceduresFile, 'utf8'));
        if (parsed?.schema === 'majin.v5.learning/v1') return parsed;
      } catch { /* fall through */ }
    }
    return {
      schema: 'majin.v5.learning/v1',
      updatedAt: new Date().toISOString(),
      procedures: [],
      scopedAvoidRules: [],
    };
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    const tmp = `${this.proceduresFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.proceduresFile);
  }

  /**
   * Learn a reusable parameterized procedure from a verified goal execution
   * and bind it to the canonical skill in `SkillTree`.
   */
  async learnFromVerifiedGoal({
    goalId,
    goalText = '',
    trace = [],
    receipts = [],
    primarySkillId = null,
    supportSkillIds = [],
    grantedLanes = [],
    usedLanes = [],
    difficulty = 'standard',
    autonomous = true,
    envFingerprint = null,
    externalOrigins = null,
  } = {}) {
    const validReceipts = (Array.isArray(receipts) ? receipts : []).filter(isVerifiedOutcomeReceipt);
    if (validReceipts.length === 0) {
      return {
        learned: false,
        reason: 'NO_VERIFIED_OUTCOME_RECEIPT',
      };
    }

    // A durable delivery can be retried after a crash between save and ACK.
    const prior = this.state.procedures.find(p => p.provenance?.some(entry =>
      entry.goalId === String(goalId || '') && validReceipts.some(receipt =>
        entry.receiptId === String(receipt.id || receipt.receiptId))));
    if (prior) {
      this.save(); // A previous attempt may have mutated memory before its save failed.
      return { learned: true, duplicate: true, procedureId: prior.procedureId, canonicalSkillId: prior.canonicalSkillId, xpResult: null };
    }

    const successfulSteps = (Array.isArray(trace) ? trace : []).filter((s) => s && s.ok === true);
    if (successfulSteps.length === 0) {
      return {
        learned: false,
        reason: 'NO_SUCCESSFUL_TOOL_STEPS',
      };
    }

    const failedSteps = (Array.isArray(trace) ? trace : []).filter((s) => s && s.ok === false);
    const recoveredFromFailure = failedSteps.length > 0;

    // Resolve canonical skill
    const resolvedPrimary = primarySkillId
      ? this.skillTree.get(primarySkillId)
      : this.skillTree.selectSkillsForGoal(goalText).primarySkill;

    const skill = resolvedPrimary || this.skillTree.resolveOrRegisterSkill({
      canonical_id: `learned.${successfulSteps[0].tool.replace(/[^a-z0-9]+/gi, '-')}`,
      display_name: `Procedure: ${successfulSteps.map((s) => s.tool).join(' -> ')}`,
      domain: 'code',
      required_tools: [...new Set(successfulSteps.map((s) => s.tool))],
      verification_method: validReceipts[0].kind || 'file_sha256',
    }).skill;

    // Parameterize steps — never keep raw argument values, CV text or secrets!
    const parameterizedSteps = successfulSteps.slice(0, 12).map(parameterizeStep);
    const slots = induceSlots(
      successfulSteps.map((s) => ({
        tool: s.tool || s.name,
        argKeys: s.argKeys || Object.keys(s.args || {}),
      })),
    );

    // Permission intersection: never widen access
    const grantedSet = new Set(grantedLanes);
    const requiredLanes = usedLanes.filter((l) => grantedSet.has(l));

    const sig = taskSignature({
      goalText,
      tools: successfulSteps.map((s) => s.tool || s.name),
    });

    const sanitizedSummary = sanitizeInstruction(
      `Method for ${skill.canonical_id}: ${parameterizedSteps.map((s) => `${s.tool}(${ Object.values(s.parameters).join(', ') })`).join(' -> ')}`,
    );

    // Record scoped avoid rules for any non-transient failed steps that were replaced
    for (const f of failedSteps) {
      this.recordStepFailure({
        goalId,
        skillId: skill.canonical_id,
        stepIndex: trace.indexOf(f),
        tool: f.tool || f.name,
        args: f.args || {},
        failureClass: f.failureClass || f.errorCode || f.code || 'METHOD_ERROR',
         penalizeSkill: false, // It recovered in the same run!
      });
    }

    const procedureId = `proc-${skill.canonical_id.replace(/\./g, '-')}-${sig.slice(0, 8)}`;
    const existingProc = this.state.procedures.find((p) => p.procedureId === procedureId);
    const provenanceEntry = {
      goalId: String(goalId || ''),
      receiptId: String(validReceipts[0].id || validReceipts[0].receiptId),
      verifier: String(validReceipts[0].kind || validReceipts[0].verifier || 'file'),
      sha256: validReceipts[0].sha256 || null,
      at: new Date().toISOString(),
    };

    if (existingProc) {
      existingProc.verifiedUses += 1;
      existingProc.lastVerifiedAt = provenanceEntry.at;
      existingProc.provenance.push(provenanceEntry);
      existingProc.keywords = [...new Set([...existingProc.keywords, ...goalKeywords(goalText)])];
    } else {
      const newProc = {
        procedureId,
        canonicalSkillId: skill.canonical_id,
        summary: sanitizedSummary.text,
        steps: parameterizedSteps,
        slots,
        requiredLanes,
        keywords: goalKeywords(goalText),
        taskSignature: sig,
        verifiedUses: 1,
        createdAt: provenanceEntry.at,
        lastVerifiedAt: provenanceEntry.at,
        provenance: [provenanceEntry],
      };
      this.state.procedures.push(newProc);
      skill.learnedProcedures.push({
        procedureId,
        summary: sanitizedSummary.text,
        steps: parameterizedSteps,
        slots,
      });
    }

    // Award XP via SkillTree & XpLedger
    const xpResult = await this.skillTree.recordVerifiedSuccess({
      goalId,
      receipts: validReceipts,
      taskSignature: sig,
      difficulty,
      autonomous,
      primarySkillId: skill.canonical_id,
      supportSkillIds,
      scenarioId: sig,
      recoveredFromFailure,
      envFingerprint,
      externalOrigins,
    });

    this.save();
    return {
      learned: true,
      procedureId,
      canonicalSkillId: skill.canonical_id,
      parameterizedSteps,
      slots,
      requiredLanes,
      xpResult,
    };
  }

  /**
   * Attribute and record a step failure.
   *
   * - Distinguishes transient errors (`TIMEOUT`, `NETWORK_FAILURE`) from method errors.
   * - Records a scoped avoid rule for the failing step + argument fingerprint.
   * - NEVER blocks the entire tool when only an argument was wrong!
   */
  recordStepFailure({
    goalId = '',
    skillId = null,
    stepIndex = 0,
    tool = '',
    args = {},
    failureClass = 'METHOD_ERROR',
    penalizeSkill = true,
  } = {}) {
    const transient = isTransientError(failureClass);
    const attribution = attributeFailure([
      { tool, ok: false, cls: failureClass, argKeys: Object.keys(args || {}) },
    ]);

    if (transient) {
      return {
        transient: true,
        toolBlocked: false,
        scopedAvoidRecorded: false,
        attribution,
        advice: 'Transient network/rate-limit error: retry with backoff allowed; method not penalized.',
      };
    }

    const argsFp = callArgsFingerprint(tool, args);
    const argKeys = Object.keys(args || {}).sort();
    const existingRule = this.state.scopedAvoidRules.find(
      (r) => r.tool === tool && r.argsFingerprint === argsFp,
    );

    if (existingRule) {
      existingRule.failures += 1;
      existingRule.lastFailedAt = new Date().toISOString();
    } else {
      this.state.scopedAvoidRules.push({
        ruleId: `avoid-${tool}-${argsFp.slice(0, 8)}`,
        skillId: skillId || null,
        stepIndex,
        tool,
        argKeys,
        argsFingerprint: argsFp,
        failureClass,
        entireToolBlocked: false, // Crucial invariant: never block the whole tool for a bad argument!
        failures: 1,
        revisionStrategy: `Change arguments (${argKeys.join(', ') || 'input'}) or inspect state before calling ${tool} again.`,
        createdAt: new Date().toISOString(),
        lastFailedAt: new Date().toISOString(),
      });
    }

    if (penalizeSkill && skillId) {
      this.skillTree.recordFailure({
        skillId,
        goalId,
        stepTool: tool,
        failureClass,
        transient: false,
      });
    }

    this.save();
    return {
      transient: false,
      toolBlocked: false,
      scopedAvoidRecorded: true,
      argsFingerprint: argsFp,
      attribution,
      revisionStrategy: `Revise step ${stepIndex} (${tool}): do not repeat identical failing arguments; adjust parameters (${argKeys.join(', ')}).`,
    };
  }

  /**
   * Check whether a proposed tool call matches a known failed strategy.
   * Blocks ONLY when the exact tool + argument fingerprint failed with a
   * non-transient error; allows the same tool with corrected arguments!
   */
  checkToolCallAllowed(tool, args = {}) {
    const fp = callArgsFingerprint(tool, args);
    const hit = this.state.scopedAvoidRules.find(
      (r) => r.tool === tool && r.argsFingerprint === fp,
    );
    if (!hit) {
      return { allowed: true, toolBlocked: false };
    }
    return {
      allowed: false,
      toolBlocked: false,
      code: 'LEARNED_SCOPED_AVOID',
      reason: `Exact call to ${tool} with these arguments previously failed (${hit.failureClass}). ${hit.revisionStrategy}`,
      rule: hit,
    };
  }

  /** Retrieve the best learned procedure for a new/varied task and bind new argument values into its slots. */
  findProcedureForTask(goalText = '', boundParams = {}) {
    const queryWords = new Set(goalKeywords(goalText));
    const selected = this.skillTree.selectSkillsForGoal(goalText);
    const targetSkillId = selected.primarySkill?.canonical_id || null;

    const scored = [];
    for (const proc of this.state.procedures) {
      const skill = this.skillTree.get(proc.canonicalSkillId);
      if (skill?.maturity_status === 'FAILED') continue;

      let score = 0;
      if (targetSkillId && proc.canonicalSkillId === targetSkillId) score += 4;
      for (const kw of proc.keywords || []) {
        if (queryWords.has(kw)) score += 1.5;
      }
      if (score > 0) scored.push({ proc, skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;

    const best = scored[0];
    const instantiatedSteps = best.proc.steps.map((step) => {
      const boundArgs = {};
      for (const [argKey, placeholder] of Object.entries(step.parameters || {})) {
        const cleanSlot = placeholder.replace(/^\{\{|\}\}$/g, '');
        boundArgs[argKey] = boundParams[argKey] ?? boundParams[cleanSlot] ?? placeholder;
      }
      return {
        tool: step.tool,
        boundArgs,
        templateParameters: step.parameters,
      };
    });

    return {
      procedureId: best.proc.procedureId,
      canonicalSkillId: best.proc.canonicalSkillId,
      skillMaturity: best.skill?.maturity_status || 'TRAINING',
      skillFreshness: best.skill?.freshness || 'FRESH',
      summary: best.proc.summary,
      instantiatedSteps,
      avoidRules: this.state.scopedAvoidRules.filter((r) => r.skillId === best.proc.canonicalSkillId),
    };
  }

  /**
   * Explicitly separated knowledge layers (Section 10):
   *  1. proceduralLearning
   *  2. userMemory
   *  3. verificationHistory
   *  4. modelTraining (always weightsTrained: false)
   */
  describeKnowledgeSeparation() {
    const skills = this.skillTree.list();
    const verificationHistory = skills.flatMap((s) =>
      (s.verification_history || []).map((h) => ({ ...h, skillId: s.canonical_id })),
    );
    const userMemories = this.memoryStore?.list ? this.memoryStore.list() : [];

    return {
      proceduralLearning: {
        kind: 'procedural_learning',
        description: 'Parameterized, secret-free tool procedures and scoped avoid rules linked to canonical skills.',
        proceduresCount: this.state.procedures.length,
        procedures: this.state.procedures,
        scopedAvoidRules: this.state.scopedAvoidRules,
      },
      userMemory: {
        kind: 'user_memory',
        description: 'Owner facts and preferences stored in V2 MemoryStore; treated as data, never instructions.',
        entriesCount: userMemories.length,
      },
      verificationHistory: {
        kind: 'verification_history',
        description: 'Immutable ledger of independently verified receipts and XP grants.',
        receiptsCount: verificationHistory.length,
        recentReceipts: verificationHistory.slice(-20),
      },
      modelTraining: {
        kind: 'model_training',
        weightsTrained: false,
        fineTuningActive: false,
        statement: 'Model weights are NEVER trained or modified when Majin learns reusable procedures.',
      },
    };
  }
}
