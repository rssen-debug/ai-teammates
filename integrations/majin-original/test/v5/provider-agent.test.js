import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createV5Server } from '../../src/v5/server.js';
import { ProviderAgent, buildBoundedProviderMessages, summariseToolArgs } from '../../src/v5/provider-agent.js';
import { classifyProviderError } from '../../src/v5/providers.js';
import { responsesInput } from '../../src/core/provider/responses.js';
import { toAnthropic } from '../../src/core/provider/anthropic.js';
import { browserBinary } from '../../src/v4/tools/host.js';
import { PNG } from 'pngjs';
import { createDriverTools } from '../../src/v5/codex-tools.js';

test('verified completion survives learning failure and restart delivers it exactly once without model or tool replay', async t => {
  const { server, requests } = await setup(t, (_body, count) => count === 1
    ? tool('write-proof', 'fs_write', { path: 'learn.txt', content: 'verified' })
    : { role: 'assistant', content: 'Done.' });
  const engine = server.architect.learning;
  const original = engine.learnFromVerifiedGoal.bind(engine);
  engine.learnFromVerifiedGoal = async () => { throw new Error('Injected storage failure'); };
  const result = await server.providerAgent.execute({ goalText: 'Write learn.txt', criteria: [{ kind: 'file', path: 'learn.txt', contains: 'verified' }] });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.learning.status, 'pending');
  assert.equal(engine.state.procedures.length, 0);
  const count = requests.length;
  await server.providerAgent.close();
  const restored = new ProviderAgent({ architect: server.architect });
  // Crash after the learning store commits, but before delivery is acknowledged.
  engine.learnFromVerifiedGoal = async payload => { await original(payload); throw new Error('Lost acknowledgement'); };
  await restored.recoverLearning();
  assert.equal(restored.getGoalState().learning.status, 'pending');
  assert.equal(engine.state.procedures.length, 1);
  engine.learnFromVerifiedGoal = original;
  await restored.recoverLearning();
  await restored.recoverLearning();
  assert.equal(restored.getGoalState().learning.status, 'saved');
  assert.equal(engine.state.procedures[0].verifiedUses, 1);
  assert.equal(engine.state.procedures[0].provenance.length, 1);
  assert.equal(requests.length, count);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'learn.txt'), 'utf8'), 'verified');
  assert.equal(fs.readdirSync(restored.learningOutbox.dir).length, 0);
});

test('unverified partial work never enters the learning delivery queue', async t => {
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write-unverified', 'fs_write', { path: 'draft.txt', content: 'draft' })
    : { role: 'assistant', content: 'Draft prepared.' });
  const goal = await server.providerAgent.execute({ goalText: 'Prepare a draft.' });
  assert.equal(goal.status, 'PARTIAL');
  assert.equal(goal.learning, undefined);
  assert.deepEqual(fs.readdirSync(server.providerAgent.learningOutbox.dir), []);
  assert.equal(server.architect.learning.state.procedures.length, 0);
});

test('empty directory listing means workspace and still rejects traversal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-empty-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'proof.txt'), 'fixture');
  const driver = await createDriverTools({ workspace: root });
  const tools = driver;
  assert.match(JSON.stringify(await tools.get('fs_list').run({ path: '' })), /proof.txt/);
  await assert.rejects(tools.get('fs_list').run({ path: '..' }), /outside workspace/);
});

test('default request budget compacts long history without changing persisted evidence', async t => {
  const { server, requests } = await setup(t, (_body, count) => count <= 10
    ? tool(`read-${count}`, 'fs_read', { path: 'large.txt' })
    : { role: 'assistant', content: 'Read the fixture.' });
  fs.writeFileSync(path.join(server.architect.workspaceDir, 'large.txt'), 'x'.repeat(15000));
  const result = await server.providerAgent.execute({ goalText: 'Read the fixture ten times for this regression test.' });
  assert.equal(result.context.maxChars, 80000);
  assert.equal(result.context.compacted, true);
  assert.ok(result.context.sentChars + result.context.reservedChars <= 80000);
  assert.ok(JSON.stringify(server.providerAgent.current.messages).length > 100000);
  assert.ok(JSON.stringify(requests.at(-1).body.messages).length < 80000);
});

async function setup(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-provider-agent-'));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, headers: req.headers, url: req.url });
    const message = await respond(body, requests.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'local-response', model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const server = createV5Server({ dataDir: root });
  const providers = server.architect.providers;
  await providers.configureProvider({ providerId: 'opencode-go', apiKey: 'local-test-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  providers.selectModel({ providerId: 'opencode-go', modelId: 'deepseek-v4-pro', allowManualFallback: true });
  t.after(async () => { await server.providerAgent.close(); if (server.server.listening) await server.stop(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, requests, server };
}

test('PARTIAL browser work retains its filled form for the next goal and visible override appears in trace', async t => {
  if (!(await browserBinary())) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const portal = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<input id="name"><h1>Retained form fixture</h1>');
  });
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${portal.address().port}`;
  const { server, requests } = await setup(t, (_body, count) => {
    if (count === 1) return tool('open', 'browser_open', { url: origin, headless: true });
    if (count === 2) return tool('fill', 'browser_fill', { selector: '#name', value: 'Preserved Name' });
    if (count === 4) return tool('inspect', 'browser_inspect', {});
    return { role: 'assistant', content: 'Form prepared.' };
  });
  t.after(async () => { await server.providerAgent.close(); portal.closeAllConnections(); await new Promise(resolve => portal.close(resolve)); });
  server.providerAgent.browserVisible = true;
  server.architect.files.enableOwnerMode({ lanes: ['files', 'browser'], folders: [server.architect.workspaceDir] });
  server.architect.files.grantBrowserOrigins([origin]);
  const first = await server.providerAgent.execute({ goalText: 'Prepare this form, do not submit.' });
  assert.equal(first.status, 'PARTIAL');
  assert.equal(server.providerAgent.hasRetainedBrowserDriver(), true);
  assert.ok(first.trace.some(row => row.type === 'tool_call_started' && /headless=false/.test(row.args)));
  await server.providerAgent.execute({ goalText: 'Inspect the existing form only.' });
  assert.match(JSON.stringify(requests.at(-1).body.messages), /Preserved Name/);
});
const tool = (id, name, args, reasoning_content) => ({ role: 'assistant', content: null, reasoning_content,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('actual HTTP transport advertises tools, executes a failure/recovery loop and preserves DeepSeek reasoning/session headers', async t => {
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('read-missing', 'fs_read', { path: 'result.txt' }, 'local fixture protocol continuation');
    if (count === 2) return tool('write-result', 'fs_write', { path: 'result.txt', content: 'verified fixture' });
    if (count === 3) return tool('read-result', 'fs_read', { path: 'result.txt' });
    return { role: 'assistant', content: 'Created result.txt and read it back.' };
  });
  const { url } = await server.start();
  const response = await fetch(url + '/api/v5/goal', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalText: 'Create result.txt containing verified fixture', criteria: [{ kind: 'file', path: 'result.txt', contains: 'verified fixture' }] }) });
  const result = await response.json();
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'result.txt'), 'utf8'), 'verified fixture');
  assert.deepEqual(result.tool_results.map(row => row.ok), [false, true, true]);
  assert.equal(requests.length, 4);
  assert(requests[0].body.tools.some(t => t.function.name === 'fs_write'));
  assert(!requests[0].body.tools.some(t => t.function.name === 'shell_run'), 'no process tool without owner grant');
  assert.equal(requests[0].headers.authorization, 'Bearer local-test-key');
  assert.match(requests[0].headers['user-agent'], /majin-v5/);
  assert.equal(new Set(requests.map(r => r.headers['x-opencode-session'])).size, 1);
  assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').reasoning_content, 'local fixture protocol continuation');
  assert.equal(requests[1].body.messages.find(m => m.role === 'assistant').tool_calls[0].function.name, 'fs_read');
  assert.equal(requests[1].body.messages.find(m => m.role === 'tool').name, 'fs_read');
  assert(requests[1].body.messages.some(m => m.role === 'tool' && /failed/.test(m.content)));
  assert.equal(result.verification_evidence.length, 1);
  const assistant = server.providerAgent.current.messages.find(m => m.tool_calls?.length);
  assert.equal(responsesInput([assistant])[0].arguments, '{"path":"result.txt"}');
  assert.deepEqual(toAnthropic([assistant]).messages[0].content[0].input, { path: 'result.txt' });
});
test('object-form tool arguments from a gateway dialect execute and verify end-to-end', async t => {
  // Some OpenAI-compatible gateways return `arguments` as a parsed object
  // instead of a JSON string. The loop must execute the call, not fail it
  // as INVALID_TOOL_CALL on "[object Object]".
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return { role: 'assistant', content: null,
      tool_calls: [{ id: 'write-object-args', type: 'function', function: { name: 'fs_write', arguments: { path: 'dialect.txt', content: 'object args executed' } } }] };
    return { role: 'assistant', content: 'Created dialect.txt.' };
  });
  const { url } = await server.start();
  const response = await fetch(url + '/api/v5/goal', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalText: 'Create dialect.txt containing object args executed', criteria: [{ kind: 'file', path: 'dialect.txt', contains: 'object args executed' }] }) });
  const result = await response.json();
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'dialect.txt'), 'utf8'), 'object args executed');
  assert.deepEqual(result.tool_results.map(row => row.ok), [true]);
  // The replayed history on the second request must carry string arguments.
  const replayed = requests[1].body.messages.find(m => m.role === 'assistant' && m.tool_calls?.length);
  assert.equal(typeof replayed.tool_calls[0].function.arguments, 'string');
  assert.deepEqual(JSON.parse(replayed.tool_calls[0].function.arguments), { path: 'dialect.txt', content: 'object args executed' });
});

test('progressive tool exposure caps the advertised catalog and activates discovered bridge tools on demand', async t => {
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('search-hash', 'tools_search', { query: 're.hash', limit: 5 });
    if (count === 2) return tool('hash-before-activation', 're_hash', { path: 'sample.bin' });
    if (count === 3) return tool('activate-hash', 'tools_activate', { names: ['re.hash'] });
    if (count === 4) return tool('hash-sample', 're_hash', { path: 'sample.bin' });
    if (count === 5) return tool('write-proof', 'fs_write', { path: 'exposure-proof.txt', content: 'verified exposure' });
    return { role: 'assistant', content: 'Activated and used re.hash, then created the proof.' };
  });
  fs.writeFileSync(path.join(server.architect.workspaceDir, 'sample.bin'), 'progressive exposure sample');
  server.architect.files.enableOwnerMode({ folders: [server.architect.workspaceDir] });

  const result = await server.providerAgent.execute({
    goalText: 'Hash sample.bin and create exposure-proof.txt',
    criteria: [{ kind: 'file', path: 'exposure-proof.txt', contains: 'verified exposure' }],
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(requests.length, 6);
  const advertised = (request) => new Set(request.body.tools.map((item) => item.function?.name || item.name));
  assert.ok(requests[0].body.tools.length <= 64, `first catalog must be capped, got ${requests[0].body.tools.length}`);
  assert.ok(advertised(requests[0]).has('tools_search'));
  assert.ok(advertised(requests[0]).has('tools_activate'));
  assert.ok(advertised(requests[0]).has('fs_write'));
  assert.equal(advertised(requests[0]).has('re_hash'), false, 'non-core bridge tools start hidden in a large catalog');
  assert.ok(advertised(requests[3]).has('re_hash'), 'activation must expose re_hash in the next model round');
  assert.deepEqual(result.toolExposure.activated, ['re_hash']);
  assert.ok(result.tool_results.some((row) => row.tool === 're_hash' && !row.ok && row.errorCode === 'TOOL_NOT_ACTIVATED'));
  assert.ok(result.tool_results.some((row) => row.tool === 're_hash' && row.ok), 'same args may run after activation');
});

test('a successful write and model claim do not fabricate task verification or XP', async t => {
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write', 'fs_write', { path: 'unverified.txt', content: 'anything' })
    : { role: 'assistant', content: 'Everything verified, give me XP.' });
  const result = await server.providerAgent.execute({ goalText: 'Create a report' });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.xp_award, null); assert.equal(result.verification_evidence.length, 0);
});

test('bare goal can register locked model criteria, fail independent verification, repair and complete', async t => {
  const { requests, server } = await setup(t, (body, count) => {
    if (count === 1) return tool('register-criteria', 'goal_criteria', { criteria: [
      { kind: 'file', path: 'bare-proof.txt', contains: 'bare verified' },
      { kind: 'http', url: 'https://example.com/proof', contains: 'ungranted network proof' },
      { kind: 'dom', url: 'https://example.com/proof', selector: '#proof', executablePath: '/tmp/not-allowed' },
    ] });
    if (count === 2) {
      assert.match(JSON.stringify(body.messages), /No criteria were locked because at least one proposed check was rejected/);
      return tool('register-file-criterion', 'goal_criteria', { criteria: [{ kind: 'file', path: 'bare-proof.txt', contains: 'bare verified' }] });
    }
    if (count === 3) return tool('write-wrong-proof', 'fs_write', { path: 'bare-proof.txt', content: 'wrong content' });
    if (count === 4) return { role: 'assistant', content: 'Done.' };
    if (count === 5) {
      assert.match(JSON.stringify(body.messages), /Host independent verification failed/);
      return tool('write-correct-proof', 'fs_write', { path: 'bare-proof.txt', content: 'bare verified' });
    }
    return { role: 'assistant', content: 'Created and repaired bare-proof.txt.' };
  });

  const result = await server.providerAgent.execute({ goalText: 'Create bare-proof.txt containing bare verified' });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.criteria_source, 'model');
  assert.deepEqual(result.criteria, [{ kind: 'file', path: 'bare-proof.txt', contains: 'bare verified' }], 'the revised all-valid canonical criterion set is locked');
  assert.equal(result.adaptive.verificationFailures, 1);
  assert.equal(result.verification_evidence.length, 1);
  assert.equal(result.tool_results.filter((row) => row.tool === 'goal_criteria' && row.ok).length, 2);
  assert.ok(result.trace.some((event) => event.type === 'criteria_registered' && event.source === 'model' && event.rejected.length === 0));
  assert.match(JSON.stringify(requests[1].body.messages), /requires an owner-granted lane/);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'bare-proof.txt'), 'utf8'), 'bare verified');
});

test('model criteria cannot replace owner-supplied acceptance criteria', async t => {
  const ownerCriteria = [{ kind: 'file', path: 'owner-proof.txt', contains: 'owner verified' }];
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('try-weaken-criteria', 'goal_criteria', { criteria: [{ kind: 'file', path: 'other.txt', contains: 'anything' }] });
    if (count === 2) return tool('write-owner-proof', 'fs_write', { path: 'owner-proof.txt', content: 'owner verified' });
    return { role: 'assistant', content: 'Created the owner proof.' };
  });

  const result = await server.providerAgent.execute({ goalText: 'Create owner-proof.txt', criteria: ownerCriteria });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.criteria_source, 'owner');
  assert.deepEqual(result.criteria, ownerCriteria);
  assert.match(JSON.stringify(requests[1].body.messages), /owner-supplied acceptance criteria are locked/);
  assert.equal(result.trace.some((event) => event.type === 'criteria_registered'), false);
});
test('conversation survives restart and uses a stable Go session ID without replaying an append', async t => {
  const { server, requests } = await setup(t, (_body, count) => count === 1
    ? tool('append', 'fs_write', { path: 'once.txt', content: 'once', append: true })
    : { role: 'assistant', content: 'Observed the previous result.' });
  await server.providerAgent.execute({ goalText: 'Append once' });
  const restored = new ProviderAgent({ architect: server.architect });
  await restored.execute({ goalText: 'What was the previous result?' });
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'once.txt'), 'utf8'), 'once');
  assert.equal(new Set(requests.map(r => r.headers['x-opencode-session'])).size, 1);
  const reference = requests.at(-1).body.messages.find(m => m.role === 'user' && String(m.content).startsWith('Historical context'));
  assert.match(reference.content, /fs_write/);
  assert.match(reference.content, /once/);
});
test('repeated failed actions are observed and stopped rather than blindly executed', async t => {
  const { server } = await setup(t, (_body, count) => tool(`missing-${count}`, 'fs_read', { path: 'does-not-exist' }));
  const result = await server.providerAgent.execute({ goalText: 'Read a missing file' });
  assert.equal(result.status, 'BLOCKED');
  assert(result.tool_results.some(r => r.errorCode === 'REPEATED_FAILED_ACTION'));
});

test('resume after restart preserves identity, criteria, costs and observed effects; completed resume is idempotent', async t => {
  const { server, requests } = await setup(t, (_body, count) => {
    if (count === 1) return tool('same-provider-id', 'fs_write', { path: 'once.txt', content: 'once', append: true });
    if (count === 2) return tool('same-provider-id', 'fs_write', { path: 'ready.txt', content: 'ready' });
    return { role: 'assistant', content: 'Finished from the checkpoint.' };
  });
  server.providerAgent.maxRounds = 1;
  const criteria = [{ kind: 'file', path: 'ready.txt', contains: 'ready' }];
  const initial = await server.providerAgent.execute({ goalText: 'Append once and create ready.txt', criteria });
  assert.equal(initial.status, 'BLOCKED');
  const restored = new ProviderAgent({ architect: server.architect });
  const result = await restored.execute({ resume: true });
  assert.equal(result.goal_id, initial.goal_id);
  assert.equal(result.objective, initial.objective);
  assert.deepEqual(result.criteria, criteria);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.tool_results.length, 2);
  assert.equal(result.cost.modelCalls, 3);
  assert.equal(result.resume_count, 1);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'once.txt'), 'utf8'), 'once');
  assert.notEqual(result.tool_results[0].operationId, result.tool_results[1].operationId);
  assert.equal(new Set(requests.map(r => r.headers['x-opencode-session'])).size, 1);
  const completed = await restored.execute({ resume: true });
  assert.equal(completed.goal_id, initial.goal_id);
  assert.equal(requests.length, 3, 'completed resume makes no model or tool calls');
  await assert.rejects(restored.execute({ resume: true, criteria: [] }), /cannot replace saved acceptance/);
});

test('HTTP resume retains saved acceptance checks when the request omits criteria', async t => {
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write', 'fs_write', { path: 'proof.txt', content: 'proof' })
    : { role: 'assistant', content: 'Read the saved result.' });
  const { url } = await server.start();
  server.providerAgent.maxRounds = 1;
  const original = await server.providerAgent.execute({ goalText: 'Create proof.txt', criteria: [{ kind: 'file', path: 'proof.txt', contains: 'proof' }] });
  server.providerAgent.maxRounds = 32;
  const response = await fetch(url + '/api/v5/goal/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const { goal } = await response.json();
  assert.equal(goal.goal_id, original.goal_id);
  assert.equal(goal.status, 'COMPLETED');
  assert.equal(goal.verification_evidence.length, 1);
});
test('independent http and file verification repairs a premature completion claim', async t => {
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return { role: 'assistant', content: 'Done already.' };
    if (count === 2) return tool('write-http-proof', 'fs_write', { path: 'http-proof.txt', content: 'http verified' });
    return { role: 'assistant', content: 'Created the proof; the endpoint now reports it.' };
  });
  const proofPath = path.join(server.architect.workspaceDir, 'http-proof.txt');
  const state = http.createServer((_req, res) => {
    const ready = fs.existsSync(proofPath) && fs.readFileSync(proofPath, 'utf8').includes('http verified');
    res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(ready ? 'STATE READY http verified' : 'STATE WAITING');
  });
  await new Promise(resolve => state.listen(0, '127.0.0.1', resolve));
  t.after(async () => { state.closeAllConnections?.(); await new Promise(resolve => state.close(resolve)); });
  const result = await server.providerAgent.execute({
    goalText: 'Create http-proof.txt so the local state endpoint reports ready',
    criteria: [
      { kind: 'http', url: `http://127.0.0.1:${state.address().port}/state`, status: 200, contains: 'STATE READY' },
      { kind: 'file', path: 'http-proof.txt', contains: 'http verified' },
    ],
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.verification_evidence.map(item => item.kind), ['http', 'file']);
  assert.equal(result.verification_evidence[0].status, 200);
  assert.equal(result.verification_evidence[0].contains, 'STATE READY');
  assert.equal(result.adaptive.verificationFailures, 1);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1].body.messages), /Host independent verification failed/);
});

test('independent json verification repairs a premature completion claim', async t => {
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('write-wrong-json', 'fs_write', { path: 'result.json', content: JSON.stringify({ result: { status: 'waiting', count: 1 } }) });
    if (count === 2) return { role: 'assistant', content: 'Done.' };
    if (count === 3) return tool('write-right-json', 'fs_write', { path: 'result.json', content: JSON.stringify({ result: { status: 'ready', count: 2 } }) });
    return { role: 'assistant', content: 'Fixed the structured result.' };
  });
  const result = await server.providerAgent.execute({
    goalText: 'Write result.json with result.status ready and result.count 2',
    criteria: [
      { kind: 'json', path: 'result.json', pointer: 'result.status', equals: 'ready' },
      { kind: 'json', path: 'result.json', pointer: 'result.count', equals: 2 },
    ],
  });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.deepEqual(result.verification_evidence.map((item) => item.kind), ['json', 'json']);
  assert.equal(result.verification_evidence[0].pointer, 'result.status');
  assert.equal(result.verification_evidence[0].value, 'ready');
  assert.equal(result.adaptive.verificationFailures, 1);
  assert.equal(requests.length, 4);
  assert.match(JSON.stringify(requests[2].body.messages), /Host independent verification failed/);
});

test('bare goal can lock a model-registered json criterion and complete on host evidence', async t => {
  const { server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('register-json-criterion', 'goal_criteria', { criteria: [{ kind: 'json', path: 'structured.json', pointer: 'answer.value', equals: 42 }] });
    if (count === 2) return tool('write-structured-json', 'fs_write', { path: 'structured.json', content: JSON.stringify({ answer: { value: 42 } }) });
    return { role: 'assistant', content: 'Wrote the structured answer.' };
  });
  const result = await server.providerAgent.execute({ goalText: 'Write structured.json so answer.value is 42' });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.criteria_source, 'model');
  assert.deepEqual(result.criteria, [{ kind: 'json', path: 'structured.json', pointer: 'answer.value', equals: 42 }]);
  assert.equal(result.verification_evidence[0].kind, 'json');
  assert.equal(result.verification_evidence[0].value, 42);
});

test('independent memory verification repairs a premature remembered claim', async t => {
  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return { role: 'assistant', content: 'I have remembered your city.' };
    if (count === 2) return tool('remember-city', 'majin_memory', { action: 'remember', kind: 'preference', key: 'owner.city', text: 'Owner lives in Stockholm.', tags: ['city'] });
    return { role: 'assistant', content: 'Stored the city in long-term memory.' };
  });
  const result = await server.providerAgent.execute({
    goalText: 'Remember that I live in Stockholm',
    criteria: [{ kind: 'memory', memoryKind: 'preference', key: 'owner.city', contains: 'Stockholm' }],
  });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.verification_evidence[0].kind, 'memory');
  assert.equal(result.verification_evidence[0].memoryKind, 'preference');
  assert.equal(result.verification_evidence[0].key, 'owner.city');
  assert.equal(result.verification_evidence[0].rememberedBy, 'model');
  assert.equal(result.adaptive.verificationFailures, 1);
  assert.equal(server.architect.memoryStore.get('preference', 'owner.city')?.text, 'Owner lives in Stockholm.');
  assert.match(JSON.stringify(requests[1].body.messages), /Host independent verification failed/);
});

test('bare goal can lock a model-registered memory criterion without persisting host paths', async t => {
  const { server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('register-memory-criterion', 'goal_criteria', { criteria: [{ kind: 'memory', memoryKind: 'project', key: 'garden.plan', equals: 'Plant tomatoes in May.' }] });
    if (count === 2) return tool('remember-garden', 'majin_memory', { action: 'remember', kind: 'project', key: 'garden.plan', text: 'Plant tomatoes in May.' });
    return { role: 'assistant', content: 'Remembered the garden plan.' };
  });
  const result = await server.providerAgent.execute({ goalText: 'Remember to plant tomatoes in May' });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result.criteria_source, 'model');
  assert.deepEqual(result.criteria, [{ kind: 'memory', memoryKind: 'project', key: 'garden.plan', equals: 'Plant tomatoes in May.' }]);
  assert.equal(JSON.stringify(result.criteria).includes('storeDir'), false, 'host paths must never be locked into stored criteria');
  assert.equal(result.verification_evidence[0].kind, 'memory');
});

test('trace argument summaries never leak secrets, file contents or URL tokens', () => {
  const summary = summariseToolArgs({
    path: 'report.txt',
    content: 'x'.repeat(500),
    password: 'hunter2-never-print',
    apiKey: 'sk-never-print',
    url: 'https://example.com/callback?token=abc123secret#frag',
    selector: '#submit',
    count: 3,
  });
  assert.match(summary, /path=report\.txt/);
  assert.match(summary, /content=<500 chars>/);
  assert.match(summary, /password=\[redacted\]/);
  assert.match(summary, /apiKey=\[redacted\]/);
  assert.match(summary, /url=https:\/\/example\.com\/callback/);
  assert.match(summary, /selector=#submit/);
  assert.doesNotMatch(summary, /hunter2|sk-never-print|abc123secret|xxxx/);
  assert.equal(summariseToolArgs(null), '');
  assert.equal(summariseToolArgs('not-an-object'), '');
});

test('persisted trace records strategy, tool lifecycle and verification repair without argument values', async t => {
  const secretBody = 'trace-private-body-7f3a';
  const { server } = await setup(t, (_body, count) => {
    if (count === 1) return { role: 'assistant', content: 'Done already.' };
    if (count === 2) return tool('write-trace-proof', 'fs_write', { path: 'trace-proof.txt', content: `trace verified ${secretBody}` });
    return { role: 'assistant', content: 'Created the proof file.' };
  });
  const result = await server.providerAgent.execute({
    goalText: 'Create trace-proof.txt',
    criteria: [{ kind: 'file', path: 'trace-proof.txt', contains: 'trace verified' }],
  });
  assert.equal(result.status, 'COMPLETED');
  const types = result.trace.map((event) => event.type);
  const expectedOrder = ['goal_started', 'mode_selected', 'model_round_started', 'verification_started', 'verification_failed', 'repair_requested', 'tool_call_started', 'tool_call_finished', 'verification_passed', 'verification_completed', 'goal_finished'];
  let cursor = -1;
  for (const type of expectedOrder) {
    const index = types.indexOf(type, cursor + 1);
    assert.ok(index > cursor, `trace must contain ${type} in order; got ${types.join(',')}`);
    cursor = index;
  }
  assert.ok(result.trace.every((event, index) => event.seq === index + 1), 'trace sequence numbers must be strictly increasing for live cursors');
  const started = result.trace.find((event) => event.type === 'tool_call_started');
  assert.equal(started.tool, 'fs_write');
  assert.match(started.args, /path=trace-proof\.txt/);
  assert.match(started.args, /content=<\d+ chars>/);
  const finished = result.trace.find((event) => event.type === 'tool_call_finished');
  assert.equal(finished.ok, true);
  assert.equal(typeof finished.durationMs, 'number');
  assert.equal(typeof result.tool_results[0].durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(result.trace), new RegExp(secretBody));
  assert.doesNotMatch(JSON.stringify(result.tool_results), new RegExp(secretBody));
  const onDisk = JSON.parse(fs.readFileSync(path.join(server.architect.dataDir, 'provider-agent', 'current.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk.goal.trace) && onDisk.goal.trace.length >= expectedOrder.length, 'trace must persist in the checkpoint for logs/resume');
});

test('parallel delegation runs inside the provider loop and streams worker lifecycle into the trace', async t => {
  let parentCalls = 0;
  const workerName = (body) => /Read (alpha|beta)\.txt/.exec(JSON.stringify(body.messages))?.[1];
  const { server } = await setup(t, (body) => {
    const isWorker = JSON.stringify(body.messages?.[0]?.content || '').includes('bounded read-only MAJIN research worker');
    if (isWorker) {
      const name = workerName(body);
      if (!body.messages.some((message) => message.role === 'tool')) {
        return tool(`worker-read-${name}`, 'fs_read', { path: `${name}.txt` });
      }
      return { role: 'assistant', content: `Observed ${name} content from a parallel worker.` };
    }
    parentCalls += 1;
    if (parentCalls === 1) return tool('delegate-observe', 'agent_delegate', {
      tasks: [
        { id: 'alpha', task: 'Read alpha.txt and report its observed content.' },
        { id: 'beta', task: 'Read beta.txt and report its observed content.' },
      ],
      reason: 'The two files are independent sources that can be observed in parallel.',
    });
    if (parentCalls === 2) return tool('write-delegation-proof', 'fs_write', { path: 'delegation-proof.txt', content: 'delegation observed both sources' });
    return { role: 'assistant', content: 'Both workers reported; proof saved.' };
  });
  const workspace = server.architect.workspaceDir;
  fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'alpha-source-proof');
  fs.writeFileSync(path.join(workspace, 'beta.txt'), 'beta-source-proof');
  server.architect.files.enableOwnerMode({ lanes: ['files'], folders: [workspace] });
  const result = await server.providerAgent.execute({
    goalText: 'Observe alpha.txt and beta.txt in parallel, then save delegation-proof.txt',
    criteria: [{ kind: 'file', path: 'delegation-proof.txt', contains: 'delegation observed' }],
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.delegation.batches.length, 1);
  assert.equal(result.delegation.batches[0].status, 'COMPLETED');
  assert.equal(result.delegation.batches[0].concurrency, 3);
  const types = result.trace.map((event) => event.type);
  const delegateStart = result.trace.findIndex((event) => event.type === 'tool_call_started' && event.tool === 'agent_delegate');
  const batchStart = types.indexOf('delegate_batch_started');
  const batchFinish = types.indexOf('delegate_batch_finished');
  const delegateFinish = result.trace.findIndex((event) => event.type === 'tool_call_finished' && event.tool === 'agent_delegate');
  assert.ok(delegateStart > -1 && batchStart > delegateStart, `batch must start inside the delegate tool call: ${types.join(',')}`);
  assert.ok(batchFinish > batchStart && delegateFinish > batchFinish, `batch must finish before the delegate tool call returns: ${types.join(',')}`);
  assert.deepEqual(result.trace[batchStart].tasks, ['alpha', 'beta']);
  assert.equal(result.trace.filter((event) => event.type === 'delegate_task_finished' && event.status === 'COMPLETED').length, 2);
  assert.ok(result.tool_results.some((row) => row.delegated && row.tool === 'fs_read' && row.ok));
});

test('independent pixel verification can complete a mixed-criteria goal', async t => {
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write-pixel-receipt', 'fs_write', { path: 'pixel-receipt.txt', content: 'pixel receipt' })
    : { role: 'assistant', content: 'Wrote the receipt for the generated image.' });
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 12; png.data[i + 1] = 34; png.data[i + 2] = 56; png.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(server.architect.workspaceDir, 'proof.png'), PNG.sync.write(png));
  const result = await server.providerAgent.execute({
    goalText: 'Write pixel-receipt.txt for the verified image artifact',
    criteria: [
      { kind: 'pixel', pngPath: 'proof.png', rgba: [12, 34, 56, 255], tolerance: 0, minHits: 16 },
      { kind: 'file', path: 'pixel-receipt.txt', contains: 'pixel receipt' },
    ],
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.verification_evidence.map(item => item.kind), ['pixel', 'file']);
  assert.equal(result.verification_evidence[0].hits, 16);
});

test('unsupported acceptance criteria cannot be skipped into a completed goal', async t => {
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write-partial-proof', 'fs_write', { path: 'partial-proof.txt', content: 'partial proof' })
    : { role: 'assistant', content: 'Wrote the file.' });
  const result = await server.providerAgent.execute({
    goalText: 'Write partial-proof.txt and satisfy every listed acceptance check',
    criteria: [
      { kind: 'file', path: 'partial-proof.txt', contains: 'partial proof' },
      { kind: 'crystal-ball', omen: 'success' },
    ],
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.errorCode, 'UNVERIFIABLE_ACCEPTANCE_CRITERIA');
  assert.equal(result.verification_evidence.length, 0);
  assert.match(result.blocker, /unsupported verifier kind: crystal-ball/);
});

test('independent dom verification can complete a browser-visible outcome', async t => {
  if (!(await browserBinary())) { t.skip('no local browser binary'); return; }
  const { server } = await setup(t, (_body, count) => count === 1
    ? tool('write-dom-proof', 'fs_write', { path: 'dom-proof.txt', content: 'dom verified' })
    : { role: 'assistant', content: 'The page now shows the verified state.' });
  const proofPath = path.join(server.architect.workspaceDir, 'dom-proof.txt');
  const pageServer = http.createServer((_req, res) => {
    const ready = fs.existsSync(proofPath) && fs.readFileSync(proofPath, 'utf8').includes('dom verified');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><main><div id="state">${ready ? 'DOM READY dom verified' : 'DOM WAITING'}</div></main>`);
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { pageServer.closeAllConnections?.(); await new Promise(resolve => pageServer.close(resolve)); });
  const result = await server.providerAgent.execute({
    goalText: 'Create dom-proof.txt so the local page shows the ready state',
    criteria: [
      { kind: 'dom', url: `http://127.0.0.1:${pageServer.address().port}/`, selector: '#state', expectText: 'DOM READY' },
      { kind: 'file', path: 'dom-proof.txt', contains: 'dom verified' },
    ],
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.verification_evidence.map(item => item.kind), ['dom', 'file']);
  assert.match(result.verification_evidence[0].text, /DOM READY/);
});

test('403 access policy is distinguished from an invalid API key', () => {
  assert.equal(classifyProviderError(new Error('Region not allowed'), 403).code, 'ACCESS_DENIED');
  assert.equal(classifyProviderError(new Error('Invalid API key'), 401).code, 'AUTH_INVALID');
});

test('verified procedural memory is discoverable and reusable after reconstruction without storing argument values', async t => {
  let name;
  const { server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('first-write', 'fs_write', { path: 'first.txt', content: 'private-value-never-in-procedure' });
    if (count === 2) return { role: 'assistant', content: 'First file created.' };
    if (count === 3) return tool('lookup', 'procedures_search', { query: 'file' });
    if (count === 4) return tool('activate', 'procedures_read', { name });
    if (count === 5) return tool('second-write', 'fs_write', { path: 'second.txt', content: 'new-value' });
    return { role: 'assistant', content: 'Reused the method for a new file.' };
  });
  const first = await server.providerAgent.execute({ goalText: 'Write a file', criteria: [{ kind: 'file', path: 'first.txt', contains: 'private-value-never-in-procedure' }] });
  assert.equal(first.status, 'COMPLETED');
  const disk = fs.readFileSync(path.join(server.architect.dataDir, 'learned-procedures.json'), 'utf8');
  assert(!disk.includes('private-value-never-in-procedure'));
  assert(!disk.includes('first.txt'));
  const stored = JSON.parse(disk).procedures[0]; name = stored.procedureId;
  assert.deepEqual(stored.steps[0].argKeys, ['content','path']);
  const restartedServer = createV5Server({ dataDir: server.architect.dataDir });
  const second = await restartedServer.providerAgent.execute({ goalText: 'Reuse a file method', criteria: [{ kind: 'file', path: 'second.txt', contains: 'new-value' }] });
  assert.equal(second.status, 'COMPLETED');
  assert.deepEqual(second.tool_results.map(x => x.tool), ['procedures_search','procedures_read','fs_write']);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'second.txt'), 'utf8'), 'new-value');
  const foundResult = restartedServer.providerAgent.current.messages.filter(x => x.role === 'tool' && x.name === 'procedures_search').at(-1);
  assert(JSON.parse(foundResult.content).result.procedures.some(x => x.name === name));
  assert(!restartedServer.architect.learning.state.procedures.some(x => x.steps.some(s => s.tool.startsWith('procedures_'))));
});

test('stop aborts a live provider request before its proposed file action can execute', async t => {
  let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const { server } = await setup(t, async () => {
    entered();
    await new Promise(resolve => setTimeout(resolve, 200));
    return tool('too-late', 'fs_write', { path: 'should-not-exist.txt', content: 'late' });
  });
  const running = server.providerAgent.execute({ goalText: 'Wait for a model action' });
  await requested;
  await server.providerAgent.cancel();
  const result = await running;
  assert.equal(result.status, 'CANCELLED');
  assert.equal(fs.existsSync(path.join(server.architect.workspaceDir, 'should-not-exist.txt')), false);
  assert.equal(server.providerAgent.active, null);
});

test('a catalog without capability metadata does not silently disable tools; explicit false is respected', async t => {
  const { server } = await setup(t, () => ({ role: 'assistant', content: 'ok' }));
  server.architect.providers.fetchImpl = async () => new Response(JSON.stringify({ data: [
    { id: 'deepseek-v4-pro' }, { id: 'text-only', capabilities: { tools: false } },
  ] }), { headers: { 'content-type': 'application/json' } });
  const result = await server.architect.providers.discoverCatalog('opencode-go');
  assert.equal(result.ok, true);
  assert.equal(server.architect.providers.getCapabilities('opencode-go', 'deepseek-v4-pro').tools, true);
  assert.equal(server.architect.providers.getCapabilities('opencode-go', 'text-only').tools, false);
});

test('blocked browser submit waits for an exact owner origin grant, then resumes the same filled page to a verified portal receipt', async t => {
  if (!(await browserBinary())) { t.skip('No installed Chromium/Edge on this runner'); return; }

  let portalOrigin = '';
  let received = null;
  const marker = `retained-${Date.now()}`;
  const portal = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      received = { name: form.get('name'), marker: form.get('marker') };
      res.setHeader('content-type', 'text/html');
      res.end('<h1>PORTAL RECEIVED</h1>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<h1>Application portal</h1><form method="post" action="/submit">
      <label>Name <input name="name" required></label>
      <label>Marker <input name="marker" required></label>
      <button type="submit">Send application</button>
    </form>`);
  });
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  portalOrigin = `http://127.0.0.1:${portal.address().port}`;
  t.after(async () => {
    portal.closeAllConnections();
    await new Promise(resolve => portal.close(resolve));
  });

  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('open-portal', 'browser_open', { url: portalOrigin });
    if (count === 2) return tool('fill-name', 'browser_fill', { selector: 'input[name="name"]', value: 'Ada Lovelace' });
    if (count === 3) return tool('fill-marker', 'browser_fill', { selector: 'input[name="marker"]', value: marker });
    if (count === 4) return tool('submit-before-grant', 'browser_click', { selector: 'button[type="submit"]' });
    if (count === 5) return tool('inspect-after-grant', 'browser_inspect', {});
    if (count === 6) return tool('submit-after-grant', 'browser_click', { selector: 'button[type="submit"]' });
    if (count === 7) return tool('inspect-receipt', 'browser_inspect', {});
    if (count === 8) return tool('write-receipt', 'fs_write', { path: 'browser-receipt.txt', content: `Portal receipt for Ada Lovelace ${marker}` });
    return { role: 'assistant', content: 'Submitted the retained form and observed the portal receipt.' };
  });
  server.architect.files.enableOwnerMode({
    lanes: ['files', 'browser'],
    folders: [server.architect.workspaceDir],
  });

  const criteria = [{ kind: 'file', path: 'browser-receipt.txt', contains: marker }];
  const initial = await server.providerAgent.execute({
    goalText: `Open ${portalOrigin}, fill the form for Ada Lovelace with marker ${marker}, submit it, and save browser-receipt.txt`,
    criteria,
  });
  const waiting = JSON.parse(JSON.stringify(initial));

  assert.equal(waiting.status, 'WAITING_USER', JSON.stringify(waiting));
  assert.equal(waiting.errorCode, 'BROWSER_ORIGIN_GRANT_REQUIRED');
  assert.equal(waiting.browser_handoff.kind, 'BROWSER_ORIGIN');
  assert.equal(waiting.browser_handoff.origin, portalOrigin);
  assert.equal(waiting.browser_handoff.browserSessionRetained, true);
  assert.equal(waiting.browser_handoff.toolExecuted, false);
  assert.equal(waiting.browser_handoff.externalEffectMayHaveOccurred, false);
  assert.equal(waiting.browser_handoff.visibleBrowser, false);
  assert.equal(received, null, 'nothing may reach the portal before the owner grant');
  assert.equal(requests.length, 4, 'the provider loop must stop immediately at the handoff');
  assert.equal(server.providerAgent.hasRetainedBrowserDriver(), true);
  assert.deepEqual(waiting.adaptive.failedActions, [], 'a no-effect blocked submit must not poison the identical retry after grant');
  assert.equal(waiting.tool_results.at(-1).errorCode, 'BROWSER_ORIGIN_GRANT_REQUIRED');

  server.architect.files.grantBrowserOrigins([`${portalOrigin}/submit`]);
  const resumed = await server.providerAgent.execute({ resume: true, goalText: 'The owner granted the exact origin. Inspect the preserved page and submit it once.' });

  assert.equal(resumed.status, 'COMPLETED', JSON.stringify(resumed));
  assert.equal(resumed.browser_handoff, undefined);
  assert.equal(resumed.last_browser_handoff.origin, portalOrigin);
  assert.ok(resumed.last_browser_handoff.resumed_at);
  assert.deepEqual(received, { name: 'Ada Lovelace', marker }, 'the resumed run submitted the already-filled page without reopening or refilling it');
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'browser-receipt.txt'), 'utf8'), `Portal receipt for Ada Lovelace ${marker}`);
  assert.equal(server.providerAgent.hasRetainedBrowserDriver(), false, 'a completed goal releases the retained browser driver');
  const clicks = resumed.tool_results.filter(row => row.tool === 'browser_click');
  assert.equal(clicks.length, 2);
  assert.equal(clicks[0].ok, false);
  assert.equal(clicks[1].ok, true, 'the identical submit is allowed after the owner grant');
  assert.equal(requests.length, 9);
  assert.ok(requests[4].body.messages.some(message => String(message.content || '').includes('the owner resumed after a browser handoff')));
  assert.ok(requests[4].body.messages.some(message => String(message.content || '').includes('The blocked browser action was not executed')));
});

test('visible login and CAPTCHA signals pause immediately for the owner without asking the model to enter secrets', async t => {
  if (!(await browserBinary())) { t.skip('No installed Chromium/Edge on this runner'); return; }

  let loginOrigin = '';
  const portal = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<h1>Sign in</h1>
      <form method="post">
        <label>Email <input name="email" autocomplete="username"></label>
        <label>Password <input type="password" name="password" autocomplete="current-password"></label>
        <p>Complete CAPTCHA verification to continue.</p>
        <div class="g-recaptcha" data-sitekey="test" style="width:300px;height:80px">CAPTCHA</div>
        <button type="submit">Sign in</button>
      </form>`);
  });
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  loginOrigin = `http://127.0.0.1:${portal.address().port}`;
  t.after(async () => {
    portal.closeAllConnections();
    await new Promise(resolve => portal.close(resolve));
  });

  const { requests, server } = await setup(t, (_body, count) => {
    if (count === 1) return tool('open-login', 'browser_open', { url: loginOrigin });
    return tool('must-not-run', 'browser_fill', { selector: 'input[type="password"]', value: 'must-never-be-entered' });
  });
  server.architect.files.enableOwnerMode({ lanes: ['browser'], folders: [server.architect.workspaceDir] });

  try {
    const result = await server.providerAgent.execute({ goalText: `Open ${loginOrigin} and continue past sign-in` });
    assert.equal(result.status, 'WAITING_USER', JSON.stringify(result));
    assert.equal(result.errorCode, 'BROWSER_OWNER_HANDOFF_REQUIRED');
    assert.equal(result.browser_handoff.kind, 'CAPTCHA');
    assert.equal(result.browser_handoff.origin, loginOrigin);
    assert.equal(result.browser_handoff.toolExecuted, true, 'browser_open completed before the handoff signal was observed');
    assert.equal(result.browser_handoff.externalEffectMayHaveOccurred, false);
    assert.equal(result.browser_handoff.browserSessionRetained, true);
    assert.ok(result.browser_handoff.signals.some(signal => /password/i.test(signal)));
    assert.equal(requests.length, 1, 'no further model round may run after a login/CAPTCHA handoff is detected');
    assert.deepEqual(result.tool_results.map(row => row.tool), ['browser_open']);
    assert.equal(server.providerAgent.hasRetainedBrowserDriver(), true);
  } finally {
    await server.providerAgent.close();
  }
  assert.equal(server.providerAgent.hasRetainedBrowserDriver(), false);
});

test('provider loop streams output, runs secret-safe host tools, and uses recalled memory in a verified artifact', async t => {
  const marker = 'HOST-LOOP-MEMORY-731';
  const { requests, server } = await setup(t, (body, count) => {
    if (count === 1) return tool('host-status', 'majin_status', { detail: 'summary' });
    if (count === 2) return tool('host-doctor', 'majin_doctor', {});
    if (count === 3) return tool('host-provider', 'majin_provider', { action: 'list' });
    if (count === 4) return tool('host-memory', 'majin_memory', { action: 'read', kind: 'project', query: marker });
    if (count === 5) {
      const observed = JSON.stringify(body.messages).match(/HOST-LOOP-MEMORY-\d+/)?.[0];
      return tool('host-write', 'fs_write', { path: 'host-tools-proof.txt', content: `host tools verified ${observed || 'MISSING'}` });
    }
    return { role: 'assistant', content: 'Host state inspected and the recalled marker was written to the proof file.' };
  });
  server.architect.memoryStore.put('project', {
    key: 'host-loop-marker',
    text: `The provider-loop release marker is ${marker}.`,
    tags: ['host-loop'],
    importance: 0.9,
  });

  const result = await server.providerAgent.execute({
    goalText: 'Inspect MAJIN host state, recall the project marker, and write it to host-tools-proof.txt',
    criteria: [{ kind: 'file', path: 'host-tools-proof.txt', contains: marker }],
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.deepEqual(result.tool_results.map((row) => row.tool), ['majin_status', 'majin_doctor', 'majin_provider', 'majin_memory', 'fs_write']);
  assert.ok(result.tool_results.every((row) => row.ok));
  assert.equal(requests.length, 6);
  assert.ok(requests.every((request) => request.body.stream === true), 'the V5 provider path must request streaming when a trace consumer is attached');
  const advertised = new Set(requests[0].body.tools.map((item) => item.function?.name || item.name));
  for (const name of ['majin_status', 'majin_doctor', 'majin_provider', 'majin_memory']) assert.ok(advertised.has(name), `${name} must be advertised`);
  assert.ok(result.trace.some((event) => event.type === 'model_tool_started' && event.tool === 'majin_status'));
  assert.ok(result.trace.some((event) => event.type === 'model_output_delta' && /Host state inspected/.test(event.text)));
  const modelVisible = JSON.stringify(requests.map((request) => request.body.messages));
  assert.doesNotMatch(modelVisible, /local-test-key|maskedKey/);
  assert.doesNotMatch(JSON.stringify(result.trace), /local-test-key|maskedKey/);
});

test('bounded provider context preserves atomic tool turns, the original goal and the latest steering', () => {
  const messages = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'ORIGINAL GOAL: finish the long task' },
  ];
  for (let index = 0; index < 24; index++) {
    const id = `call-${index}`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: `${index}.txt`, padding: 'x'.repeat(700) }) } }],
    });
    messages.push({ role: 'tool', tool_call_id: id, name: 'fs_read', content: `OBSERVATION-${index} ${'y'.repeat(700)}` });
  }
  messages.push({ role: 'user', content: 'LATEST STEERING: write the final proof now' });
  const before = structuredClone(messages);
  const goal = {
    objective: 'finish the long task',
    criteria: [{ kind: 'file', path: 'proof.txt' }],
    tool_results: Array.from({ length: 24 }, (_, index) => ({ tool: 'fs_read', ok: true, operationId: `op-${index}` })),
    verification_evidence: [],
    adaptive: { mode: 'direct' },
  };

  const bounded = buildBoundedProviderMessages(messages, { goal, maxChars: 12000, reservedChars: 1000 });

  assert.deepEqual(messages, before, 'context bounding must never rewrite the persisted conversation');
  assert.equal(bounded.stats.compacted, true);
  assert.ok(bounded.stats.sentChars + bounded.stats.reservedChars <= bounded.stats.maxChars, JSON.stringify(bounded.stats));
  assert.ok(bounded.messages.some((message) => String(message.content || '').includes('ORIGINAL GOAL')));
  assert.ok(bounded.messages.some((message) => String(message.content || '').includes('LATEST STEERING')));
  assert.ok(bounded.messages.some((message) => String(message.content || '').startsWith('Host context checkpoint:')));
  assert.ok(!bounded.messages.some((message) => String(message.content || '').includes('OBSERVATION-0 ')), 'oldest observations should be omitted first');
  const callIds = new Set();
  for (const message of bounded.messages) {
    for (const call of message.tool_calls || []) callIds.add(call.id);
    if (message.role === 'tool') assert.ok(callIds.has(message.tool_call_id), `orphaned tool result ${message.tool_call_id}`);
  }

  const roomy = buildBoundedProviderMessages(messages, { goal, maxChars: 10_000_000, reservedChars: 1000 });
  assert.equal(roomy.stats.compacted, false);
  assert.equal(roomy.messages, messages);
});

test('a long real provider conversation compacts old tool observations but keeps the full saved checkpoint', async t => {
  const { requests, server } = await setup(t, (body, count) => {
    if (count <= 8) return tool(`read-big-${count - 1}`, 'fs_read', { path: `big-${count - 1}.txt` });
    if (count === 9) {
      const sent = JSON.stringify(body.messages);
      const compacted = sent.includes('Host context checkpoint:') && !sent.includes('SEGMENT-0 ') && sent.includes('SEGMENT-7 ');
      return tool('write-context-proof', 'fs_write', {
        path: 'context-proof.txt',
        content: compacted ? 'context compacted and completed' : 'context was not compacted correctly',
      });
    }
    return { role: 'assistant', content: 'Finished the long reading task from the bounded context.' };
  });
  for (let index = 0; index < 8; index++) {
    fs.writeFileSync(
      path.join(server.architect.workspaceDir, `big-${index}.txt`),
      `SEGMENT-${index} ${String.fromCharCode(65 + index).repeat(12_000)}`,
    );
  }
  server.providerAgent.contextCharBudget = 70_000;

  const result = await server.providerAgent.execute({
    goalText: 'Read big-0.txt through big-7.txt, then create context-proof.txt',
    criteria: [{ kind: 'file', path: 'context-proof.txt', contains: 'context compacted and completed' }],
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(requests.length, 10);
  const compactedRequest = JSON.stringify(requests[8].body.messages);
  assert.match(compactedRequest, /Host context checkpoint:/);
  assert.doesNotMatch(compactedRequest, /SEGMENT-0 /);
  assert.match(compactedRequest, /SEGMENT-7 /);
  assert.ok(result.trace.some((event) => event.type === 'context_compacted' && event.omittedMessages > 0));
  assert.equal(result.context.compacted, true);
  assert.ok(JSON.stringify(server.providerAgent.current.messages).includes('SEGMENT-0 '), 'the persisted full conversation must remain available for resume');
});


test('narration-only first turn gets one review and can execute a verified action without owner tool instructions', async t => {
  const { server, requests } = await setup(t, (body, count) => {
    if (count === 1) return { role: 'assistant', content: 'Jag sätter igång nu. Först registrerar jag kontroller.' };
    if (count === 2) {
      assert.match(body.messages.at(-1).content, /no tool calls have executed/);
      return tool('criteria-after-review', 'goal_criteria', { criteria: [{ kind: 'file', path: 'action.txt', contains: 'executed' }] });
    }
    if (count === 3) return tool('write-after-review', 'fs_write', { path: 'action.txt', content: 'executed' });
    return { role: 'assistant', content: 'Created action.txt.' };
  });
  const result = await server.providerAgent.execute({ goalText: 'Create action.txt containing executed.' });
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(requests.length, 4);
  assert.equal(fs.readFileSync(path.join(server.architect.workspaceDir, 'action.txt'), 'utf8'), 'executed');
  assert.equal(result.verification_evidence.length, 1);
  assert.equal(result.trace.filter(e => e.type === 'no_action_review_requested').length, 1);
});

test('persistent prose-only replies stop after one review without invented tool work or verification', async t => {
  const { server, requests } = await setup(t, () => ({ role: 'assistant', content: 'Kör. Först verktygskatalogen.' }));
  const result = await server.providerAgent.execute({ goalText: 'Find my CV on this computer.' });
  assert.equal(requests.length, 2);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.tool_results.length, 0);
  assert.equal(result.verification_evidence.length, 0);
});

test('a greeting or essential clarification can remain conversational after the bounded review', async t => {
  const { server, requests } = await setup(t, () => ({ role: 'assistant', content: 'Hej! Vilken stad gäller det?' }));
  const result = await server.providerAgent.execute({ goalText: 'Hej, hjälp mig hitta något i närheten.' });
  assert.equal(requests.length, 2);
  assert.equal(result.tool_results.length, 0);
  assert.equal(result.model_reply, 'Hej! Vilken stad gäller det?');
  assert.match(requests[1].body.messages.at(-1).content, /tool use is not required for conversation/);
});

test('new goals replace stale instructions and archive old observations while retaining a bounded reference', async t => {
  const { server, requests } = await setup(t, () => ({ role: 'assistant', content: 'Which task do you want to test?' }));
  const agent = server.providerAgent;
  agent.current = { conversationId: 'old-session', goal: { goal_id: 'old-goal', objective: 'Prepare Fellowmind application', status: 'PARTIAL', summaryText: 'Draft saved as application.md', criteria: [] }, messages: [
    { role: 'system', content: 'OBSOLETE_INSTRUCTIONS: require approval for every website' },
    { role: 'user', content: 'OLD_ACTION: prepare the application' },
    { role: 'assistant', content: 'OLD_LARGE_OBSERVATION ' + 'x'.repeat(100000) },
  ] };
  server.architect.files.ownerMode.grant({ lanes: ['files', 'browser'], fullAccess: true });
  await agent.execute({ goalText: 'What is saved from the last task?' });
  const sent = JSON.stringify(requests[0].body.messages);
  assert.doesNotMatch(sent, /OBSOLETE_INSTRUCTIONS|OLD_ACTION|OLD_LARGE_OBSERVATION/);
  assert.match(sent, /application.md/);
  assert.match(sent, /Previous goal reference only/);
  assert.match(sent, /Full HTTP\(S\) browser write access is already granted/);
  assert.ok(sent.length < 16000);
  const archived = JSON.parse(fs.readFileSync(path.join(agent.dir, 'history', 'old-goal.json')));
  assert.match(JSON.stringify(archived.messages), /OLD_LARGE_OBSERVATION/);
});

test('resume preserves observed dialogue but refreshes instructions and current browser grants', async t => {
  const { server, requests } = await setup(t, () => ({ role: 'assistant', content: 'No further action requested.' }));
  const agent = server.providerAgent;
  await agent.execute({ goalText: 'Hello' });
  agent.current.messages.unshift({ role: 'system', content: 'OBSOLETE_SYSTEM' });
  agent.current.messages.push({ role: 'assistant', content: 'PRESERVE_THIS_OBSERVATION' });
  server.architect.files.ownerMode.grant({ lanes: ['files', 'browser'], fullAccess: true });
  await agent.execute({ resume: true, goalText: 'Summarize the saved state' });
  let sent = JSON.stringify(requests.at(-1).body.messages);
  assert.doesNotMatch(sent, /OBSOLETE_SYSTEM/); assert.match(sent, /PRESERVE_THIS_OBSERVATION/);
  assert.match(sent, /Full HTTP\(S\) browser write access is already granted/);
  server.architect.files.revokeBrowserOrigins();
  await agent.execute({ resume: true, goalText: 'Summarize again' });
  sent = JSON.stringify(requests.at(-1).body.messages);
  assert.doesNotMatch(sent, /Full HTTP\(S\) browser write access is already granted/);
  assert.match(sent, /required origin is missing/);
});
