import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRegistry } from '../src/core/tools/index.js';
import { flowsTools, testStopHub } from '../src/core/tools/flows.js';

/* W5 VERIFIED-delta: register a REAL file-watch flow through the tool surface
   (not by poking internals), drop a real file, and require BOTH durable
   outcomes: flows.list reports success AND the workspace run-log shows the
   fired record with its eventHash. */

test('W5 E2E: file trigger → real file drop → flow fires → durable measured outcome', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-flow-'));
  const inbox = path.join(workspace, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const cfg = { get: (k) => (k === 'workspace' ? workspace : undefined), peek: () => undefined, patch: () => {} };
  const registry = buildRegistry({ cfg });
  const ctx = { cfg, registry, session: 'w5-e2e' };

  const add = flowsTools.find((t) => t.name === 'flows.add');
  const list = flowsTools.find((t) => t.name === 'flows.list');
  const r1 = await add.run({
    name: 'w5 integration file watch',
    when: { type: 'file', path: inbox, event: 'add' },
    then: { tool: 'fs.write', args: { path: 'w5-fired.log', content: 'W5-E2E fired for {{path}}', append: true } },
  }, ctx);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.meta.fileWatchError, null, 'the REAL watcher must arm — a silently-degraded flow is exactly the W5 gap: ' + JSON.stringify(r1.meta));
  const flowId = r1.meta.id;


  fs.writeFileSync(path.join(inbox, 'w5-dropped.txt'), 'integration payload');

  /* real watcher + awaitWriteFinish → poll the durable outcome, never sleep-guess */
  const deadline = Date.now() + 15000;
  let state = null, runs = null;
  while (Date.now() < deadline) {
    const r = await list.run({}, ctx);
    state = r.meta.flows.find((f) => f.id === flowId);
    /* history is durable in state.json; the list tool strips it by design,
       so the assertion reads the durable file, not the compacted view */
    const stateFile = path.join(workspace, 'flows', flowId, 'state.json');
    runs = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')).history || []).filter(Boolean) : [];
    if (state?.lastStatus === 'ok' && runs.some((x) => x.kind === 'fire' && x.status === 'ok')) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  assert.equal(state?.lastStatus, 'ok', 'flow state must reach measured success: ' + JSON.stringify(state));
  assert.ok(state.fireCount >= 1);
  const fire = runs.find((x) => x.kind === 'fire' && x.status === 'ok');
  assert.ok(fire, 'state.json history must contain a successful fire record: ' + JSON.stringify(runs));
  assert.ok(fire.eventHash, 'every fire carries a dedup-able eventHash — replay cannot double-count');
  /* durable observable side effect of the action itself */
  const outcome = path.join(workspace, 'w5-fired.log');
  assert.ok(fs.existsSync(outcome) && /W5-E2E fired/.test(fs.readFileSync(outcome, 'utf8')), 'the then-tool must have actually WRITTEN its output file: ' + outcome + (fs.existsSync(outcome) ? fs.readFileSync(outcome, 'utf8') : ' (missing)'));
  await testStopHub(); /* release the persistent watcher or the runner cannot drain */
}, 20000);
