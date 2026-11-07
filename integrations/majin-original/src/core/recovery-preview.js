/** Read-only restart preview; never invokes tools or mutates checkpoints. */
import { recoveryDecision } from './recovery-policy.js';
export function recoveryPreview(checkpoint) {
  if (checkpoint?.schema !== 1 || typeof checkpoint?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(checkpoint.id)) return { ready:false, reason:'invalid-checkpoint', steps:[] };
  // A preview is advisory only; checkpoint metadata is not proof of side effects.
  if (!checkpoint.state || typeof checkpoint.state !== 'object' || Array.isArray(checkpoint.state)) return { ready:false, reason:'invalid-state', steps:[] };
  const steps = checkpoint.state.steps;
  if (!Array.isArray(steps)) return { ready:false, reason:'no-steps', steps:[] };
  if (steps.length > 1000) return { ready:false, reason:'too-many-steps', steps:[] };
  if (steps.length === 0) return { ready:false, reason:'empty-steps', steps:[] };
  const seen = new Set();
  const results = [];
  const counts = { resume:0, skip:0, inspect:0, approval:0 };
  for (const [index, step] of steps.entries()) {
    // Reject malformed entries before asking the recovery policy to classify them.
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { ready:false, reason:'invalid-step', steps:[] };
    const id = Object.hasOwn(step, 'id') && typeof step.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(step.id) ? step.id : null;
    if (!id || seen.has(id)) return { ready:false, reason:'invalid-or-duplicate-step-id', steps:[] };
    seen.add(id);
    if (!Object.hasOwn(step, 'risk') || !Object.hasOwn(step, 'status')) return { ready:false, reason:'invalid-step', steps:[] };
    if (!['read','write','destructive','external'].includes(step.risk) || !['pending','running','uncertain','verified','failed','completed'].includes(step.status)) return { ready:false, reason:'invalid-step-metadata', steps:[] };
    const decision = recoveryDecision(step);
    // Never trust an unrecognized policy verdict as authorization to resume.
    if (!['resume', 'skip', 'inspect', 'approval'].includes(decision?.action)) return { ready:false, reason:'unknown-recovery-action', steps:[] };
    counts[decision.action]++;
    results.push({ index, id, action: decision.action, reason: String(decision.reason || 'unspecified') });
  }
  // A readable checkpoint is not necessarily safe to run without supervision.
  const needsAttention = counts.inspect > 0 || counts.approval > 0;
  return { ready:true, needsAttention, counts, steps:results };
}
