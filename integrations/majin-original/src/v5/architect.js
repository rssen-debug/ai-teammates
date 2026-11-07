/**
 * MAJIN V5 — GRAND ARCHITECT (Section 3).
 *
 * Thin coordinating layer over verified V1–V4 components and V5 engines:
 *   User goal
 *   -> Context & files
 *   -> Relevant skills (or synthesize missing skill via Python/Node SkillBuilder)
 *   -> Plan when needed (V2 TaskGraph + runGraph)
 *   -> Tools
 *   -> Independent verification (V2 runVerifier)
 *   -> Result
 *   -> Learning & XP (1–99)
 *
 * Hard rules enforced here:
 *  - Single source of truth (`GoalLedger`) for every task: `goal_id`, `status`,
 *    `criteria`, `owner_instructions`, `checkpoints`, `used_skills`,
 *    `tool_results`, `verification_evidence`, and `cost`.
 *  - Strict separation of statuses:
 *    `COMPLETED` (klart), `PARTIAL` (delvis klart), `FAILED` (misslyckat),
 *    `BLOCKED` (blockerat), `CANCELLED` (avbrutet), `WAITING_USER` (väntar på användaren).
 *  - `COMPLETED` REQUIRES independently verified acceptance criteria (`runVerifier`
 *    outcome receipt). Model text alone is NEVER proof!
 *  - Late responses from aborted/steered runs are fenced out by `runEpoch`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Goal } from '../v2/runtime/goal.js';
import { STATES } from '../v2/runtime/states.js';
import { TaskGraph } from '../v2/runtime/dag.js';
import { runGraph } from '../v2/runtime/scheduler.js';
import { runVerifier } from '../v2/runtime/verifiers.js';
import { MemoryStore } from '../v2/memory/store.js';
import { isVerifiedOutcomeReceipt } from './xp-engine.js';
import { SkillTree, computeEnvironmentFingerprint } from './skill-tree.js';
import { SkillBuilder } from './skill-builder.js';
import { LearningEngine } from './learning-engine.js';
import { ProviderManager } from './providers.js';
import { FileAndAccessController } from './files-access.js';
import { JobApplicationWorkflow } from './workflows/job-search.js';
import { VoiceController } from './voice-controller.js';
import { ExecutionLoopGuard, V5OpsManager, atomicWriteJson } from './ops.js';

export const TASK_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',       // klart (requires verified acceptance criteria)
  PARTIAL: 'PARTIAL',           // delvis klart
  FAILED: 'FAILED',             // misslyckat
  BLOCKED: 'BLOCKED',           // blockerat
  CANCELLED: 'CANCELLED',       // avbrutet
  WAITING_USER: 'WAITING_USER', // väntar på användaren
  RUNNING: 'RUNNING',           // arbetar
});

export const SWEDISH_STATUS_LABELS = Object.freeze({
  READING_CV: 'Läser CV', // input vocabulary, never rendered
  CHECKING_MATCHES: 'Kontrollerar matchningar', // input vocabulary, never rendered
  UPLOADING_CV: 'Laddar upp CV', // input vocabulary, never rendered
  CONFIRMING_APPLICATION: 'Bekräftar mottagen ansökan', // input vocabulary, never rendered
  BUILDING_SKILL: 'Bygger och verifierar ny skill', // input vocabulary, never rendered
  BUILDING_PAGE: 'Bygger och verifierar sida', // input vocabulary, never rendered
  FIXING_FILE: 'Öppnar och reparerar fil', // input vocabulary, never rendered
  RESUMING_GOAL: 'Återupptar arbete från checkpoint', // input vocabulary, never rendered
});

export class GrandArchitect {
  constructor({
    dataDir,
    workspaceDir = null,
    fetchImpl = globalThis.fetch,
    completeImpl = null,
    portalAdapter = null,
  } = {}) {
    if (!dataDir) throw new Error('GrandArchitect requires dataDir');
    this.dataDir = dataDir;
    this.workspaceDir = workspaceDir || path.join(dataDir, 'workspace');
    this.goalsDir = path.join(dataDir, 'goals');
    this.ledgerFile = path.join(dataDir, 'goal-ledger.json');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.goalsDir, { recursive: true, mode: 0o700 });

    this.memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
    this.skillTree = new SkillTree({ dir: dataDir });
    this.skillBuilder = new SkillBuilder({ dataDir, skillTree: this.skillTree });
    this.learning = new LearningEngine({
      dataDir,
      skillTree: this.skillTree,
      memoryStore: this.memoryStore,
    });
    this.providers = new ProviderManager({
      dataDir,
      fetchImpl,
      completeImpl,
    });
    this.files = new FileAndAccessController({
      dataDir,
      workspaceDir: this.workspaceDir,
      fetchImpl,
    });
    this.jobWorkflow = new JobApplicationWorkflow({
      dataDir,
      skillTree: this.skillTree,
      portalAdapter,
    });
    this.voice = new VoiceController();
    this.ops = new V5OpsManager({ dataDir });

    const loaded = this.#loadGoalLedger();
    this.goals = loaded.goals;
    this.activeGoalId = loaded.activeGoalId;
    this.runEpoch = 0; // Monotonic epoch fencing out late responses from aborted runs
    this.activeAbortController = null;
    this.staleResponsesDropped = 0;
    this.listeners = new Set();
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(type, payload = {}) {
    for (const fn of this.listeners) {
      try { fn({ type, ...payload, at: new Date().toISOString() }); } catch { /* ignore */ }
    }
  }

  #loadGoalLedger() {
    if (fs.existsSync(this.ledgerFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
        if (parsed?.schema === 'majin.v5.goal-ledger/v1' && parsed.goals) {
          return {
            goals: parsed.goals,
            activeGoalId: parsed.activeGoalId || null,
          };
        }
      } catch { /* fall through */ }
    }
    return { goals: {}, activeGoalId: null };
  }

  #saveGoalLedger() {
    atomicWriteJson(this.ledgerFile, {
      schema: 'majin.v5.goal-ledger/v1',
      updatedAt: new Date().toISOString(),
      activeGoalId: this.activeGoalId,
      goals: this.goals,
    });
  }

  /** Create or retrieve a canonical V5 goal record backed by a V2 Goal state machine. */
  createGoalRecord({
    goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    objective = '',
    criteria = [],
    ownerInstructions = [],
    primarySkill = null,
    supportSkills = [],
  } = {}) {
    const v2Goal = new Goal({
      id: goalId,
      objective: String(objective || 'User goal'),
      acceptance: (criteria.length ? criteria : ['outcome:verified']).map((c, idx) => ({
        id: typeof c === 'string' ? c : (c.id || `crit-${idx + 1}`),
        description: typeof c === 'string' ? c : (c.description || String(c)),
        kind: 'custom',
      })),
    });
    v2Goal.transition(STATES.PLANNING);
    v2Goal.transition(STATES.READY);
    v2Goal.save(this.goalsDir);

    const record = {
      goal_id: goalId,
      status: TASK_STATUS.RUNNING,
      objective: String(objective || ''),
      criteria: Array.isArray(criteria) && criteria.length ? [...criteria] : ['verified_outcome'],
      owner_instructions: Array.isArray(ownerInstructions) && ownerInstructions.length
        ? [...ownerInstructions]
        : [String(objective || '')],
      checkpoints: [],
      queued_steps: [],
      used_skills: {
        primary_skill: primarySkill,
        support_skills: supportSkills,
      },
      tool_results: [],
      verification_evidence: [],
      cost: {
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: null,
      },
      status_history: [],
      blocker: null,
      waiting_for: null,
      xp_award: null,
      epoch: this.runEpoch,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.goals[goalId] = record;
    this.activeGoalId = goalId;
    this.#saveGoalLedger();
    return record;
  }

  #pushStatus(goal, statusText) {
    if (!goal.firstStatusAt) {
      goal.firstStatusAt = performance.now();
    }
    goal.current_status_text = statusText;
    goal.status_history.push({ text: statusText, at: new Date().toISOString() });
    this.#emit('status', {
      goal_id: goal.goal_id,
      activity: true,
      learning: false, // Activity animation never pretends to be verified learning!
      statusText,
    });
  }

  /**
   * Execute a user goal end-to-end through the Grand Architect vertical chain:
   *   selected provider -> user goal -> file -> skill -> tool -> verification -> XP -> dot-matrix state.
   */
  async executeGoal({
    goalText = '',
    files = [],
    criteria = [],
    mandate = { allowSubmit: false },
    jobAds = null,
    synthesizeMissingSkill = null,
    actions = null,
    requireUserConfirmation = null,
    blocker = null,
    costEstimate = null,
    useDag = false,
  } = {}) {
    const startedAtPerf = performance.now();

    // Check if this is a mid-flight steering or resume command on the active goal
    const trimmed = String(goalText || '').trim();
    if (this.activeGoalId && this.goals[this.activeGoalId]) {
      if (/^(?:fortsätt(?:\s+där\s+du\s+slutade)?|continue|resume)$/i.test(trimmed)) { // input vocabulary, never rendered
        return this.resumeGoal({ goalId: this.activeGoalId, actions });
      }
      if (/^(?:nej\s+vänta|vänta|bara\s+jobb\s+i|öppna\s+de\s+(?:fyra|tre|fem)\s+bästa)/i.test(trimmed)) { // input vocabulary, never rendered
        return this.steerActiveGoal({ instruction: trimmed });
      }
    }

    // Increment runEpoch so any stale async callbacks from an earlier run are fenced out
    this.runEpoch += 1;
    const myEpoch = this.runEpoch;
    if (this.activeAbortController) {
      try { this.activeAbortController.abort(new Error('SUPERSEDED_BY_NEW_GOAL')); } catch { /* ignore */ }
    }
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    // 1. Select relevant skills from SkillTree (or synthesize a new skill via Python/Node if missing!)
    let { primarySkill, supportSkills } = this.skillTree.selectSkillsForGoal(goalText);

    const goal = this.createGoalRecord({
      objective: goalText,
      criteria: criteria.length ? criteria : ['verified_outcome'],
      ownerInstructions: [goalText],
      primarySkill: primarySkill?.canonical_id || null,
      supportSkills: supportSkills.map((s) => s.canonical_id),
    });
    goal.startedAtPerf = startedAtPerf;
    goal.epoch = myEpoch;

    // If a skill is missing and synthesis is requested or needed, synthesize and self-test it first!
    if ((!primarySkill && synthesizeMissingSkill) || synthesizeMissingSkill?.force) {
      this.#pushStatus(goal, SWEDISH_STATUS_LABELS.BUILDING_SKILL);
      const built = await this.skillBuilder.synthesizeSkill({
        name: synthesizeMissingSkill.name || 'custom-automation',
        displayName: synthesizeMissingSkill.displayName || 'Syntetiserad Skill', // input vocabulary, never rendered
        domain: synthesizeMissingSkill.domain || 'code',
        purpose: synthesizeMissingSkill.purpose || goalText,
        runtime: synthesizeMissingSkill.runtime || 'python',
        code: synthesizeMissingSkill.code || null,
        testInput: synthesizeMissingSkill.testInput,
      });

      if (!built.ok) {
        goal.status = TASK_STATUS.FAILED;
        goal.error = built.reason;
        this.#saveGoalLedger();
        return this.getGoalState(goal.goal_id);
      }
      primarySkill = built.skill;
      goal.used_skills.primary_skill = primarySkill.canonical_id;
    }

    if (!primarySkill) {
      primarySkill = this.skillTree.get('code.build-page');
      goal.used_skills.primary_skill = primarySkill.canonical_id;
    }

    // Check for explicit blocker or user confirmation requirement
    if (blocker) {
      goal.status = TASK_STATUS.BLOCKED;
      goal.blocker = blocker;
      goal.checkpoints.push({
        id: `chk-${Date.now()}`,
        at: new Date().toISOString(),
        state: 'blocked',
        blocker,
      });
      this.#saveGoalLedger();
      return this.getGoalState(goal.goal_id);
    }

    if (requireUserConfirmation) {
      goal.status = TASK_STATUS.WAITING_USER;
      goal.waiting_for = requireUserConfirmation;
      goal.checkpoints.push({
        id: `chk-${Date.now()}`,
        at: new Date().toISOString(),
        state: 'waiting_user',
        waitingFor: requireUserConfirmation,
      });
      this.#saveGoalLedger();
      return this.getGoalState(goal.goal_id);
    }

    // 2. Process attached files if any
    const readDocs = [];
    for (const f of Array.isArray(files) ? files : []) {
      this.#pushStatus(goal, SWEDISH_STATUS_LABELS.READING_CV);
      if (f.path && fs.existsSync(f.path)) {
        const doc = this.files.readAuthorizedDocument(f.path);
        readDocs.push(doc);
        goal.tool_results.push({
          tool: 'document_read',
          ok: true,
          argKeys: ['path'],
          output: { name: doc.name, bytes: doc.bytes, sha256: doc.sha256 },
        });
        goal.verification_evidence.push(doc.receipt);
        goal.checkpoints.push({
          id: `chk-file-${doc.sha256.slice(0, 8)}`,
          step: 'document_read',
          verified: true,
          receiptId: doc.receipt.receiptId,
          at: new Date().toISOString(),
        });
      } else if (f.data && f.name && f.type) {
        const saved = this.files.saveUpload(f);
        const doc = this.files.readAuthorizedDocument(saved.path);
        readDocs.push(doc);
        goal.tool_results.push({
          tool: 'document_read',
          ok: true,
          argKeys: ['path'],
          output: { name: doc.name, bytes: doc.bytes, sha256: doc.sha256 },
        });
        goal.verification_evidence.push(doc.receipt);
        goal.checkpoints.push({
          id: `chk-upload-${doc.sha256.slice(0, 8)}`,
          step: 'document_read',
          verified: true,
          receiptId: doc.receipt.receiptId,
          at: new Date().toISOString(),
        });
      }
    }

    // 3. If jobAds are provided or this is a job workflow request, run the JobApplicationWorkflow
    if (Array.isArray(jobAds)) {
      const cvText = readDocs[0]?.text || goalText;
      const cvName = readDocs[0]?.name || 'cv.pdf';
      const cvSha = readDocs[0]?.sha256 || null;
      const wfSummary = await this.jobWorkflow.run({
        cvText,
        cvFileName: cvName,
        cvSha256: cvSha,
        jobAds,
        criteria: criteria.locations ? criteria : {},
        maxTarget: criteria.maxTarget || 500,
        mandate,
        signal,
        onProgress: ({ statusText }) => {
          if (statusText) this.#pushStatus(goal, statusText);
        },
      });

      goal.tool_results.push({
        tool: 'jobs.search',
        ok: true,
        argKeys: ['query', 'criteria'],
        output: wfSummary.counters,
      });
      goal.tool_results.push({
        tool: 'jobs.match',
        ok: true,
        argKeys: ['cvFacts', 'jobAds'],
        output: { matched: wfSummary.counters.matched },
      });

      for (const rcpt of wfSummary.verifiedReceipts || []) {
        goal.verification_evidence.push(rcpt);
      }
      if (wfSummary.counters.matched > 0 && goal.verification_evidence.length === 0) {
        // Persist a verified match report artifact in the workspace
        const reportPath = path.join(this.workspaceDir, `job-matches-${goal.goal_id}.json`);
        const reportBytes = Buffer.from(JSON.stringify(wfSummary, null, 2), 'utf8');
        fs.writeFileSync(reportPath, reportBytes, { mode: 0o600 });
        const sha256 = crypto.createHash('sha256').update(reportBytes).digest('hex');
        const vRes = await runVerifier('file', { path: reportPath, minBytes: 1, hash: sha256 });
        if (vRes.verified) {
          goal.verification_evidence.push({
            id: `rcpt-jobreport-${sha256.slice(0, 12)}`,
            receiptId: `rcpt-jobreport-${sha256.slice(0, 12)}`,
            kind: 'file',
            verifier: 'file',
            verified: true,
            path: reportPath,
            sha256,
            at: new Date().toISOString(),
          });
        }
      }
      goal.workflowSummary = wfSummary;
    }

    // 4. Execute explicit tool actions or multi-step DAG if provided
    if (Array.isArray(actions) && actions.length > 0) {
      await this.#executeActionSteps(goal, actions, { myEpoch, signal, useDag });
    } else if (primarySkill?.synthesizedScript && fs.existsSync(primarySkill.synthesizedScript)) {
      // Execute the synthesized skill script if it was built for this goal
      const runtime = primarySkill.origin?.includes('python') ? 'python' : 'node';
      const execRes = await this.skillBuilder.executeSynthesizedScript({
        scriptPath: primarySkill.synthesizedScript,
        runtime,
        input: { operation: 'execute_goal', data: { goal: goalText } },
        outputDir: this.workspaceDir,
      });
      if (execRes.ok && execRes.verifiedReceipt) {
        goal.tool_results.push({
          tool: `synthesized.${runtime}`,
          ok: true,
          argKeys: ['data', 'operation'],
          output: execRes.output,
        });
        goal.verification_evidence.push(execRes.verifiedReceipt);
      }
    }

    // 5. Optional provider model call if provider is configured with a live/mock handler
    if (this.providers.state.activeModelId && (this.providers.completeImpl || this.providers.state.providers[this.providers.state.activeProvider]?.hasKey)) {
      const modelRes = await this.providers.complete({
        messages: [{ role: 'user', content: goalText }],
        sessionId: goal.goal_id,
        signal,
      });
      if (modelRes.ok) {
        const usage = modelRes.response?.usage || {};
        goal.cost.modelCalls += 1;
        goal.cost.inputTokens += Number(usage.prompt_tokens || usage.inputTokens || 0);
        goal.cost.outputTokens += Number(usage.completion_tokens || usage.outputTokens || 0);
        if (typeof usage.costUsd === 'number') {
          goal.cost.usd = Number(((goal.cost.usd || 0) + usage.costUsd).toFixed(6));
        }
        goal.model_reply = modelRes.response?.content || modelRes.response?.text || '';
      }
    }

    if (costEstimate && typeof costEstimate === 'object') {
      goal.cost = { ...goal.cost, ...costEstimate };
    }

    // Check if run was aborted or superseded while working
    if (myEpoch !== this.runEpoch || signal.aborted) {
      goal.status = TASK_STATUS.CANCELLED;
      this.#saveGoalLedger();
      return this.getGoalState(goal.goal_id);
    }

    // 6. Finalize status based STRICTLY on independent verification evidence!
    return this.#finalizeGoalOutcome(goal, { startedAtPerf });
  }

  async #executeActionSteps(goal, actions, { myEpoch, signal, useDag = false }) {
    const loopGuard = new ExecutionLoopGuard();
    goal.queued_steps = actions.map((a, idx) => ({
      stepId: a.id || `step-${idx + 1}`,
      tool: a.tool,
      status: 'QUEUED',
    }));

    const runSingleAction = async (act, idx) => {
      if (myEpoch !== this.runEpoch || signal?.aborted) {
        goal.queued_steps[idx].status = 'CANCELLED';
        return { ok: false, cancelled: true };
      }

      // Skip already checkpointed steps on resume
      const stepId = act.id || `step-${idx + 1}`;
      if (goal.checkpoints.some((c) => c.stepId === stepId && c.verified)) {
        goal.queued_steps[idx].status = 'SKIPPED_CHECKPOINTED';
        return { ok: true, skipped: true };
      }

      // Check LearningEngine scoped avoid guard
      const avoidCheck = this.learning.checkToolCallAllowed(act.tool, act.args || {});
      if (!avoidCheck.allowed) {
        goal.tool_results.push({
          stepId,
          tool: act.tool,
          args: act.args || {},
          argKeys: Object.keys(act.args || {}),
          ok: false,
          failureClass: avoidCheck.code,
          error: avoidCheck.reason,
        });
        goal.queued_steps[idx].status = 'AVOIDED';
        return { ok: false, avoided: true };
      }

      // Check LoopGuard before executing
      const guardCheck = loopGuard.checkBeforeStep({ tool: act.tool, args: act.args });
      if (!guardCheck.allowed) {
        goal.status = TASK_STATUS.FAILED;
        goal.error = guardCheck.message;
        goal.queued_steps[idx].status = 'CANCELLED_BY_GUARD';
        return { ok: false, guardStopped: true };
      }

      if (act.statusText) {
        this.#pushStatus(goal, act.statusText);
      }

      goal.queued_steps[idx].status = 'RUNNING';
      try {
        let result = null;
        let verifiedReceipt = null;

        if (act.tool === 'workspace_write' || act.tool === 'fs.write') {
          const targetFile = path.resolve(this.workspaceDir, path.basename(String(act.args?.file || act.args?.path || 'output.txt')));
          const content = String(act.args?.content ?? '');
          fs.writeFileSync(targetFile, content, { mode: 0o600 });
          const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
          const vRes = await runVerifier('file', { path: targetFile, minBytes: content.length > 0 ? 1 : 0, hash: sha256 });
          if (!vRes.verified) throw new Error(vRes.error?.message || 'File verification failed');
          verifiedReceipt = {
            id: act.receiptId || `rcpt-file-${sha256.slice(0, 12)}-${idx}`,
            receiptId: act.receiptId || `rcpt-file-${sha256.slice(0, 12)}-${idx}`,
            kind: 'file',
            verifier: 'file',
            verified: true,
            path: targetFile,
            sha256,
            bytes: Buffer.byteLength(content, 'utf8'),
            at: new Date().toISOString(),
          };
          result = { path: targetFile, sha256, bytes: verifiedReceipt.bytes };
        } else if (typeof act.execute === 'function') {
          result = await act.execute({ workspaceDir: this.workspaceDir, signal });
          if (act.verifyReceipt) {
            verifiedReceipt = act.verifyReceipt;
          } else if (result?.verifiedReceipt) {
            verifiedReceipt = result.verifiedReceipt;
          }
        } else if (act.failWith) {
          const err = new Error(act.failWith.message || 'Simulated tool failure');
          err.code = act.failWith.code || 'METHOD_ERROR';
          throw err;
        } else {
          result = act.result || { ok: true };
          if (act.verifiedReceipt) verifiedReceipt = act.verifiedReceipt;
        }

        goal.tool_results.push({
          stepId,
          tool: act.tool,
          args: act.args || {},
          argKeys: Object.keys(act.args || {}),
          ok: true,
          output: result,
        });
        goal.queued_steps[idx].status = 'COMPLETED';

        if (verifiedReceipt && isVerifiedOutcomeReceipt(verifiedReceipt)) {
          goal.verification_evidence.push(verifiedReceipt);
          goal.checkpoints.push({
            id: `chk-${stepId}`,
            stepId,
            tool: act.tool,
            verified: true,
            receiptId: verifiedReceipt.receiptId || verifiedReceipt.id,
            at: new Date().toISOString(),
          });
        }

        loopGuard.recordStepOutcome({
          tool: act.tool,
          args: act.args,
          ok: true,
          verifiedProgress: Boolean(verifiedReceipt),
        });
        this.#saveGoalLedger();
        return { ok: true, result };
      } catch (err) {
        const failureClass = err?.code || 'METHOD_ERROR';
        goal.tool_results.push({
          stepId,
          tool: act.tool,
          args: act.args || {},
          argKeys: Object.keys(act.args || {}),
          ok: false,
          failureClass,
          error: String(err?.message || err),
        });
        goal.queued_steps[idx].status = 'FAILED';

        this.learning.recordStepFailure({
          goalId: goal.goal_id,
          skillId: goal.used_skills.primary_skill,
          stepIndex: idx,
          tool: act.tool,
          args: act.args || {},
          failureClass,
          penalizeSkill: false,
        });

        loopGuard.recordStepOutcome({
          tool: act.tool,
          args: act.args,
          ok: false,
          verifiedProgress: false,
          failureClass,
        });
        this.#saveGoalLedger();
        return { ok: false, error: err };
      }
    };

    if (useDag && actions.length > 0) {
      // Execute through V2 TaskGraph + runGraph when dependencies exist
      const graph = new TaskGraph({ goalId: goal.goal_id });
      const actionById = new Map();
      actions.forEach((act, idx) => {
        const stepId = act.id || `step-${idx + 1}`;
        actionById.set(stepId, { act, idx });
        graph.addTask({
          id: stepId,
          action: act.tool || stepId,
          deps: Array.isArray(act.deps) ? act.deps : (idx > 0 ? [actions[idx - 1].id || `step-${idx}`] : []),
        });
      });
      const v2Goal = Goal.load(path.join(this.goalsDir, `${goal.goal_id}.json`));
      if (v2Goal.state === STATES.READY) {
        v2Goal.transition(STATES.RUNNING);
      }
      await runGraph({
        goal: v2Goal,
        graph,
        concurrency: 2,
        signal,
        execute: async (t) => {
          const entry = actionById.get(t.id);
          const out = await runSingleAction(entry.act, entry.idx);
          return out.ok ? { result: 'success', evidence: out.result } : { result: 'failure', error: out.error };
        },
      });
    } else {
      for (let i = 0; i < actions.length; i += 1) {
        if (myEpoch !== this.runEpoch || signal?.aborted) {
          for (let j = i; j < goal.queued_steps.length; j += 1) {
            if (goal.queued_steps[j].status === 'QUEUED') {
              goal.queued_steps[j].status = 'CANCELLED';
            }
          }
          break;
        }
        await runSingleAction(actions[i], i);
        if (goal.status === TASK_STATUS.FAILED) break;
      }
    }
  }

  async #finalizeGoalOutcome(goal, { startedAtPerf = performance.now() } = {}) {
    const validEvidence = (goal.verification_evidence || []).filter(isVerifiedOutcomeReceipt);
    const anySucceeded = (goal.tool_results || []).some((r) => r.ok === true);
    const anyFailed = (goal.tool_results || []).some((r) => r.ok === false);

    if (goal.status === TASK_STATUS.CANCELLED || goal.status === TASK_STATUS.BLOCKED || goal.status === TASK_STATUS.WAITING_USER) {
      this.#saveGoalLedger();
      return this.getGoalState(goal.goal_id);
    }

    // Hard rule (Section 3): "Klart" (COMPLETED) REQUIRES verified acceptance criteria!
    // Model prose alone is NEVER sufficient for COMPLETED.
    if (validEvidence.length > 0 && (!anyFailed || anySucceeded)) {
      goal.status = goal.workflowSummary?.status === 'PARTIAL'
        ? TASK_STATUS.PARTIAL
        : TASK_STATUS.COMPLETED;

      const envFp = computeEnvironmentFingerprint({
        grantedLanes: this.files.describeAccessState().grantedLanes,
      });

      const learnRes = await this.learning.learnFromVerifiedGoal({
        goalId: goal.goal_id,
        goalText: goal.objective,
        trace: goal.tool_results,
        receipts: validEvidence,
        primarySkillId: goal.used_skills.primary_skill,
        supportSkillIds: goal.used_skills.support_skills,
        grantedLanes: this.files.describeAccessState().grantedLanes,
        usedLanes: ['files'],
        envFingerprint: envFp,
      });

      goal.xp_award = learnRes.xpResult || null;
      if (learnRes.xpResult?.awarded) {
        this.#emit('xp_awarded', {
          goal_id: goal.goal_id,
          activity: false,
          learning: true, // Distinct verified learning event!
          primarySkill: learnRes.xpResult.primarySkill,
          grants: learnRes.xpResult.grants,
        });
      }
    } else if (anySucceeded) {
      // Tools ran or model replied, but NO independent verification receipt exists -> PARTIAL, never COMPLETED!
      goal.status = TASK_STATUS.PARTIAL;
      goal.xp_award = { awarded: false, reason: 'NO_VERIFIED_OUTCOME_RECEIPT', totalXpAwarded: 0 };
    } else {
      goal.status = TASK_STATUS.FAILED;
      goal.xp_award = { awarded: false, reason: 'GOAL_FAILED', totalXpAwarded: 0 };
      if (goal.used_skills.primary_skill && anyFailed) {
        const lastFail = goal.tool_results.findLast((r) => !r.ok);
        this.skillTree.recordFailure({
          skillId: goal.used_skills.primary_skill,
          goalId: goal.goal_id,
          stepTool: lastFail?.tool || 'unknown',
          failureClass: lastFail?.failureClass || 'GOAL_FAILED',
        });
      }
    }

    const completedAtPerf = performance.now();
    this.voice.recordTurnTiming({
      startedAt: startedAtPerf,
      firstStatusAt: goal.firstStatusAt || startedAtPerf,
      completedAt: completedAtPerf,
    });

    goal.updatedAt = new Date().toISOString();
    this.#saveGoalLedger();
    return this.getGoalState(goal.goal_id);
  }

  /**
   * Stop/Cancel active goal immediately, marking queued steps `CANCELLED`
   * and advancing `runEpoch` so late responses cannot revive old work.
   */
  cancelGoal(goalId = this.activeGoalId) {
    this.runEpoch += 1;
    if (this.activeAbortController) {
      try { this.activeAbortController.abort(new Error('USER_CANCELLED')); } catch { /* ignore */ }
      this.activeAbortController = null;
    }
    const goal = this.goals[goalId];
    if (!goal) return null;
    goal.status = TASK_STATUS.CANCELLED;
    for (const step of goal.queued_steps || []) {
      if (step.status === 'QUEUED' || step.status === 'RUNNING') {
        step.status = 'CANCELLED';
      }
    }
    goal.updatedAt = new Date().toISOString();
    this.#saveGoalLedger();
    return this.getGoalState(goalId);
  }

  /**
   * Handle a late response from an earlier epoch: fence it out so it NEVER
   * mutates the current goal or triggers obsolete actions!
   */
  receiveAsyncCallback({ epoch, goalId, callback } = {}) {
    if (epoch !== this.runEpoch) {
      this.staleResponsesDropped += 1;
      return {
        accepted: false,
        staleRunIgnored: true,
        staleResponsesDropped: this.staleResponsesDropped,
      };
    }
    const res = typeof callback === 'function' ? callback(this.goals[goalId]) : null;
    this.#saveGoalLedger();
    return {
      accepted: true,
      staleRunIgnored: false,
      result: res,
    };
  }

  /**
   * Mid-flight steering (`omstyrning`, e.g. "Nej vänta, bara jobb i Köpenhamn",
   * "Öppna de fyra bästa"):
   *  - Advances `runEpoch` to fence out obsolete in-flight steps
   *  - Cancels pending `queued_steps` from the old plan
   *  - Updates `owner_instructions` and `criteria`
   *  - Steers `jobWorkflow` if active, preserving all verified checkpoints!
   */
  async steerActiveGoal({ goalId = this.activeGoalId, instruction = '', newActions = null } = {}) {
    const goal = this.goals[goalId];
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    this.runEpoch += 1;
    const myEpoch = this.runEpoch;
    if (this.activeAbortController) {
      try { this.activeAbortController.abort(new Error('STEERED_BY_OWNER')); } catch { /* ignore */ }
    }
    this.activeAbortController = new AbortController();

    goal.epoch = myEpoch;
    goal.owner_instructions.push(String(instruction));

    // Cancel any unexecuted queued steps from the superseded plan
    let cancelledStepsCount = 0;
    for (const step of goal.queued_steps || []) {
      if (step.status === 'QUEUED' || step.status === 'RUNNING') {
        step.status = 'CANCELLED';
        cancelledStepsCount += 1;
      }
    }

    const wfSteer = await this.jobWorkflow.steerWorkflow({ instruction });
    if (wfSteer.steered) {
      goal.workflowSummary = wfSteer.summary;
      if (wfSteer.criteria?.locations?.length) {
        goal.criteria = [...new Set([...goal.criteria, `location:${wfSteer.criteria.locations.join(',')}`])];
      }
    }

    if (Array.isArray(newActions) && newActions.length > 0) {
      await this.#executeActionSteps(goal, newActions, {
        myEpoch,
        signal: this.activeAbortController.signal,
      });
      await this.#finalizeGoalOutcome(goal);
    }

    goal.updatedAt = new Date().toISOString();
    this.#saveGoalLedger();
    return {
      steered: true,
      goal_id: goal.goal_id,
      epoch: myEpoch,
      cancelledStepsCount: cancelledStepsCount + (wfSteer.cancelledQueuedItems || 0),
      workflowSteering: wfSteer,
      goal: this.getGoalState(goal.goal_id),
    };
  }

  /**
   * Resume a goal ("Fortsätt där du slutade") from its saved checkpoints
   * without repeating already verified checkpoints or external submissions!
   */
  async resumeGoal({ goalId = this.activeGoalId, actions = [] } = {}) {
    const goal = this.goals[goalId];
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    this.runEpoch += 1;
    const myEpoch = this.runEpoch;
    this.activeAbortController = new AbortController();
    goal.epoch = myEpoch;
    goal.status = TASK_STATUS.RUNNING;
    this.#pushStatus(goal, SWEDISH_STATUS_LABELS.RESUMING_GOAL);

    if (Array.isArray(actions) && actions.length > 0) {
      await this.#executeActionSteps(goal, actions, {
        myEpoch,
        signal: this.activeAbortController.signal,
      });
    }

    if (this.jobWorkflow.state.status !== 'IDLE') {
      goal.workflowSummary = await this.jobWorkflow.resumeAfterRestart({
        signal: this.activeAbortController.signal,
      });
    }

    return this.#finalizeGoalOutcome(goal);
  }

  getGoalState(goalId = this.activeGoalId) {
    if (!goalId || !this.goals[goalId]) return null;
    return JSON.parse(JSON.stringify(this.goals[goalId]));
  }

  listGoals() {
    return Object.values(this.goals);
  }
}
