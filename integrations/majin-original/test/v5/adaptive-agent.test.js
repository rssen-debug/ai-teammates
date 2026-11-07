import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createV5Server } from '../../src/v5/server.js';

const call = (id, name, args) => ({ toolCalls: [{ id, name, args }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
const final = content => ({ content, usage: { prompt_tokens: 5, completion_tokens: 3 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function setup(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adaptive-agent-'));
  const requests = [];
  const completeImpl = async request => { requests.push(structuredClone(request.messages)); return respond(request, requests.length); };
  const servers = [];
  const reconstruct = () => {
    const server = createV5Server({ dataDir: root, completeImpl });
    server.architect.providers.selectModel({ providerId: 'opencode-go', modelId: 'deepseek-v4-pro', allowManualFallback: true });
    servers.push(server); return server;
  };
  const server = reconstruct();
  t.after(async () => {
    for (const instance of servers) {
      await instance.providerAgent.cancel();
      if (instance.server.listening) await instance.stop();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, server, requests, reconstruct };
}

test('adaptive agent repairs an actual file after independent verification rejects the model completion', async t => {
  const { server, requests } = setup(t, (_request, count) => {
    if (count === 1) return call('wrong', 'fs_write', { path: 'answer.txt', content: 'incorrect output' });
    if (count === 2) return final('Done.');
    if (count === 3) return call('repaired', 'fs_write', { path: 'answer.txt', content: 'verified answer' });
    return final('Repaired and checked.');
  });
  const result = await server.providerAgent.execute({ goalText: 'Write answer.txt with verified answer',
    criteria: [{ kind: 'file', path: 'answer.txt', contains: 'verified answer' }] });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'answer.txt'), 'utf8'), 'verified answer');
  assert.equal(result.verification_evidence.length, 1);
  assert.equal(result.adaptive.verificationFailures, 1);
  assert(result.adaptive.transitions.some(transition => transition.mode === 'recover'));
  assert(requests[2].some(message => message.role === 'user' && String(message.content).includes('Host independent verification failed')));
  assert.equal(result.tool_results.length, 2);
});

test('pause preserves observed work, fences a late provider write, and resumes after server reconstruction', async t => {
  const entered = deferred(), release = deferred();
  const { server, reconstruct } = setup(t, async (_request, count) => {
    if (count === 1) return call('append-once', 'fs_write', { path: 'once.txt', content: 'once', append: true });
    if (count === 2) {
      entered.resolve(); await release.promise;
      return call('late-action', 'fs_write', { path: 'late.txt', content: 'must never happen' });
    }
    if (count === 3) return call('complete', 'fs_write', { path: 'ready.txt', content: 'ready' });
    return final('Finished from saved work.');
  });
  const criteria = [{ kind: 'file', path: 'ready.txt', contains: 'ready' }];
  const running = server.providerAgent.execute({ goalText: 'Append once and create ready.txt', criteria });
  await entered.promise;
  const pausing = server.providerAgent.pause();
  release.resolve();
  await pausing;
  const paused = await running;
  assert.equal(paused.status, 'PAUSED');
  assert.equal(fs.existsSync(path.join(server.architect.workspaceDir, 'late.txt')), false);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'once.txt'), 'utf8'), 'once');
  const restarted = reconstruct();
  assert.equal(restarted.providerAgent.getGoalState().status, 'PAUSED');
  const result = await restarted.providerAgent.execute({ resume: true });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.goal_id, paused.goal_id);
  assert.deepEqual(result.criteria, criteria);
  assert.deepEqual(result.tool_results.map(row => row.tool), ['fs_write', 'fs_write']);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'once.txt'), 'utf8'), 'once');
  assert.equal(fs.existsSync(path.join(server.architect.workspaceDir, 'late.txt')), false);
});

test('owner steering during inference discards the stale proposed batch before its file write', async t => {
  const entered = deferred(), release = deferred();
  const { server, requests } = setup(t, async (_request, count) => {
    if (count === 1) {
      entered.resolve(); await release.promise;
      return call('stale', 'fs_write', { path: 'obsolete.txt', content: 'obsolete' });
    }
    if (count === 2) return call('current', 'fs_write', { path: 'current.txt', content: 'owner requested' });
    return final('Followed the updated instruction.');
  });
  const running = server.providerAgent.execute({ goalText: 'Create the requested output',
    criteria: [{ kind: 'file', path: 'current.txt', contains: 'owner requested' }] });
  await entered.promise;
  server.providerAgent.steer('Use current.txt; discard the obsolete.txt proposal.');
  release.resolve();
  const result = await running;
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(server.architect.workspaceDir, 'obsolete.txt')), false);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'current.txt'), 'utf8'), 'owner requested');
  assert.equal(result.tool_results.length, 1);
  assert(requests[1].some(message => message.role === 'user' && String(message.content).includes('discard the obsolete.txt proposal')));
  assert(result.adaptive.transitions.some(transition => transition.mode === 'plan'));
});

test('failed-action fingerprint survives reconstruction and prevents repeating the same failed operation', async t => {
  const { server, reconstruct } = setup(t, (_request, count) => {
    if (count <= 2) return call(`missing-${count}`, 'fs_read', { path: 'missing.txt' });
    if (count === 3) return call('recover', 'fs_write', { path: 'proof.txt', content: 'recovered' });
    return final('Changed strategy and completed the output.');
  });
  server.providerAgent.maxRounds = 1;
  const initial = await server.providerAgent.execute({ goalText: 'Create proof.txt',
    criteria: [{ kind: 'file', path: 'proof.txt', contains: 'recovered' }] });
  assert.equal(initial.status, 'BLOCKED');
  assert(initial.adaptive.failedActions.length > 0);
  const result = await reconstruct().providerAgent.execute({ resume: true });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.tool_results[0].ok, false);
  assert(result.tool_results[0].operationId, 'first failure was a real driver operation');
  assert.equal(result.tool_results[1].errorCode, 'REPEATED_FAILED_ACTION');
  assert.equal(result.tool_results[1].operationId, undefined, 'repeat was refused before driver execution');
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'proof.txt'), 'utf8'), 'recovered');
});
