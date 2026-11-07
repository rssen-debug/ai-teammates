import { withTimeout, withAbortDeadline, RepeatDetector, TurnClock } from './watchdog.js';
import { startToolHeartbeat } from './tool-heartbeat.js';
import { RecoveryBudget } from './strategy-recovery.js';
import { diagnoseToolFailure } from './tool-failure-diagnosis.js';
/**
 * MAJIN — verktygsslingan.
 * Samma loop för huvudagenten och subagenter. Stegvisa beslut:
 *   kör → om fel ≥2: eskalera till tyngre modell → komprimera kontext → upprepa.
 * Inget tröskel-jagar: modellen får alla verktyg, alltid.
 */
import { complete, explainError } from './provider/chat.js';
import { routeFor } from './router.js';
import { compact, estimateTokens } from './context.js';
import { bus } from './log.js';
import { isFreeRoute, priceKnownForRoute } from './pricing.js';
import { guardToolContent } from './injection.js';
import { suggestBrowserRecovery } from './browser-recovery-policy.js';
import { inspectRequestedArtifact, pinSingleFileWrite, feedbackForJavaScriptWrite, feedbackForExactContentWrite, verifySingleFileDeletion, pinSingleExactTextWrite, verifySingleExactTextCreation, repairSimpleCommanderCliWrite, repairSimpleMixedEsmCliWrite, repairSimpleCommonJsEchoCliWrite, repairRecordedQwenEscapedCommonJsCliWrite, repairLiteralEscapedNewlineEchoCliWrite, repairSimpleFileWritingEchoCliWrite, unchangedInvalidJavaScriptWrite, verifyLocalTokenDemoFiles, isLocalTokenDemoGoal } from './goal-artifact.js';
import { verifyJobIdLineage, pinJobShortlistWrite } from './mission-data-evidence.js';
import { verifyFollowupJobSelection } from './mission-data-evidence.js';
import { verifyIsolatedNodeCli } from './cli-proof.js';

/*
 * Väljer vilka scheman modellen får se detta steg. Standard: hela den synliga
 * ytan (oförändrat beteende). Slår agent.toolSubset på blir det deterministiskt
 * urval per turn (se agent.toolSelection) — urvalet och storleken raporteras
 * ärligt i steg-händelsen så inget spar visas utan mätning.
 */
function pickSchemas(registry, ctx) {
  const all = registry.schemas({ readOnly: Boolean(ctx?.readOnly) });
  const names = ctx?.toolSubsetNames;
  if (!Array.isArray(names) || !names.length) return all;
  const wanted = new Set(names.filter((n) => registry.has(n)));
  return all.filter((t) => wanted.has(t.name));
}

/**
 * Promote real, allowlisted tool schemas after tools.search.
 * Previously tools.search listed fs.write/browser.shot but the next model call
 * still received only the original tiny subset, so weak models guessed and
 * failed with unknown_tool. Never bypass tools.allow or readOnly.
 */
export function expandDiscoveredTools(current, toolResult, registry, { readOnly = false, cap = 32 } = {}) {
  if (!Array.isArray(current) || !current.includes('tools.search') || toolResult?.ok === false) return current;
  let body;
  try { body = typeof toolResult?.result === 'string' ? JSON.parse(toolResult.result) : toolResult?.result; }
  catch { return current; }
  if (!Array.isArray(body?.matches)) return current;
  const visible = new Set(registry.schemas({ readOnly: Boolean(readOnly) }).map((tool) => tool.name));
  const names = new Set(current.filter((name) => visible.has(name)));
  for (const hit of body.matches) {
    if (names.size >= cap) break;
    if (typeof hit?.name === 'string' && visible.has(hit.name)) names.add(hit.name);
  }
  return [...names];
}

/**
 * Only explicit execution requests count: not questions asking how to do it.
 * Small LLMs sometimes say "done" without even trying a tool. Such answers
 * get one bounded recovery opportunity and an honest incomplete verdict.
 */
export function requiresRealAction(input) {
  const t = String(input || '').trim();
  if (!t || /^(?:hur|how|why|varför|what|vad|explain|förklara|tell me|berätta|visa hur|can you explain)\b/i.test(t)) return false;
  const request = /^(?:(?:please|actually|faktiskt|snälla|kan du|could you|jag vill att du|i want you to|du ska)\s+)*(?:create|write|save|edit|modify|delete|remove|build|make|download|open|take|search|apply|skapa|skriv|spara|redigera|ändra|radera|ta bort|bygg|öppna|ladda ner|sök|ansök|ta en)\b/i;
  const artifact = /(?:\b[\w.-]+\.(?:txt|md|json|js|mjs|jsx|ts|tsx|html|css|py|csv|png|jpg|pdf|docx|sol)\b|\bfile\b|\bfil(?:en|er)?\b|\bwebb(?:sida|plats)\b|\bwebsite\b|\bbrowser\b|\bwebbläsare\b|\bscreenshot\b|\bskärmbild\b|\bjobs?\b|\bjobb\b|\bagent\b)/i;
  // Real-world prompts also start with "Actually use fs.write to create..." or
  // "Gör ...", not always a bare English verb. Avoid silently disabling the
  // output contract on those explicit execution requests.
  const directToolRequest = /^(?:(?:please|actually|faktiskt|snälla)\s+)*(?:use|använd)\s+(?:fs\.write|fs\.patch|browser\.open|browser\.shot)\s+(?:to\s+)?(?:create|write|open|save|skapa|skriv|öppna|spara)\b/i;
  // Multi-verb action prompts often start with a READ and then request a
  // destructive/overwrite mutation. "Read foo.txt, then modify it" used to
  // bypass final content proof because the first word was not "edit".
  const readThenWrite = /^(?:read|läs|open|öppna)\b[\s\S]{0,260}\b(?:then|and then|sedan|och sedan)\s+(?:modify|edit|update|rewrite|overwrite|change|ändra|redigera|skriv|spara)\b/i;
  return (request.test(t) || directToolRequest.test(t) || readThenWrite.test(t) || /^g[oö]r\b/i.test(t)) && artifact.test(t);
}

/**
 * Deterministic recovery for a small-model browser.open tool call that omitted
 * the URL even though the user's CURRENT actionable instruction contains ONE
 * explicit HTTP(S) destination. Never guess, browse inferred sites, or take a
 * URL from untrusted page output/chat history.
 *
 * The normal tool permission/approval checks still apply after recovery.
 */
export function recoverExplicitBrowserUrl(goal, tool, args) {
  if (tool !== 'browser.open' || !args || typeof args !== 'object' ||
      (typeof args.url === 'string' && args.url.trim())) return null;
  const prompt = String(goal || '').trim();
  if (/^(?:how|why|what|hur|varför|vad|förklara|explain)\b/i.test(prompt) ||
      !/\b(?:browser\.open|open\s+(?:(?:the|a)\s+)?(?:browser|page|webpage|url)|visit\s+(?:(?:the|a)\s+)?(?:page|website|url)|öppna|besök)\b/i.test(prompt)) return null;
  const refs = new Set();
  for (const hit of prompt.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = hit[0].replace(/[)\]}.;,!?]+$/, '');
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
          url.username || url.password) continue;
      refs.add(url.href);
    } catch { /* never invent or auto-correct a malformed URL */ }
  }
  if (refs.size !== 1) return null;
  const url = [...refs][0];
  return { args: { ...args, url }, url, recovered: true,
    reason: 'restored the one explicit HTTP(S) URL in the active user goal' };
}

/** Del 6A: ONE guard, two call sites. Monthly ledger check before a call costs
   anything; per-task check after each measured step. Returns null to proceed,
   or a result object hard-stopping the loop HONESTLY (errorKind 'budget'). */
export function budgetGate({ cfg, usageCtx = null, route, tally = null }) {
  if (usageCtx?.overBudget?.() && cfg.get('budget.mode') === 'cap' && !isFreeRoute(route)) {
    const capUsd = Number(cfg.get('budget.monthlyUsd')) || 0;
    const human = route.pricing && (route.pricing.in || route.pricing.out)
      ? `The monthly budget of $${capUsd} is reached — paid models stop here. Free models and your own server still answer, or say "budget <new> USD" to raise it.`
      : `The monthly budget of $${capUsd} is reached, and "${route.model || 'this model'}" has no known price — under a cap, unknown never spends. Free models and your own server still answer, or say "budget <new> USD" to raise it.`;
    return { kind: 'monthly', text: human, error: 'budget cap reached', errorKind: 'budget', fatal: true, stopReason: 'budget' };
  }
  /* per-task: ONLY real measured cost can trip this — free routes spend $0 and never do. */
  const perTask = Number(cfg.get('budget.perTaskUsd')) || 0;
  if (tally && perTask > 0 && cfg.get('budget.mode') === 'cap' && (tally.costUsd || 0) > perTask) {
    const human = `This task's budget of $${perTask} is spent ($${(tally.costUsd || 0).toFixed(4)} measured so far) — the task stops here instead of compounding silently. Raise it with "budget.task <new> USD" or run a cheaper model.`;
    return { kind: 'task', text: human, error: 'task budget cap reached', errorKind: 'budget', fatal: true, stopReason: 'task-budget' };
  }
  return null;
}

export async function loop({ cfg, registry, messages, job = 'tasks', onEvent = () => {}, signal, maxSteps, usage, ctx, allowTools = true, label = 'agent', providerErrorCap = 4, providerRetries = null, modelCall = null }) {
  const agent = cfg.get('agent') || {};
  const requestedLimit = Number(maxSteps) || Number(agent.maxSteps) || 40;
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));
  // Immutable goal anchor survives compact() and route escalation. Long turns
  // used to lose the actual user's objective after thousands of tool tokens.
  const initialGoal = [...messages].reverse().find((m) => m.role === 'user')?.content;
  if (typeof initialGoal === 'string' && initialGoal.trim() &&
      !messages.some((m) => m.role === 'system' && String(m.content).startsWith('ACTIVE GOAL:'))) {
    const anchor = { role: 'system', content: 'ACTIVE GOAL: ' + initialGoal.trim().slice(0, 2200) +
      '\\nUse only tools and verified side effects as evidence. Do not claim completion after errors or a step limit.' };
    const firstSystem = messages.findIndex((m) => m.role === 'system');
    messages.splice(firstSystem < 0 ? 0 : firstSystem + 1, 0, anchor);
  }
  const toolLog = [];
  // Only the REAL top-level agent enforces effectful-action proof. Mission
  // workers/subagents have their own contract verifiers and step budgets;
  // injecting extra retries there breaks DAG retry caps and parallelism.
  const requestedRealRoute = (() => { try { return routeFor(cfg, job, { session: ctx?.session }); } catch { return null; } })();
  const realProvider = requestedRealRoute && requestedRealRoute.kind !== 'mock' &&
    !String(requestedRealRoute.ref || '').startsWith('demo/');
  const followupSource = verifyFollowupJobSelection(initialGoal, messages, cfg.get('workspace'));
  const sourceLineage = verifyJobIdLineage(initialGoal, cfg.get('workspace'));
  const actionGoal = label === 'main' && !ctx?.readOnly && allowTools &&
    (ctx?.enforceActionEvidence === true || (!modelCall && realProvider)) &&
    (requiresRealAction(initialGoal) || Boolean(followupSource) || Boolean(sourceLineage) ||
      isLocalTokenDemoGoal(initialGoal));
  let actionRetries = 0;
  let artifactRetries = 0;
  let steps = 0;
  let errors = 0;
  let escalated = false;
  const whoIs = (r) => r?.label || r?.providerName || 'The provider';
  let answer = '';
  let brief = messages.find((m) => m.role === 'system' && String(m.content).startsWith('ARBETSMINNESBRIEF'))?.content || '';
  const tally = { input: 0, output: 0, costUsd: 0 };
  const turnRoutes = new Map(); // stepJob -> route pinned for this turn
  /* W13 never-stuck machinery: per-tool hard timeout + repeat-loop detector + turn time-box. */
  const wdToolTimeoutMs = Math.max(1000, Number(cfg.get('agent.toolTimeoutSec') || 300) * 1000);
  const wdTurnMaxMs = Math.max(250, Number(cfg.get('agent.maxTurnSec') || 1800) * 1000);
  const wdDetect = new RepeatDetector(Math.max(2, Number(cfg.get('agent.maxRepeatCalls') || 3)));
  const wdClock = new TurnClock();
  const wdRecovery = new RecoveryBudget(1);
  let wdRepeatBlocked = false;
  let wdRecoveryHint = null;
  // Only previously FAILED actual writes in this same agent turn are eligible
  // for unchanged-invalid-code protection. No global cache and no user data.
  const invalidJsWrites = new Map();

  while (steps < limit) {
    const wdBox = wdClock.over(wdTurnMaxMs);
    if (wdBox.over) {
      bus.warn('loop.turn_timeout', { label, steps, elapsedMs: wdBox.elapsedMs, wdTurnMaxMs });
      onEvent({ type: 'turn_timeout', label, steps, elapsedMs: wdBox.elapsedMs, limitMs: wdTurnMaxMs });
      return { text: answer || '(time-boxed turn)', steps, toolLog, usage: tally, escalated, stopReason: 'turn_timeout', blocked: 'the turn exceeded its time box — split the work or raise agent.maxTurnSec deliberately' };
    }
    if (wdRepeatBlocked) {
      const last = [...toolLog].reverse().find((entry) => entry.ok === false);
      const detail = last?.tool ? 'Last failing tool: ' + last.tool + '.' : 'No failing tool recorded.';
      onEvent({ type: 'agent_recovery', label, step: steps, phase: 'blocked',
        tool: last?.tool || null, message: 'Repeated action blocked safely. ' + detail });
      bus.warn('loop.repeat_block', { label, steps, tool: last?.tool || null });
      return { text: answer || 'MAJIN stopped a repeated action. ' + detail + ' Review the activity log to choose a different approach.',
        steps, toolLog, usage: tally, escalated, stopReason: 'repeat_block',
        blocked: 'no progress: identical tool call repeated >= maxRepeatCalls' };
    }
    if (signal?.aborted) {
      bus.warn('loop.aborted', { label, steps });
      return { text: answer || '(avbruten)', steps, toolLog, usage: tally, aborted: true, escalated };
    }
    steps += 1;
    // Reserve the final budgeted model call for a user-facing, tool-free answer.
    const finalStep = limit > 1 && steps === limit;
    const followupJob = !agent.stepJob || agent.stepJob === 'same' ? job : agent.stepJob;
    const stepJob = finalStep ? 'final' : escalated ? cfg.get('routing.escalateJob') || 'analysis' : steps === 1 ? job : followupJob;
    /* P0: a TURN keeps the route chosen at its start. Resolving fresh on every
       step meant a provider switch mid-turn silently changed which model
       finished the running work (handover: picker wrote globally; every step
       re-read). Escalation keeps its own deliberate swap via its own key. */
    let route = turnRoutes.get(stepJob) || null;
    if (!route) {
      route = routeFor(cfg, stepJob, { session: ctx?.session });
      if (route) turnRoutes.set(stepJob, route);
    }
    if (!route) throw new Error('no provider with an API key yet — open the Providers card, pick one and paste the key');
    /* A cap is a promise: over the monthly line, PAID calls stop right here,
       before they cost anything. Free routes keep working. */
    const monthlyBlock = budgetGate({ cfg, usageCtx: usage, route });
    if (monthlyBlock) {
      bus.warn('loop.budget', { label, kind: monthlyBlock.kind });
      onEvent({ type: 'error', label, where: 'budget', message: monthlyBlock.text, kind: 'budget' });
      return { text: monthlyBlock.text, steps, toolLog, usage: tally, error: monthlyBlock.error, errorKind: 'budget', fatal: true, stopReason: monthlyBlock.stopReason };
    }

    if (finalStep) messages.push({ role: 'system', content: 'FINAL STEP: do not call tools. Finish the task now using only verified evidence already in the conversation. State what is completed, what is not, and any exact blocker; do not claim actions that did not succeed.' });
    const sentTools = allowTools && !finalStep ? pickSchemas(registry, ctx) : [];
    onEvent({ type: 'step', label, step: steps, of: limit, job: stepJob, model: route.ref, escalated, finalizing: finalStep, toolsSent: sentTools.length, toolChars: sentTools.reduce((a, t) => a + t.description.length + JSON.stringify(t.parameters).length, 0) });

    let res;
    try {
      const timeLeftMs = Math.max(1, wdTurnMaxMs - wdClock.over(wdTurnMaxMs).elapsedMs);
      res = await withAbortDeadline(async (stepSignal) => {
        if (typeof modelCall === 'function') {
          /* Injectable seam also obeys timebox, even if a fake model ignores the signal. */
          return modelCall({ messages, stepJob, step: steps, tools: sentTools, signal: stepSignal });
        }
        return complete({
          route,
          job: `${label}:${stepJob}`,
          messages,
          tools: sentTools,
          toolChoice: sentTools.length ? undefined : 'none',
          stream: true,
          maxTokens: agent.maxTokens || 6000,
          temperature: agent.temperature ?? 0.2,
          retries: providerRetries ?? agent.retries ?? 2,
          signal: stepSignal,
          onEvent: (ev) => {
            if (ev.type === 'delta') onEvent({ type: 'delta', label, text: ev.text });
            else if (ev.type === 'thinking') onEvent({ type: 'thinking', label, text: ev.text });
            else onEvent({ type: 'tool', label, name: ev.name });
          },
        });
      }, { ms: timeLeftMs, parentSignal: signal, label: 'MAJIN model turn' });
    } catch (err) {
      if (err?.code === 'turn_timeout') {
        onEvent({ type: 'turn_timeout', label, steps, elapsedMs: wdClock.over(wdTurnMaxMs).elapsedMs, limitMs: wdTurnMaxMs });
        return { text: answer || 'MAJIN stopped this model call at the configured turn deadline; the task is not complete.',
          steps, toolLog, usage: tally, escalated, incomplete: true,
          stopReason: 'turn_timeout', blocked: 'model call did not finish before agent.maxTurnSec' };
      }
      if (err?.code === 'aborted' || signal?.aborted) {
        return { text: answer || '(avbruten)', steps, toolLog, usage: tally, aborted: true, escalated };
      }
      errors += 1;
      const info = err.majin || explainError(err, route);
      bus.error('loop.provider', { label, step: steps, error: err.message, code: err.code, kind: info.kind });
      onEvent({ type: 'error', label, where: 'provider', message: info.human || err.message, hint: err.hint || null, kind: info.kind });
      // fel som aldrig lost sig (nyckel, krediter, modellnamn, for langt) far
      // inte kosta fyra steg till — anvandaren ska fa svaret direkt
      if (info.stop) {
        return {
          text: answer || info.human || `${whoIs(route)} could not answer: ${err.message}`,
          steps, toolLog, usage: tally, error: err.message,
          errorKind: info.kind, errorHint: err.hint || info.human || null, needsKey: info.needsKey || undefined, fatal: true,
        };
      }
      if (errors >= 2) escalated = true;
      if (errors >= providerErrorCap) return { text: answer || `${whoIs(route)} did not answer after ${errors} tries: ${info.human || err.message}`, steps, toolLog, usage: tally, error: err.message, errorKind: info.kind, errorHint: err.hint || null, escalated };
      messages.push({ role: 'user', content: `The previous call failed (${err.code || 'error'}: ${String(err.message).slice(0, 200)}). Try again, simpler.` });
      continue;
    }

    tally.input += res.usage?.input || 0;
    tally.output += res.usage?.output || 0;
    tally.costUsd += res.usage?.costUsd || 0;
    tally.priceKnown = priceKnownForRoute(route);
    const taskBlock = budgetGate({ cfg, usageCtx: null, route, tally });
    if (taskBlock) {
      bus.warn('loop.budget.task', { label, costUsd: tally.costUsd, steps });
      onEvent({ type: 'error', label, where: 'budget', message: taskBlock.text, kind: 'budget' });
      return { text: taskBlock.text, steps, toolLog, usage: tally, error: taskBlock.error, errorKind: 'budget', fatal: true, stopReason: taskBlock.stopReason };
    }
    usage?.record({ job: `${label}:${stepJob}`, ref: res.route || route.ref, usage: res.usage, ms: res.elapsedMs, escalated, unpriced: !route.pricing && !isFreeRoute(route) });
    answer = res.text || answer;
    onEvent({ type: 'usage', label, step: steps, model: route.ref, tokensIn: res.usage?.input || 0, tokensOut: res.usage?.output || 0, costUsd: res.usage?.costUsd || 0, ms: res.elapsedMs });

    const calls = res.toolCalls || [];
    if (finalStep && calls.length) {
      onEvent({ type: 'tool_blocked', label, step: steps, reason: 'final budget step is reserved for the user-facing answer' });
      return { text: summarizePartial(toolLog, limit), steps, toolLog, usage: tally, escalated,
        incomplete: true, finalizedAtLimit: true, stopReason: 'tool_call_blocked' };
    }
    if (!calls.length) {
      // A model cannot mark an executable goal completed without making a
      // SINGLE real tool call. One bounded retry can recover a missed tool.
      if (actionGoal && !toolLog.some((t) => t.ok)) {
        if (actionRetries < 1 && steps < limit) {
          actionRetries += 1;
          onEvent({ type: 'missing_action_retry', label, step: steps, reason: 'no successful tool call for executable goal' });
          messages.push({ role: 'assistant', content: res.text || '(no action taken)' });
          messages.push({ role: 'user', content: 'Your previous response executed ZERO tools. The user asked for an actual action, not a description. Call the real tool now (or tools.search to discover it); never claim done unless a verifiable tool has run.' });
          continue;
        }
        return { text: 'I could not verify the requested action: no tool completed successfully. The task is NOT complete. ' +
          (res.text ? ('Model reply: ' + res.text.slice(0, 250)) : ''),
          steps, toolLog, usage: tally, escalated, incomplete: true, stopReason: 'missing_tool_evidence' };
      }
      if (actionGoal) {
        const artifact = inspectRequestedArtifact(initialGoal, cfg.get('workspace'));
        const followup = verifyFollowupJobSelection(initialGoal, messages, cfg.get('workspace'));
        const lineage = verifyJobIdLineage(initialGoal, cfg.get('workspace'));
        const contract = lineage && !lineage.ok ? {
          ok: false, target: lineage.output, workspaceRelative: lineage.output,
          source: lineage.source,
          missing: [...(lineage.missing || []), ...(lineage.missingTitles || [])],
          reason: lineage.reason,
        } : followup && !followup.ok
          ? (artifact ? { ...artifact, ok: false, missing: [...(artifact.missing || []), ...followup.missing],
              reason: followup.reason, source: followup.source } : followup)
          : (lineage || artifact || followup);
        if (contract && !contract.ok) {
          onEvent({ type: 'artifact_verify', label, step: steps, ok: false, target: contract.target, missing: contract.missing });
          if (artifactRetries < 2 && steps < limit) {
            artifactRetries += 1;
            messages.push({ role: 'assistant', content: res.text || '(model claimed completion)' });
            messages.push({ role: 'user', content: 'INDEPENDENT ARTIFACT CHECK FAILED: ' + contract.reason +
              '. The user requested the file named ' + contract.workspaceRelative +
              ' INSIDE the current MAJIN workspace. Use fs.write with that exact workspace-relative filename, and include every missing required element: ' +
              String((contract.missing || []).join('; ')).slice(0, 600) +
              (contract.source ? '. Read the original source file ' + contract.source + ' and copy EVERY exact job ID and title from source, never placeholders such as Job1 or job2.' : '') +
              '. Verify the file with fs.read before saying completed. Do not just repeat the claim.' });
            continue;
          }
          return { text: 'Task NOT complete: ' + contract.reason + '. Expected file: ' + contract.workspaceRelative,
            steps, toolLog, usage: tally, escalated, incomplete: true, stopReason: 'artifact_contract_failed', contract };
        }
        if (contract) onEvent({ type: 'artifact_verify', label, step: steps, ok: true, target: contract.target });
      }
      if (res.text) messages.push({ role: 'assistant', content: res.text });
      return { text: res.text || (finalStep ? summarizePartial(toolLog, limit) : answer), steps, toolLog, usage: tally, escalated, finalizedAtLimit: finalStep, stopReason: res.stopReason };
    }

    messages.push({ role: 'assistant', content: res.text || '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, args: safeParse(c.argsJson) })) });

    const runOne = async (c) => {
      const suppliedArgs = safeParse(c.argsJson);
      const urlRecovery = label === 'main' && !ctx?.readOnly
        ? recoverExplicitBrowserUrl(initialGoal, c.name, suppliedArgs) : null;
      const candidateArgs = urlRecovery?.args || suppliedArgs;
      if (urlRecovery) {
        // The URL is from the user's explicit request; do not echo any secret
        // query or path components into the event stream.
        onEvent({ type: 'browser_url_recovered', label, step: steps,
          hostname: new URL(urlRecovery.url).hostname });
      }
      const pin = actionGoal && !ctx?.readOnly
        ? (pinSingleFileWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
           pinJobShortlistWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs)) : null;
      // Do not combine two independent guesses (wrong target path AND wrong
      // content). A wrong-path write may still be pinned by the existing
      // contract, but must be repaired by the model if its bytes are wrong.
      const contentPin = actionGoal && !ctx?.readOnly && !pin?.corrected
        ? pinSingleExactTextWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) : null;
      // Only one narrowly recognized repair per write: changing both path
      // AND source structure at once risks overwriting an unrelated artifact.
      const cliRepair = actionGoal && !ctx?.readOnly && !pin?.corrected && !contentPin
        ? (repairSimpleCommanderCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
           repairSimpleMixedEsmCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
           repairSimpleCommonJsEchoCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
            repairRecordedQwenEscapedCommonJsCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
           repairLiteralEscapedNewlineEchoCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs) ||
           repairSimpleFileWritingEchoCliWrite(initialGoal, cfg.get('workspace'), c.name, candidateArgs)) : null;
      const args = cliRepair?.args || contentPin?.args || pin?.args || candidateArgs;
      if (cliRepair?.corrected) {
        onEvent({ type: 'artifact_cli_dependency_repaired', label, step: steps, target: cliRepair.target });
      }
      if (pin?.corrected) {
        onEvent({ type: 'artifact_path_corrected', label, step: steps, tool: c.name,
          originalPath: pin.originalPath, requestedPath: pin.requestedPath });
      }
      if (contentPin?.corrected) {
        onEvent({ type: 'artifact_content_corrected', label, step: steps, target: contentPin.target });
      }
      onEvent({ type: 'tool_begin', label, step: steps, callId: c.id, name: c.name });
      const key = typeof args.path === 'string' ? args.path : null;
      const previous = key ? invalidJsWrites.get(key) : null;
      const unchangedBad = actionGoal && !ctx?.readOnly && previous
        ? unchangedInvalidJavaScriptWrite(initialGoal, cfg.get('workspace'), c.name, args, previous.content)
        : null;
      const rep = unchangedBad ? null : wdDetect.hit(c.name, args);
      let out;
      if (unchangedBad) {
        previous.repeats += 1;
        // One corrective tool response can still help a small model.
        // If it ignores that explicit error, stop truthfully rather than
        // writing the same invalid artifact forever.
        if (previous.repeats >= 2) wdRepeatBlocked = true;
        out = { ok: false, ms: 0, error: {
          code: 'unchanged_invalid_artifact',
          message: unchangedBad.reason +
            (wdRepeatBlocked ? ' Repeated without changes; turn blocked.' : ''),
        } };
        onEvent({ type: 'artifact_unchanged_invalid', label, step: steps,
          target: unchangedBad.target, repeats: previous.repeats });
      } else if (rep.repeat) {
        // Never execute an identical third call. An already-FAILED action may
        // receive ONE strategy revision; successful duplicates or a second
        // repeat still hard-stop. Permissions and tool budgets are unchanged.
        const recovery = wdRecovery.assess({ tool: c.name, key: rep.key, toolLog });
        if (recovery.recover) {
          wdRecoveryHint = recovery.hint;
          onEvent({ type: 'agent_recovery', label, step: steps, tool: c.name,
            phase: 'strategy_change', attempt: recovery.attempt, remaining: recovery.remaining });
          out = { ok: false, ms: 0, error: {
            code: 'strategy_change_required', message: recovery.hint, key: rep.key,
          } };
        } else {
          out = { ok: false, ms: 0, error: {
            code: 'repeat_loop',
            message: `same call "${c.name}" repeated ${rep.count}x with identical args — stopped, never silently retried (change approach)`,
            key: rep.key,
          } };
          wdRepeatBlocked = true;
        }
      } else {
        // A slow tool should never leave the user staring at a silent composer.
        // Heartbeats carry only a tool name and elapsed time; no args/secrets.
        const heartbeat = startToolHeartbeat({
          tool: c.name,
          emit: (event) => onEvent({ ...event, label, step: steps, callId: c.id }),
        });
        try {
          out = await withTimeout(registry.exec(c.name, args, { ...ctx, session: ctx?.session ?? 'desktop', step: steps, readOnly: Boolean(ctx?.readOnly) }), { ms: wdToolTimeoutMs, label: `tool ${c.name}` });
        } catch (werr) {
          out = { ok: false, ms: wdToolTimeoutMs, error: { code: werr.code === 'tool_timeout' ? 'tool_timeout' : werr.code || 'tool_error', message: werr.message } };
        } finally {
          heartbeat.stop();
        }
      }
      // args följer med i loggen: utan dem är en spårning värdelös som träningsdata
      // (och trådhistoriken kan inte återskapa *varför* verktyget kördes).
      return { id: c.id, name: c.name, args, out, repeatKey: rep?.key || null };
    };
    const parallelSafe = calls.length > 1 && calls.every((call) => {
      const tool = registry.byName?.get(call.name);
      return tool?.risk === 'read' && !['browser', 'screen', 'agent'].includes(tool.group);
    });
    const results = await runToolCalls(calls, runOne, {
      parallel: allowTools && cfg.get('agent.parallel') !== false && parallelSafe,
    });

    for (const r of results) {
      if (r.name === 'tools.search' && r.out?.ok !== false && Array.isArray(ctx?.toolSubsetNames)) {
        const previous = ctx.toolSubsetNames;
        const expanded = expandDiscoveredTools(previous, r.out, registry, { readOnly: ctx?.readOnly });
        if (expanded.length > previous.length) {
          ctx.toolSubsetNames = expanded;
          onEvent({ type: 'tool_subset_expand', added: expanded.filter((name) => !previous.includes(name)), count: expanded.length });
        }
      }
      const ok = r.out.ok !== false;
      const browserRecovery = !ok ? suggestBrowserRecovery(r.name,r.out.error) : null;
      if(browserRecovery){
        // Suggest a different READ first. Never auto-replay potentially
        // completed writes after a timeout or a stale element reference.
        onEvent({type:'browser_recovery',label,step:steps,tool:r.name,
          phase:browserRecovery.phase,next:browserRecovery.next,code:browserRecovery.code});
        r.out.error = {...r.out.error,
          recoveryHint:browserRecovery.message,
          suggestedReadTool:browserRecovery.next};
      }
      if (!ok) errors += 1;
      else errors = Math.max(0, errors - 1);
      toolLog.push({ tool: r.name, args: r.args ?? {}, ok, repeatKey: r.repeatKey, error: ok ? null : r.out.error?.message || 'unknown error', ms: r.out.ms, summary: summarize(r.out) });
      onEvent({ type: 'tool_result', label, step: steps, callId: r.id, tool: r.name, ok, ms: r.out.ms ?? null, error: r.out.error || null, spilled: r.out.spilled || null, summary: summarize(r.out), meta: r.out.meta || null });
      if (!ok) {
        const diagnosis=diagnoseToolFailure(r.name,r.out.error);
        onEvent({type:'tool_diagnosis',label,step:steps,tool:r.name,kind:diagnosis.kind,
          action:diagnosis.action,canInspect:diagnosis.recoverable,labelText:diagnosis.label});
      }
      /* Del 10C: outside data is scanned for override attempts. Clean
         results stay byte-identical (zero token tax); a hit is annotated in
         the very message the model reads AND surfaced as an event. */
      const writeProof = actionGoal ? (
        feedbackForJavaScriptWrite(initialGoal, cfg.get('workspace'), r.name, r.args, ok) ||
        feedbackForExactContentWrite(initialGoal, cfg.get('workspace'), r.name, r.args, ok)
      ) : null;
      if (writeProof) {
        onEvent({ type: 'artifact_write_verify', label, step: steps, target: writeProof.target, ok: writeProof.ok });
        if (r.name === 'fs.write' && typeof r.args?.path === 'string' &&
            typeof r.args.content === 'string') {
          if (writeProof.ok) invalidJsWrites.delete(r.args.path);
          else if (/\.(?:js|mjs)$/i.test(r.args.path))
            invalidJsWrites.set(r.args.path, { content: r.args.content, repeats: 0 });
        }
      }
      const responseText = ok ? String(r.out.result ?? '(ok)') +
        (writeProof ? '\n' + writeProof.text : '')
        : `ERROR [${r.out.error?.code || 'error'}]: ${r.out.error?.message}\n${r.out.error?.hint ? `HINT: ${r.out.error.hint}` : ''}`;
      const guarded = guardToolContent(r.name, responseText);
      if (guarded.hits.length) onEvent({ type: 'injection_warning', label, step: steps, tool: r.name, patterns: guarded.hits.map((h) => h.id) });
      messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: guarded.text,
      });
    }

    if (wdRecoveryHint && !wdRepeatBlocked) {
      // Give the model the strategic alternative after its tool result.
      // Keep the original failed tool call in history as evidence.
      messages.push({ role: 'user', content: wdRecoveryHint });
      wdRecoveryHint = null;
    }

    // For an explicitly requested single-file Node CLI, a successful real
    // write plus static contract and TWO dynamic Docker probes prove completion.
    // Never run generated code on the host. With no cached Docker image (common
    // on Windows), verification returns null and the regular loop continues.
    // This eliminates pointless rewrite/re-read loops after a working CLI,
    // without weakening the repeat guard or grading a file merely by existence.
    if (actionGoal && !ctx?.readOnly &&
        results.some(r => r.name === 'fs.write' && r.out?.ok !== false)) {
      const cliProof = verifyIsolatedNodeCli(initialGoal, cfg.get('workspace'));
      if (cliProof?.ok) {
        onEvent({ type: 'artifact_cli_verified', label, step: steps, target: cliProof.target,
          isolation: 'docker-no-network-read-only', probes: 2 });
        return { text: cliProof.text, steps, toolLog, usage: tally, escalated,
          stopReason: cliProof.stopReason };
      }
    }

    // Explicit isolated TWO-FILE testnet demo: real permitted writes already
    // persisted both source+notes. Stop before a potentially stalled provider
    // call, but never claim a real token was deployed or audited.
    if (actionGoal && !ctx?.readOnly) {
      const demo = verifyLocalTokenDemoFiles(initialGoal, cfg.get('workspace'), results);
      if (demo?.ok) {
        onEvent({ type: 'local_token_demo_verified', label, step: steps, files: demo.files });
        return { text: demo.text, steps, toolLog, usage: tally, escalated,
          stopReason: 'verified_local_token_demo_files' };
      }
    }

    // Atomic "create x.txt containing EXACTLY TOKEN": independent byte proof
    // after the real, permitted write is enough. Avoid asking a weak model to
    // re-write identical bytes until the repeat-loop detector blocks progress.
    // Not applicable to edit/delete/multiple-artifact or free-form tasks.
    if (actionGoal && !ctx?.readOnly && results.length === 1 && results[0].name === 'fs.write') {
      const write = results[0];
      const proof = verifySingleExactTextCreation(initialGoal, cfg.get('workspace'),
        write.name, write.args, write.out?.ok !== false);
      if (proof?.ok) {
        onEvent({ type: 'artifact_exact_text_verified', label, step: steps, target: proof.target });
        return { text: proof.text, steps, toolLog, usage: tally, escalated,
          stopReason: 'verified_exact_text_write' };
      }
    }

    // A single approved fs.delete with independent absent-file proof is
    // ALREADY the requested outcome. Do not ask the model again, risking an
    // empty Ollama response, time-box or a second destructive attempt.
    if (actionGoal && results.length === 1 && results[0].name === 'fs.delete') {
      const candidate = results[0];
      const deletion = verifySingleFileDeletion(
        initialGoal, cfg.get('workspace'), candidate.name, candidate.args,
        candidate.out?.ok !== false
      );
      if (deletion?.ok) {
        onEvent({ type: 'artifact_delete_verified', label, step: steps,
          target: deletion.target, ok: true });
        return { text: deletion.text, steps, toolLog, usage: tally, escalated,
          stopReason: 'verified_single_delete' };
      }
    }

    const escalateAfter = Number(cfg.get('routing.escalateAfterErrors')) || 2;
    if (!escalated && errors >= escalateAfter) {
      escalated = true;
      onEvent({ type: 'escalate', label, step: steps, to: cfg.get('routing.escalateJob') || 'analysis', why: `${errors} tool errors in a row` });
      bus.info('loop.escalate', { label, step: steps, errors });
    }

    if (estimateTokens(messages) > (agent.contextTokens || 48000) * 0.72) {
      const c = await compact({ cfg, messages, brief });
      messages.length = 0;
      messages.push(...c.messages);
      brief = c.brief || brief;
      onEvent({ type: 'compact', label, step: steps, tokens: c.tokens });
    }
  }

  onEvent({ type: 'loop.limit', label, steps, toolCalls: toolLog.length });
  return {
    text: summarizePartial(toolLog, limit, answer),
    steps,
    toolLog,
    usage: tally,
    escalated,
    incomplete: true,
    stopReason: 'step_limit',
  };
}

/**
 * Browser sessions, interactive shells and dependent filesystem operations are
 * ordered state machines. An LLM may emit browser.open, browser.read, shot in
 * ONE response; Promise.all made read/shot race with open, producing fake
 * "no browser is open" failures. Independent tools remain concurrent.
 */
export function requiresOrderedToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length <= 1) return false;
  const names = calls.map(c => String(c?.name || ''));
  if (names.some(n => n.startsWith('browser.') || n.startsWith('exec.'))) return true;
  if (names.includes('fs.delete')) return true;
  if (names.includes('fs.write') && names.includes('fs.read')) return true;
  return false;
}

export async function runToolCalls(calls, runOne, { parallel = true } = {}) {
  if (!Array.isArray(calls)) throw new TypeError('calls must be an array');
  if (typeof runOne !== 'function') throw new TypeError('runOne must be a function');
  return parallel && !requiresOrderedToolCalls(calls)
    ? Promise.all(calls.map(runOne))
    : sequential(calls, runOne);
}

async function sequential(calls, runOne) {
  const out = [];
  for (const c of calls) out.push(await runOne(c));
  return out;
}

export function safeParse(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    const fixed = String(s)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/['‘’“”]/g, '"');
    try {
      return JSON.parse(fixed);
    } catch {
      const kv = {};
      for (const m of String(s).matchAll(/(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g)) {
        const v = m[2];
        kv[m[1]] = /^".*"$/.test(v) ? JSON.parse(v) : v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : Number(v);
      }
      return kv;
    }
  }
}

function summarizePartial(toolLog, limit, priorAnswer = '') {
  if (!toolLog.length) return priorAnswer || `I reached the ${limit}-step limit before I could verify a final result. No tool action was recorded.`;
  const recent = toolLog.slice(-6).map((item) => `- ${item.ok ? 'Completed' : 'Failed'} ${item.tool}: ${item.summary || item.error || 'no details returned'}`).join('\n');
  return `I reached the ${limit}-step limit before I could fully finish and verify the task. Here is the recorded progress:\n${recent}\nPlease let me continue or narrow the remaining work.`;
}

function summarize(out) {
  if (out?.summary) return out.summary;
  const t = String(out?.result ?? '');
  return t.length ? t.split('\n')[0].slice(0, 160) : 'done';
}
