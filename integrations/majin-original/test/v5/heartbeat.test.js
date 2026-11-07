import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { V5Heartbeat, createHeartbeatTool } from '../../src/v5/heartbeat.js';
import { createV5Server } from '../../src/v5/server.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-heartbeat-'));
  let now = Date.now();
  const hb = new V5Heartbeat({ dataDir: root, now: () => now, minGapMs: 1000 });
  hb.start({ ownsHost: true });
  t.after(() => { hb.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, hb, advance: () => { now += 2000; } };
}

test('heartbeat retains deduped real events, omits sensitive goal text, previews without delivery and persists local digests', async t => {
  const { root, hb, advance } = fixture(t);
  const goal = { goal_id: 'goal-one', status: 'BLOCKED', blocker: 'sk-secret-do-not-store', objective: 'private CV data' };
  hb.observe(goal); hb.observe(goal);
  assert.equal(hb.view().queued, 1);
  const preview = await hb.manage({ action: 'preview' });
  assert.equal(preview.count, 1); assert.equal(hb.view().notifications.length, 0);
  assert.equal((await hb.manage({ action: 'tick' })).sent, true);
  assert.equal(hb.view().notifications.length, 1);
  assert.doesNotMatch(JSON.stringify(hb.view()), /sk-secret|private CV/);
  hb.observe({ goal_id: 'goal-two', status: 'WAITING_USER' });
  assert.equal((await hb.manage({ action: 'tick' })).sent, false);
  advance(); await hb.manage({ action: 'tick' });
  assert.equal(hb.view().notifications.length, 2);
  hb.stop(); hb.start({ ownsHost: true });
  assert.equal(hb.view().notifications.length, 2);
  assert.equal(hb.view().queued, 0);
  assert.ok(fs.existsSync(path.join(root, 'v5-heartbeat-inbox.json')));
});

test('resume/completion clears stale pending alerts; disable persists and synthetic tool events are rejected', async t => {
  const { hb } = fixture(t);
  hb.observe({ goal_id: 'goal-one', status: 'WAITING_USER' });
  hb.observe({ goal_id: 'goal-one', status: 'RUNNING' }, 'started');
  assert.equal(hb.view().queued, 0);
  hb.observe({ goal_id: 'goal-one', status: 'BLOCKED' });
  hb.observe({ goal_id: 'goal-one', status: 'COMPLETED' });
  assert.equal(hb.view().queued, 0);
  const tool = createHeartbeatTool(hb);
  await assert.rejects(tool.run({ action: 'preview', event: 'invented failure' }));
  await hb.manage({ action: 'disable' }); hb.stop(); hb.start({ ownsHost: true });
  assert.equal(hb.view().enabled, false); assert.equal(hb.view().running, false);
  hb.observe({ goal_id: 'ignored', status: 'FAILED' }); assert.equal(hb.view().queued, 0);
  assert.equal((await hb.manage({ action: 'tick' })).sent, false);
  await hb.manage({ action: 'enable' }); assert.equal(hb.view().running, true);
});

test('heartbeat refuses another host and does not overwrite corrupt durable state', t => {
  const { root, hb } = fixture(t);
  const other = new V5Heartbeat({ dataDir: root }); other.start();
  assert.equal(other.view().running, false); assert.match(other.view().error, /exclusive/);
  hb.stop();
  fs.writeFileSync(hb.inboxFile, 'not json'); hb.start({ ownsHost: true });
  assert.equal(hb.view().running, false); assert.ok(hb.view().error);
  assert.equal(fs.readFileSync(hb.inboxFile, 'utf8'), 'not json');
});

test('real DeepSeek provider-agent failure is observed through the server and exposed in the local heartbeat API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-heartbeat-agent-'));
  const srv = createV5Server({ dataDir: root, completeImpl: async request => {
    assert.ok(request.tools.some(tool => tool.name === 'majin_heartbeat'));
    throw new Error('fixture provider unavailable');
  } });
  await srv.architect.providers.configureProvider({ providerId: 'deepseek', apiKey: 'fixture-key', discover: false });
  srv.architect.providers.selectModel({ providerId: 'deepseek', modelId: 'deepseek-fixture', allowManualFallback: true });
  srv.architect.files.ownerMode.grant({ lanes: ['sys'] });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const { url } = await srv.start();
  const goal = await srv.providerAgent.execute({ goalText: 'Inspect host status' });
  assert.equal(goal.status, 'BLOCKED');
  assert.equal(srv.heartbeat.view().queued, 1);
  await srv.heartbeat.manage({ action: 'tick' });
  const status = await (await fetch(url + '/api/v5/heartbeat')).json();
  assert.equal(status.notifications.length, 1);
  assert.ok(status.notifications[0].goals.includes(goal.goal_id));
  assert.equal(status.externalDelivery, false);
});
