/* 12C substance: REAL end-to-end workflow — real model (local Ollama qwen3:0.6b),
   real tool execution, real artifact, no fabrications. Verdict JSON on stdout. */
import { load } from '../src/core/config.js';
import { Agent } from '../src/core/agent.js';
import { buildRegistry } from '../src/core/tools/index.js';
import fs from 'node:fs';

const out = { schema: 'majin.e2e-real-workflow.v1', ts: new Date().toISOString(), phases: {}, verdict: {} };
const cfg = await load();
const registry = buildRegistry({ cfg });
const agent = new Agent({ cfg, registry });
const events = [];
const TASK = 'Create a file named v1-roadmap.txt containing exactly the text: MAJIN 1.0 = proof over claims. Then reply with the file name only.';
const onEvent = (e) => events.push({ t: e?.type, at: Date.now() });
const t0 = Date.now();
try {
  const res = await agent.turn({ input: TASK, session: 'e2e-12c-real', onEvent, source: 'e2e-probe' });
  const reply = String(res?.text || res?.content || '').slice(0, 500);
  out.phases.agentReply = { ok: Boolean(reply), reply, elapsedMs: Date.now() - t0, steps: res?.steps ?? null, toolsUsed: res?.tools ?? null };
} catch (e) {
  out.phases.agentReply = { ok: false, error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 };
}
const target = '/home/user/.majin/workspace/v1-roadmap.txt';
out.phases.artifact = {
  exists: fs.existsSync(target),
};
if (fs.existsSync(target)) {
  const content = fs.readFileSync(target, 'utf8');
  out.phases.artifact.content = content;
  out.phases.artifact.matchesRequested = /MAJIN 1\.0 = proof over claims/.test(content);
}
out.phases.eventTrail = { count: events.length, types: [...new Set(events.map(e => e.t))].slice(0, 12) };
out.verdict = {
  realModelAnswered: out.phases.agentReply.ok === true,
  fileActuallyCreated: out.phases.artifact.exists === true,
  contentVerifiablyMatches: out.phases.artifact.matchesRequested === true,
};
out.verdict.allPass = Object.values(out.verdict).every(v => v === true);
console.log(JSON.stringify(out, null, 1));
process.exit(out.verdict.allPass ? 0 : 2);
