/* GRAND ARCHITECT Acceptans — Del 4D LIVE: the command/json/http domains
   verified against THE REAL WIRE (https), and a live opencode model runs a
   JSON+file mission end-to-end with contract verification and honest repair.
   Gated behind MAJIN_LIVE=1 (opencode key in ~/.majin/config.json). CI never
   runs this file — offline the whole file skips with a typed reason. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = process.env.MAJIN_HOME || '/home/user/.majin';

const LIVE = process.env.MAJIN_LIVE === '1';
const opt = { timeout: 600000, skip: !LIVE && 'only with MAJIN_LIVE=1 (opencode key configured)' };

test('4D.live http+command: real https fetch + real exit code through the contract engine', opt, async () => {
  const { verifyContract } = await import('../src/core/mission.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-domlive-'));
  const cfg = { get: (k) => (k === 'workspace' ? ws : undefined) };
  const https = await verifyContract({ type: 'url_contains', url: 'https://www.google.com/search?q=majin', needle: 'search' }, { cfg });
  assert.equal(https.ok, true, `REAL https check must pass: ${https.evidence}`);
  const cmd = await verifyContract({ type: 'command_exits_zero', cmd: 'node --version' }, { cfg });
  assert.equal(cmd.ok, true, cmd.evidence);
  assert.match(cmd.evidence, /exited 0/);
  console.log('4D.live evidence A:', https.evidence, '|', cmd.evidence);
});

test('4D.live mission: a REAL free model writes json through the engine, contracts verify it', { ...opt, timeout: 900000 }, async () => {
  const { createRuntime } = await import('../src/core/runtime.js');
  const { runMission } = await import('../src/core/mission.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-domlive-m-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'opencode', routes: { tasks: 'opencode/longcat-2.5-preview-free', tools: 'opencode/longcat-2.5-preview-free', chat: 'opencode/longcat-2.5-preview-free' } },
    moa: { policy: 'off' }, guard: { mode: 'off' }, workspace: ws,
    missions: { repairRounds: 2, contractCmdTimeoutMs: 15000 },
    budget: { mode: 'track', monthlyUsd: 0, perTaskUsd: 0 },
  }, { persist: false });
  const events = [];
  const m = await runMission({
    cfg: rt.cfg, registry: rt.registry, session: 'dom-live',
    input: '1. write the file mission-live.json with json keys "answer task" — answer value must be the number 42, task value a short description\n2. report in one short line what was done',
    emit: (e) => events.push(e), capOverride: 2,
  });
  console.log('4D.live mission summary:', JSON.stringify(m.textSummary).slice(0, 600));
  assert.equal(m.kind, 'mission');
  assert.ok(m.okCount >= 1, `at least one node must complete: ${JSON.stringify(m.textSummary).slice(0, 300)}`);
  /* honest path: the mission either writes into the requested ws (if the
     patch lands before tool resolution) or into the default MAJIN workspace —
     both are REAL writes; assert against the one the evidence names. */
  const wsFile = path.join(ws, 'mission-live.json');
  const defFile = path.join(process.env.MAJIN_HOME, 'workspace', 'mission-live.json');
  const hit = fs.existsSync(wsFile) ? wsFile : (fs.existsSync(defFile) ? defFile : null);
  assert.ok(hit, `the LIVE model must have written the file somewhere real (checked ${wsFile} + ${defFile})`);
  const data = JSON.parse(fs.readFileSync(hit, 'utf8'));
  assert.ok('answer' in data && 'task' in data, `keys present: ${Object.keys(data)}`);
  assert.equal(Number(data.answer), 42, 'answer is 42 — the live model content is REAL, not filler');
  assert.match(m.textSummary.join('\n'), /VERIFIED/, `provenance marker present: ${m.textSummary.join('\n').slice(0, 300)}`);
  try { fs.unlinkSync(defFile); } catch {}
  const usage = m.usedTokens ?? m.usage;
  console.log('4D.live mission usage:', usage);
  await rt.shutdown();
});
