/* GRAND ARCHITECT Acceptans — Del 12A: INDEPENDENT real-model end-to-end
   acceptance suite. The verdict machine is CODE ONLY — no model ever judges
   its own work. Each test drives a REAL opencode free model through real
   missions, then verifies the artifacts on disk and in the summary markers.
   Gated: MAJIN_LIVE=1 + opencode key in ~/.majin/config.json — CI skips. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = process.env.MAJIN_HOME || '/home/user/.majin';

const LIVE = process.env.MAJIN_LIVE === '1';
const opt = { timeout: 900000, skip: !LIVE && 'only with MAJIN_LIVE=1 (opencode key configured)' };

const WS = () => path.join(process.env.MAJIN_HOME, 'workspace');
const files = [];

async function mkrt() {
  const { createRuntime } = await import('../src/core/runtime.js');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'opencode', routes: { tasks: 'opencode/longcat-2.5-preview-free', tools: 'opencode/longcat-2.5-preview-free', chat: 'opencode/longcat-2.5-preview-free' } },
    moa: { policy: 'off' }, guard: { mode: 'off' },
    missions: { repairRounds: 2, contractCmdTimeoutMs: 15000 },
    budget: { mode: 'track', monthlyUsd: 0, perTaskUsd: 0 },
  }, { persist: false });
  return rt;
}

test('12A.1 live create: the model writes a json file; CODE verifies keys + VERIFIED marker + usage', opt, async () => {
  const { runMission } = await import('../src/core/mission.js');
  const rt = await mkrt();
  fs.mkdirSync(WS(), { recursive: true });
  const f = 'acceptance-A1.json'; files.push(f);
  const m = await runMission({
    cfg: rt.cfg, registry: rt.registry, session: 'acc-12a-1',
    input: '1. write the file ' + f + ' with json keys "suite status" — suite value must be the string 12A, status value the string green\n2. report in one short line what was done',
    emit: () => {}, capOverride: 2,
  });
  const hit = path.join(WS(), f);
  assert.ok(fs.existsSync(hit), `file must exist on disk: ${hit}`);
  const data = JSON.parse(fs.readFileSync(hit, 'utf8'));
  assert.equal(String(data.suite), '12A');
  assert.equal(String(data.status).toLowerCase(), 'green');
  assert.match(m.textSummary.join('\n'), /VERIFIED/, 'provenance marker present — termination came from verification, not from the model saying so');
  assert.ok((m.usedTokens ?? 0) > 0, `usage measured: ${m.usedTokens}`);
  console.log(`12A.1 usage: ${m.usedTokens} tokens, wall ${m.metrics?.wallMs != null ? ((m.metrics.wallMs / 1000).toFixed(1) + 's') : 'n/a'}`);
  await rt.shutdown();
});

test('12A.2 live edit: pre-existing content is preserved AND the new section is appended', opt, async () => {
  const { runMission } = await import('../src/core/mission.js');
  const rt = await mkrt();
  fs.mkdirSync(WS(), { recursive: true });
  const f = 'acceptance-A2.md'; files.push(f);
  fs.writeFileSync(path.join(WS(), f), '# ops notes\noriginal line ALPHA\n');
  const m = await runMission({
    cfg: rt.cfg, registry: rt.registry, session: 'acc-12a-2',
    input: '1. the existing file ' + f + ' already contains the line "original line ALPHA" — use the fs.patch tool with edits [{find:"original line ALPHA",replace:"original line ALPHA\\nPROOF-7741 section"}] — fs.patch only, never fs.write\n2. report in one short line what was done',
    emit: () => {}, capOverride: 2,
  });
  const content = fs.readFileSync(path.join(WS(), f), 'utf8');
  assert.match(content, /original line ALPHA/, 'original content PRESERVED — not overwritten');
  assert.match(content, /PROOF-7741/, 'new content appended');
  assert.ok((m.usedTokens ?? 0) > 0);
  console.log(`12A.2 usage: ${m.usedTokens} tokens`);
  await rt.shutdown();
});

test('12A.3 independent lie-detector: contracts call out missing artifacts without any model vote', opt, async () => {
  const { verifyContract } = await import('../src/core/mission.js');
  const cfg = { get: (k) => (k === 'workspace' ? WS() : undefined) };
  const lie = await verifyContract({ type: 'file_exists', path: 'acceptance-NO-SUCH-9.hope' }, { cfg });
  assert.equal(lie.ok, false, 'a lie about the file must be named as missing');
  assert.match(String(lie.evidence), /missing|not/i);
  const jsonLie = await verifyContract({ type: 'json_topkeys', path: 'acceptance-NO-SUCH-9.hope', keys: 'a b' }, { cfg });
  assert.equal(jsonLie.ok, false);
  const okC = await verifyContract({ type: 'command_exits_zero', cmd: 'node -e "process.exit(7)"' }, { cfg });
  assert.equal(okC.ok, false, 'exit 7 can never be reported as success');
  assert.match(String(okC.evidence), /exit 7/);
  console.log('12A.3 engine evidence:', lie.evidence, '|', okC.evidence);
});

test.after(() => {
  for (const f of files) { try { fs.unlinkSync(path.join(WS(), f)); } catch { /* fine */ } }
});
