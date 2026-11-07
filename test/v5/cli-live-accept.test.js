import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/v5/cli-live-accept.mjs', import.meta.url));

test('installed-CLI live acceptance reports NOT VERIFIED without attempting a request when the key env is absent', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      MAJIN_LIVE_KEY_ENV: 'MAJIN_TEST_MISSING_LIVE_KEY',
      MAJIN_TEST_MISSING_LIVE_KEY: '',
    },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.verified, false);
  assert.equal(parsed.stage, 'credential');
  assert.match(parsed.error, /NOT VERIFIED/);
  assert.equal(result.stderr, '');
});

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function runScript(env, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli-live-accept timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

for (const providerId of ['opencode-go', 'deepseek']) test(`installed-CLI ${providerId} acceptance plumbing completes against a local endpoint (not live-account proof)`, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-live-plumbing-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', tools: true }] }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, headers: req.headers });
    const nonce = /MAJIN_LIVE_CLI_\d+_[0-9a-f]+/.exec(JSON.stringify(body.messages || []))?.[0];
    const toolDone = (name) => (body.messages || []).some((message) => message.role === 'tool' && message.name === name);
    let message;
    if (!nonce) message = { role: 'assistant', content: 'The goal nonce was not observed.' };
    else if (!toolDone('goal_criteria')) message = toolCall('plumb-criteria', 'goal_criteria', { criteria: [{ kind: 'file', path: 'live-proof.txt', contains: nonce }] });
    else if (!toolDone('fs_write')) message = toolCall('plumb-write', 'fs_write', { path: 'live-proof.txt', content: nonce });
    else if (!toolDone('fs_read')) message = toolCall('plumb-read', 'fs_read', { path: 'live-proof.txt' });
    else message = { role: 'assistant', content: 'Created and read back live-proof.txt.' };
    if (providerId === 'deepseek' && message.tool_calls) message.reasoning_content = 'fixture reasoning continuity';
    res.end(JSON.stringify({
      id: 'plumbing-response',
      model: body.model,
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const dummyKey = 'dummy-live-plumbing-key';
  const result = await runScript({
    MAJIN_LIVE_PROVIDER: providerId,
    MAJIN_LIVE_KEY_ENV: 'MAJIN_TEST_LIVE_KEY',
    MAJIN_TEST_LIVE_KEY: dummyKey,
    MAJIN_LIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    MAJIN_LIVE_MODEL: 'deepseek-v4-pro',
    MAJIN_LIVE_TIMEOUT_MS: '180000',
    TMPDIR: tmpRoot,
    TMP: tmpRoot,
    TEMP: tmpRoot,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.provider, providerId);
  if (providerId === 'deepseek') {
    assert.ok(requests.every(request => !request.headers['x-opencode-session']));
    assert.ok(requests.slice(1).every(request => request.body.messages.some(message => message.role === 'assistant' && message.tool_calls?.length && message.reasoning_content === 'fixture reasoning continuity')));
  }
  assert.equal(summary.verified, true);
  assert.equal(summary.baseUrlOverride, true, 'the summary must disclose that this was not the default live endpoint');
  assert.equal(summary.modelId, 'deepseek-v4-pro');
  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.criteriaSource, 'model');
  assert.ok(summary.verificationEvidence >= 1);
  assert.ok(summary.tools.includes('goal_criteria'));
  assert.ok(summary.tools.includes('fs_write'));
  assert.ok(summary.modelCalls >= 3);
  assert.doesNotMatch(result.stdout, new RegExp(dummyKey), 'the env key must never reach script output');
  assert.doesNotMatch(result.stderr, new RegExp(dummyKey), 'the env key must never reach script stderr');
  assert.ok(requests.length >= 3, `expected real model calls through the installed CLI, got ${requests.length}`);
  const ownerPrompt = requests[0].body.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Create a text file')).content;
  assert.doesNotMatch(ownerPrompt, /goal_criteria|fs_write|fs_read|tools_search/);
  assert.match(ownerPrompt, /Create a text file/);
  assert.ok(requests.every((request) => request.headers.authorization === `Bearer ${dummyKey}`), 'CLI must send the env-named key to the provider endpoint');
  assert.equal(new Set(requests.map((request) => request.headers['x-opencode-session'])).size, 1, 'OpenCode session header must be stable across the goal');
  assert.deepEqual(
    fs.readdirSync(tmpRoot).filter((name) => name.startsWith('majin-v5-cli-live-')),
    [],
    'the temporary provider state tree (including the secret file) must be removed after the run',
  );
});

test('installed-CLI live acceptance falls back to the next catalog model after a provider failure (plumbing proof, not live-account proof)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-live-fallback-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash', tools: true }, { id: 'deepseek-v4-pro', tools: true }] }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, headers: req.headers });
    if (body.model === 'glm-5.3-flash') {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: 'simulated upstream failure for glm-5.3-flash' } }));
      return;
    }
    const nonce = /MAJIN_LIVE_CLI_\d+_[0-9a-f]+/.exec(JSON.stringify(body.messages || []))?.[0];
    const toolDone = (name) => (body.messages || []).some((message) => message.role === 'tool' && message.name === name);
    let message;
    if (!nonce) message = { role: 'assistant', content: 'The goal nonce was not observed.' };
    else if (!toolDone('goal_criteria')) message = toolCall('fb-criteria', 'goal_criteria', { criteria: [{ kind: 'file', path: 'live-proof.txt', contains: nonce }] });
    else if (!toolDone('fs_write')) message = toolCall('fb-write', 'fs_write', { path: 'live-proof.txt', content: nonce });
    else if (!toolDone('fs_read')) message = toolCall('fb-read', 'fs_read', { path: 'live-proof.txt' });
    else message = { role: 'assistant', content: 'Created and read back live-proof.txt.' };
    res.end(JSON.stringify({
      id: 'fallback-response',
      model: body.model,
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const dummyKey = 'dummy-live-fallback-key';
  const result = await runScript({
    MAJIN_LIVE_KEY_ENV: 'MAJIN_TEST_LIVE_KEY',
    MAJIN_TEST_LIVE_KEY: dummyKey,
    MAJIN_LIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    MAJIN_LIVE_TIMEOUT_MS: '120000',
    MAJIN_LIVE_TOTAL_TIMEOUT_MS: '600000',
    TMPDIR: tmpRoot,
    TMP: tmpRoot,
    TEMP: tmpRoot,
  }, 600000);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.verified, true);
  assert.equal(summary.modelId, 'deepseek-v4-pro', 'the second catalog model must win after the first fails');
  assert.equal(summary.attempts.length, 2);
  assert.equal(summary.attempts[0].modelId, 'glm-5.3-flash');
  assert.equal(summary.attempts[0].ok, false);
  assert.equal(summary.attempts[1].modelId, 'deepseek-v4-pro');
  assert.equal(summary.attempts[1].ok, true);
  assert.ok(requests.some((request) => request.body.model === 'glm-5.3-flash'), 'the failing model must really have been attempted');
  assert.ok(requests.filter((request) => request.body.model === 'deepseek-v4-pro').length >= 3);
  assert.doesNotMatch(result.stdout, new RegExp(dummyKey));
  assert.deepEqual(
    fs.readdirSync(tmpRoot).filter((name) => name.startsWith('majin-v5-cli-live-')),
    [],
    'all attempt trees (including secret files) must be removed after the run',
  );
});
