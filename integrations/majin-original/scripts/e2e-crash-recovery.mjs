#!/usr/bin/env node
/* E2E crash-recovery evidence pack (12B/11C-adjacent, machine-owned):
   Phase A: a mid-task handoff checkpoint is persisted by a real Agent, the
            process then "dies" (no graceful teardown). A FRESH Agent instance
            (new process semantics) must consume the checkpoint exactly once.
   Phase B: journal atomicity — every history line must remain complete JSON
            after abrupt death. */
import path from 'node:path';
import fs from 'node:fs';
import { dirs } from '../src/core/paths.js';
import { appendHistory } from '../src/core/context.js';
import { Agent } from '../src/core/agent.js';
import { load } from '../src/core/config.js';

const session = 'e2e-12b-crash';
const out = { schema: 'majin.e2e-crash-recovery.v1', ts: new Date().toISOString(), session, phases: {} };

const cfg = await load();

// Seed a real mid-task history (an earlier turn in-progress)
appendHistory(session, { role: 'user', content: 'E2E_PROBE: list the nine test steps and mark step 4 in progress', ts: new Date().toISOString() });
appendHistory(session, { role: 'assistant', content: 'E2E_PROBE: steps 1-3 done (tool run fs.list); step 4 in progress', ts: new Date().toISOString() });

// Agent A: persists the mid-task handoff atomically, then abrupt "death" (no cleanup).
const agentA = new Agent({ cfg });
const w = await agentA.handoff({ session, to: 'ollama/smollm2:135m' });
const hf = agentA.handoffPath(session);
out.phases.checkpointWritten = {
  ok: !!hf && fs.existsSync(hf),
  path: hf && path.basename(hf),
  goal: w.goal ? w.goal.slice(0, 60) : null,
  to: w.to || null,
};
// (Agent A is simply dropped — its persisted state is the whole point.)

// Agent B: fresh instance = restart. Must consume the checkpoint exactly once.
const agentB = new Agent({ cfg });
const got1 = agentB.consumeHandoff(session);
const got2 = agentB.consumeHandoff(session); // second consume must NOT return it again
out.phases.crashResume = {
  consumedCheckpoint: !!got1,
  goal: got1?.goal ? got1.goal.slice(0, 60) : null,
  lastProgress: got1?.lastProgress ? got1.lastProgress.slice(0, 60) : null,
  from: got1?.from || null,
  to: got1?.to || null,
  idempotent: got2 === null || got2 === undefined,
  fileStillExists: fs.existsSync(hf),
  fileMarkedConsumed: (() => { try { return JSON.parse(fs.readFileSync(hf, 'utf8')).consumed === true; } catch { return null; } })(),
};

// Phase B: journal atomicity — every line of this session's journal parses as complete JSON.
const hf_lines = (() => {
  const f = path.join(dirs.sessions, `${session}.jsonl`);
  if (!fs.existsSync(f)) return { found: false };
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  let ok = 0, bad = 0;
  for (const l of lines) { try { JSON.parse(l); ok++; } catch { bad++; } }
  return { found: true, lines: lines.length, completeLines: ok, tornLines: bad };
})();
out.phases.journalAtomicity = hf_lines;

out.verdict = {
  checkpointPersisted: out.phases.checkpointWritten.ok,
  resumeAfterAbruptDeath: out.phases.crashResume.consumedCheckpoint === true,
  resumeIsIdempotent: out.phases.crashResume.idempotent === true,
  journalUntorn: hf_lines.found && hf_lines.tornLines === 0,
};
out.verdict.allPass = Object.values(out.verdict).every(v => v === true);
console.log(JSON.stringify(out, null, 1));
process.exit(out.verdict.allPass ? 0 : 2);
