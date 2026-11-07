/**
 * WP9 — installed-CLI real-task acceptance gauntlet.
 *
 * Every scenario drives the shipped `bin/majin-v5.mjs` as a separate process
 * against a live (scripted but reactive) provider endpoint, real local HTTP
 * sources, the real filesystem, the real shell and — where a browser binary
 * exists — the real browser. The fake model decides its next step from the
 * tool observations in the conversation (or from on-disk effects), never
 * from knowledge of the expected answers, and MAJIN's host verifier must
 * independently prove each acceptance criterion before COMPLETED.
 *
 * Coverage: multi-family research+synthesis (web/files), shell+RE
 * cross-verified computation, hard-kill recovery with exactly-once effects,
 * safety refusal + strategy change, browser DOM+pixel proof, and parallel
 * delegation through the installed CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProviderManager } from '../../src/v5/providers.js';
import { browserBinary } from '../../src/v4/tools/host.js';

const BIN = fileURLToPath(new URL('../../bin/majin-v5.mjs', import.meta.url));

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  } catch { /* the child may have exited between the check and the kill */ }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-acceptance-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { root, dataDir, workspace };
}

function runCli(args, { root, timeoutMs = 180000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      detached: process.platform !== 'win32',
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root, MAJIN_HOME: path.join(root, 'majin-home'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`CLI timed out: ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`expected JSON stdout, got status=${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(predicate, description, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function startCliSession(args, { root, timeoutMs = 300000, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    detached: process.platform !== 'win32',
    env: { ...process.env, HOME: root, USERPROFILE: root, MAJIN_HOME: path.join(root, 'majin-home'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const session = { child, stdout: '', stderr: '', status: null, waiters: new Set(), closed: null };
  const matches = (waiter) => typeof waiter.pattern === 'string'
    ? session[waiter.stream].includes(waiter.pattern)
    : waiter.pattern.test(session[waiter.stream]);
  const notify = () => {
    for (const waiter of [...session.waiters]) {
      if (!matches(waiter)) continue;
      session.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };
  child.stdout.on('data', (chunk) => { session.stdout += chunk; notify(); });
  child.stderr.on('data', (chunk) => { session.stderr += chunk; notify(); });
  const timer = setTimeout(() => killProcessTree(child), timeoutMs);
  session.closed = new Promise((resolve, reject) => {
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      session.status = status;
      for (const waiter of session.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`CLI exited (${status}) before output matched ${waiter.pattern}\nSTDOUT:\n${session.stdout}\nSTDERR:\n${session.stderr}`));
      }
      session.waiters.clear();
      resolve({ status, stdout: session.stdout, stderr: session.stderr });
    });
  });
  session.write = (line) => {
    assert.equal(child.stdin.writable, true, `CLI stdin is not writable\nSTDOUT:\n${session.stdout}\nSTDERR:\n${session.stderr}`);
    child.stdin.write(`${line}\n`);
  };
  session.waitFor = (pattern, stream = 'stdout', waitMs = 60000) => {
    const waiter = { pattern, stream, resolve: null, reject: null, timer: null };
    if (matches(waiter)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        session.waiters.delete(waiter);
        killProcessTree(child);
        reject(new Error(`timed out waiting for ${pattern} in ${stream}\nSTDOUT:\n${session.stdout}\nSTDERR:\n${session.stderr}`));
      }, waitMs);
      session.waiters.add(waiter);
    });
  };
  session.terminate = () => killProcessTree(child);
  session.exit = async () => {
    if (child.stdin.writable) session.write('/exit');
    const fallback = setTimeout(() => killProcessTree(child), 60000);
    fallback.unref?.();
    return session.closed.finally(() => clearTimeout(fallback));
  };
  return session;
}

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

async function fakeProvider(t, respond) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', tools: true }] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ body, headers: req.headers, url: req.url, method: req.method });
    try {
      const message = await respond(body, requests.length);
      if (res.destroyed) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'acceptance-response',
        model: body.model,
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }));
    } catch {
      if (!res.destroyed) { res.statusCode = 500; res.end('{}'); }
    }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { requests, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
}

async function configureProvider(dataDir, baseUrl) {
  const providers = new ProviderManager({ dataDir });
  await providers.configureProvider({ providerId: 'opencode-go', apiKey: 'local-test-key', baseUrl });
  providers.selectModel({ providerId: 'opencode-go', modelId: 'deepseek-v4-pro', allowManualFallback: true });
}

const observedText = (body) => JSON.stringify(body.messages || []);
const findToken = (body, pattern) => pattern.exec(observedText(body))?.[0] || null;

test('acceptance: research across web + files is synthesised and independently verified (http + file criteria)', async (t) => {
  const fx = fixture(t);
  const stamp = Date.now();
  const alphaFact = `ALPHA-FACT-${stamp}`;
  const betaFact = `BETA-FACT-${stamp}`;
  const noteFact = `NOTE-FACT-${stamp}`;
  const source = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    if (req.url === '/alpha') res.end(`Research alpha reports ${alphaFact} today.`);
    else if (req.url === '/beta') res.end(`Research beta confirms ${betaFact} independently.`);
    else { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => { source.closeAllConnections?.(); await new Promise((resolve) => source.close(resolve)); });
  const alphaUrl = `http://127.0.0.1:${source.address().port}/alpha`;
  const betaUrl = `http://127.0.0.1:${source.address().port}/beta`;
  fs.writeFileSync(path.join(fx.workspace, 'notes.txt'), `Local field note: ${noteFact}`);

  const provider = await fakeProvider(t, (body) => {
    const alpha = findToken(body, /ALPHA-FACT-\d+/);
    const beta = findToken(body, /BETA-FACT-\d+/);
    const note = findToken(body, /NOTE-FACT-\d+/);
    const wrote = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'fs_write');
    if (!alpha) return toolCall('fetch-alpha', 'web_fetch', { url: alphaUrl });
    if (!beta) return toolCall('fetch-beta', 'web_fetch', { url: betaUrl });
    if (!note) return toolCall('read-notes', 'fs_read', { path: 'notes.txt' });
    if (!wrote) return toolCall('write-report', 'fs_write', { path: 'report.txt', content: `Combined report\nAlpha: ${alpha}\nBeta: ${beta}\nNote: ${note}\n` });
    return { role: 'assistant', content: 'Synthesised the three observed sources into report.txt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([
    { kind: 'http', url: alphaUrl, status: 200, contains: alphaFact },
    { kind: 'file', path: 'report.txt', contains: alphaFact },
    { kind: 'file', path: 'report.txt', contains: betaFact },
    { kind: 'file', path: 'report.txt', contains: noteFact },
  ]);
  const run = await runCli(['run', 'Research the two web sources and my notes.txt, then write report.txt combining all three facts',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'web,files'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Verification evidence: 4/);
  assert.match(run.stderr, /tool web_fetch started/);
  assert.match(run.stderr, /tool fs_read started/);
  assert.match(run.stderr, /verified http /);
  const report = fs.readFileSync(path.join(fx.workspace, 'report.txt'), 'utf8');
  for (const fact of [alphaFact, betaFact, noteFact]) assert.ok(report.includes(fact), `report must contain observed fact ${fact}: ${report}`);
});

test('acceptance: shell computation and RE hashing cross-verify each other through the installed CLI', async (t) => {
  const fx = fixture(t);
  const payload = Buffer.from(`cross-verify-payload-${Date.now()}-${'x'.repeat(64)}`);
  fs.writeFileSync(path.join(fx.workspace, 'input.bin'), payload);
  const expectedSha = createHash('sha256').update(payload).digest('hex');
  const provider = await fakeProvider(t, (body) => {
    const toolResults = (body.messages || []).filter((message) => message.role === 'tool');
    const hashes = [...new Set(observedText(body).match(/[a-f0-9]{64}/g) || [])].filter((hash) => hash === expectedSha);
    const called = (body.messages || []).flatMap((message) => (message.tool_calls || []).map((call) => call.function?.name));
    if (!called.includes('re_hash')) return toolCall('hash-re', 're_hash', { path: 'input.bin' });
    if (!called.includes('shell_run')) {
      return toolCall('hash-shell', 'shell_run', {
        command: 'node -e "const c=require(\'crypto\'),f=require(\'fs\');console.log(c.createHash(\'sha256\').update(f.readFileSync(\'input.bin\')).digest(\'hex\'))"',
      });
    }
    if (!called.includes('fs_write')) {
      const verdict = toolResults.length >= 2 && hashes.length === 1 ? `MATCH ${hashes[0]}` : 'MISMATCH';
      return toolCall('write-verdict', 'fs_write', { path: 'verdict.txt', content: verdict });
    }
    return { role: 'assistant', content: 'Compared the RE hash with the shell-computed hash and recorded the verdict.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'verdict.txt', contains: `MATCH ${expectedSha}` }]);
  const run = await runCli(['run', 'Hash input.bin with the RE tool and again via a shell node command; write MATCH plus the hash to verdict.txt only if they agree',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'shell,re,files'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stderr, /tool re_hash ok/);
  assert.match(run.stderr, /tool shell_run ok/);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'verdict.txt'), 'utf8'), `MATCH ${expectedSha}`);
});

test('acceptance: hard-killed CLI resumes in a new process without replaying the completed effect', async (t) => {
  const fx = fixture(t);
  const step1Path = path.join(fx.workspace, 'step1.txt');
  const step2Path = path.join(fx.workspace, 'step2.txt');
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let gateEntered = false;
  let gateArmed = true;
  const writeCalls = [];
  const provider = await fakeProvider(t, async () => {
    // Disk-driven script: always do the first not-yet-observed step. This is
    // exactly what a real model sees after a crash — checkpointed effects.
    if (!fs.existsSync(step1Path)) {
      writeCalls.push('step1.txt');
      return toolCall('write-step1', 'fs_write', { path: 'step1.txt', content: 'step one done' });
    }
    if (!fs.existsSync(step2Path)) {
      if (gateArmed) { gateArmed = false; gateEntered = true; await gate; }
      writeCalls.push('step2.txt');
      return toolCall('write-step2', 'fs_write', { path: 'step2.txt', content: 'step two done' });
    }
    return { role: 'assistant', content: 'Both steps are done.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([
    { kind: 'file', path: 'step1.txt', contains: 'step one done' },
    { kind: 'file', path: 'step2.txt', contains: 'step two done' },
  ]);
  const session = startCliSession(['chat', '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files'], fx);
  t.after(() => session.terminate());
  await session.waitFor('Type a goal', 'stdout', 60000);
  session.write('Write step1.txt then step2.txt');
  await waitForCondition(() => gateEntered && fs.existsSync(step1Path), 'step one completed and the second model call in flight', 120000);
  // Hard kill the whole CLI tree mid-goal (no graceful pause/shutdown).
  session.terminate();
  await session.closed;
  releaseGate();
  assert.equal(fs.existsSync(step2Path), false, 'step two must not have executed before the kill');

  const resumed = await runCli(['resume', '--data-dir', fx.dataDir, '--lanes', 'files', '--json'], fx);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  const goal = parseJson(resumed).goal;
  assert.equal(goal.status, 'COMPLETED');
  assert.equal(fs.readFileSync(step1Path, 'utf8'), 'step one done');
  assert.equal(fs.readFileSync(step2Path, 'utf8'), 'step two done');
  assert.equal(writeCalls.filter((name) => name === 'step1.txt').length, 1,
    'the completed step must never be re-proposed after a hard kill (the lost in-flight step two proposal is re-issued once on resume)');
  const traceTypes = (goal.trace || []).map((event) => event.type);
  assert.ok(traceTypes.includes('goal_resumed'), `trace must record the cross-process resume: ${traceTypes.join(',')}`);
  assert.equal(goal.trace.filter((event) => event.type === 'tool_call_started' && event.tool === 'fs_write' && String(event.args).includes('path=step1.txt')).length, 1,
    'step one must execute exactly once across both processes');
  assert.equal(goal.trace.filter((event) => event.type === 'tool_call_finished' && event.tool === 'fs_write' && event.ok).length, 2);
});

test('acceptance: workspace-escape write is refused and the agent recovers inside the boundary', async (t) => {
  const fx = fixture(t);
  let calls = 0;
  const provider = await fakeProvider(t, () => {
    calls += 1;
    if (calls === 1) return toolCall('escape-write', 'fs_write', { path: '../escape.txt', content: 'must never land outside' });
    if (calls === 2) return toolCall('safe-write', 'fs_write', { path: 'safe.txt', content: 'recovered inside workspace' });
    return { role: 'assistant', content: 'The escape was refused; wrote safely inside the workspace instead.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'safe.txt', contains: 'recovered inside workspace' }]);
  const run = await runCli(['run', 'Write the recovery note to safe.txt in the workspace',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.equal(fs.existsSync(path.join(fx.dataDir, 'escape.txt')), false, 'escape write must not land in the data dir');
  assert.equal(fs.existsSync(path.join(fx.root, 'escape.txt')), false, 'escape write must not land in the fixture root');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'safe.txt'), 'utf8'), 'recovered inside workspace');
  const failedAt = run.stderr.indexOf('tool fs_write failed');
  const okAt = run.stderr.indexOf('tool fs_write ok');
  assert.ok(failedAt > -1 && okAt > failedAt, `trace must show refusal then recovery:\n${run.stderr}`);
  assert.match(run.stderr, /strategy: recover/);
});

test('acceptance: bare installed-CLI goal registers model criteria and finishes host-verified without owner JSON', async (t) => {
  const fx = fixture(t);
  const token = `BARE-CLI-VERIFIED-${Date.now()}`;
  let calls = 0;
  const provider = await fakeProvider(t, () => {
    calls += 1;
    if (calls === 1) return toolCall('bare-register-criteria', 'goal_criteria', { criteria: [{ kind: 'file', path: 'bare-cli-proof.txt', contains: token }] });
    if (calls === 2) return toolCall('bare-write-proof', 'fs_write', { path: 'bare-cli-proof.txt', content: token });
    if (calls === 3) return toolCall('bare-read-proof', 'fs_read', { path: 'bare-cli-proof.txt' });
    return { role: 'assistant', content: 'Created and read back the bare-goal proof file.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);

  const run = await runCli(['run', `Create bare-cli-proof.txt containing exactly ${token}`, '--data-dir', fx.dataDir, '--lanes', 'files'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Acceptance criteria source: model/);
  assert.match(run.stderr, /acceptance criteria registered by model and locked by host: file bare-cli-proof\.txt/);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'bare-cli-proof.txt'), 'utf8'), token);
  const goal = parseJson(await runCli(['logs', '--data-dir', fx.dataDir, '--json'], fx)).goal;
  assert.equal(goal.criteria_source, 'model');
  assert.deepEqual(goal.criteria, [{ kind: 'file', path: 'bare-cli-proof.txt', contains: token }]);
  assert.equal(goal.verification_evidence.length, 1);
});

test('acceptance: parallel delegation through the installed CLI feeds a verified summary', async (t) => {
  const fx = fixture(t);
  const stamp = Date.now();
  const facts = { one: `FACT-ONE-${stamp}`, two: `FACT-TWO-${stamp}`, three: `FACT-THREE-${stamp}` };
  for (const [name, fact] of Object.entries(facts)) {
    fs.writeFileSync(path.join(fx.workspace, `${name}.txt`), `Source ${name} states ${fact}`);
  }
  const parentTools = [];
  const provider = await fakeProvider(t, (body) => {
    const isWorker = String(body.messages?.[0]?.content || '').includes('bounded read-only MAJIN research worker');
    if (isWorker) {
      const name = /(one|two|three)\.txt/.exec(observedText(body))?.[1];
      const fact = findToken(body, /FACT-(ONE|TWO|THREE)-\d+/);
      if (!fact) return toolCall(`worker-read-${name}`, 'fs_read', { path: `${name}.txt` });
      return { role: 'assistant', content: `Observed ${fact} in ${name}.txt` };
    }
    const called = (body.messages || []).flatMap((message) => (message.tool_calls || []).map((call) => call.function?.name));
    parentTools.push(...called.filter((name) => !parentTools.includes(name)));
    if (!called.includes('agent_delegate')) {
      return toolCall('delegate-sources', 'agent_delegate', {
        tasks: Object.keys(facts).map((name) => ({ id: name, task: `Read ${name}.txt and report the FACT token it states.` })),
        reason: 'Three independent source files can be observed concurrently by read-only workers.',
      });
    }
    if (!called.includes('fs_write')) {
      const found = [...new Set(observedText(body).match(/FACT-(ONE|TWO|THREE)-\d+/g) || [])];
      const content = found.length === 3 ? `Delegated summary: ${found.join(' ')}` : 'INCOMPLETE';
      return toolCall('write-summary', 'fs_write', { path: 'summary.txt', content });
    }
    return { role: 'assistant', content: 'Workers observed all sources; summary saved.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify(Object.values(facts).map((fact) => ({ kind: 'file', path: 'summary.txt', contains: fact })));
  const run = await runCli(['run', 'Observe one.txt, two.txt and three.txt in parallel and write summary.txt with all three FACT tokens',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stderr, /delegating 3 independent subtask\(s\)/);
  assert.match(run.stderr, /delegate one completed/);
  assert.match(run.stderr, /delegation completed/);
  const summary = fs.readFileSync(path.join(fx.workspace, 'summary.txt'), 'utf8');
  for (const fact of Object.values(facts)) assert.ok(summary.includes(fact), `summary must contain delegated fact ${fact}: ${summary}`);
  assert.ok(!parentTools.includes('fs_read'), `parent must not read the sources itself: ${parentTools}`);
});

test('acceptance: browser page outcome is proven by DOM + pixel + file criteria through the installed CLI', async (t) => {
  const browserPath = await browserBinary();
  if (!browserPath) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const fx = fixture(t);
  const stamp = Date.now();
  const page = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body style="margin:0"><div style="width:100vw;height:100vh;background:rgb(12,34,56)"><h1 id="state" style="color:#fff">ACCEPTANCE READY ${stamp}</h1></div></body>`);
  });
  await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
  t.after(async () => { page.closeAllConnections?.(); await new Promise((resolve) => page.close(resolve)); });
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;
  let calls = 0;
  const provider = await fakeProvider(t, () => {
    calls += 1;
    if (calls === 1) return toolCall('open-page', 'browser_open', { url: pageUrl });
    if (calls === 2) return toolCall('shot-page', 'browser_shot', { path: 'shots/acceptance.png' });
    if (calls === 3) return toolCall('write-receipt', 'fs_write', { path: 'browser-receipt.txt', content: `browser acceptance ${stamp}` });
    return { role: 'assistant', content: 'Page opened, screenshot saved, receipt written.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([
    { kind: 'dom', url: pageUrl, selector: '#state', expectText: `ACCEPTANCE READY ${stamp}` },
    { kind: 'pixel', pngPath: 'shots/acceptance.png', rgba: [12, 34, 56, 255], tolerance: 2, minHits: 1000 },
    { kind: 'file', path: 'browser-receipt.txt', contains: `browser acceptance ${stamp}` },
  ]);
  const run = await runCli(['run', `Open ${pageUrl}, screenshot it to shots/acceptance.png and write browser-receipt.txt`,
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files,browser', '--browser-headless'],
  { ...fx, timeoutMs: 300000, env: { MAJIN_V4_BROWSER: browserPath } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Verification evidence: 3/);
  assert.match(run.stdout, /verified dom /);
  assert.match(run.stdout, /verified pixel .*matching pixels/);
  assert.ok(fs.existsSync(path.join(fx.workspace, 'shots', 'acceptance.png')));
});

test('acceptance: browser download and tab switch through the installed CLI are proven by file + hash criteria', async (t) => {
  const browserPath = await browserBinary();
  if (!browserPath) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const fx = fixture(t);
  const stamp = Date.now();
  const payload = Buffer.from(`CLI-DOWNLOAD-${stamp} exact bytes`);
  const payloadSha = createHash('sha256').update(payload).digest('hex');
  const page = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="report.txt"');
      res.end(payload);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/second') {
      res.end(`<!doctype html><h1 id="state">SECOND TAB ${stamp}</h1>`);
      return;
    }
    res.end(`<!doctype html><h1>FIRST TAB</h1><a id="dl" href="/file">Download report</a> <a id="tablink" href="/second" target="_blank" rel="noopener">Open second</a>`);
  });
  await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
  t.after(async () => { page.closeAllConnections?.(); await new Promise((resolve) => page.close(resolve)); });
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;
  const provider = await fakeProvider(t, (body) => {
    const done = (name) => (body.messages || []).some((message) => message.role === 'tool' && message.name === name);
    const switched = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'browser_tabs' && String(message.content).includes('/second'));
    if (!done('browser_open')) return toolCall('dl-open', 'browser_open', { url: pageUrl });
    if (!done('browser_download')) return toolCall('dl-download', 'browser_download', { selector: '#dl', path: 'downloads/report.txt' });
    if (!done('browser_click')) return toolCall('dl-tablink', 'browser_click', { selector: '#tablink' });
    if (!switched) return toolCall('dl-switch', 'browser_tabs', { action: 'switch', index: 1 });
    if (!done('fs_write')) return toolCall('dl-receipt', 'fs_write', { path: 'download-receipt.txt', content: `tabbed download ${stamp}` });
    return { role: 'assistant', content: 'Downloaded the report, switched to the second tab and wrote the receipt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([
    { kind: 'file', path: 'downloads/report.txt', contains: `CLI-DOWNLOAD-${stamp}` },
    { kind: 'file', path: 'downloads/report.txt', hash: payloadSha },
    { kind: 'file', path: 'download-receipt.txt', contains: `tabbed download ${stamp}` },
  ]);
  const run = await runCli(['run', `Open ${pageUrl}, download the report to downloads/report.txt, open and switch to the second tab, then write download-receipt.txt`,
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files,browser', '--browser-headless'],
  { ...fx, timeoutMs: 300000, env: { MAJIN_V4_BROWSER: browserPath } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Verification evidence: 3/);
  assert.match(run.stderr, /tool browser_download started/);
  assert.match(run.stderr, /tool browser_tabs started/);
  assert.deepEqual(fs.readFileSync(path.join(fx.workspace, 'downloads', 'report.txt')), payload);
});

test('acceptance: cross-origin iframe form is completed and verified through the installed CLI', async (t) => {
  const browserPath = await browserBinary();
  if (!browserPath) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const fx = fixture(t);
  const stamp = Date.now();
  const frameApp = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><h1>EMBEDDED FORM</h1><input id="city" name="city">
      <button id="go" type="button" onclick="document.getElementById('state').textContent='CITY SET '+document.getElementById('city').value">Save city</button>
      <output id="state">IDLE</output>`);
  });
  await new Promise((resolve) => frameApp.listen(0, '127.0.0.1', resolve));
  const shell = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><h1>PORTAL SHELL</h1><iframe id="app" src="http://127.0.0.1:${frameApp.address().port}/frame"></iframe>`);
  });
  await new Promise((resolve) => shell.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const srv of [shell, frameApp]) { srv.closeAllConnections?.(); await new Promise((resolve) => srv.close(resolve)); }
  });
  const pageUrl = `http://127.0.0.1:${shell.address().port}/`;
  const provider = await fakeProvider(t, (body) => {
    const done = (name) => (body.messages || []).some((message) => message.role === 'tool' && message.name === name);
    const verified = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'browser_verify' && String(message.content).includes('Verified live browser outcome'));
    if (!done('browser_open')) return toolCall('frame-open', 'browser_open', { url: pageUrl });
    if (!done('browser_fill')) return toolCall('frame-fill', 'browser_fill', { frame: '#app', selector: '#city', value: `STAMP-${stamp}` });
    if (!done('browser_click')) return toolCall('frame-click', 'browser_click', { frame: '#app', selector: '#go' });
    if (!verified) return toolCall('frame-verify', 'browser_verify', { frame: '#app', selector: '#state', text: `CITY SET STAMP-${stamp}` });
    if (!done('fs_write')) return toolCall('frame-receipt', 'fs_write', { path: 'frame-receipt.txt', content: `iframe form verified ${stamp}` });
    return { role: 'assistant', content: 'Filled and verified the embedded iframe form, then wrote the receipt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'frame-receipt.txt', contains: `iframe form verified ${stamp}` }]);
  const run = await runCli(['run', `Open ${pageUrl}, fill the city inside the embedded iframe form, save it, verify the result, and write frame-receipt.txt`,
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files,browser', '--browser-headless'],
  { ...fx, timeoutMs: 300000, env: { MAJIN_V4_BROWSER: browserPath } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stderr, /tool browser_fill started/);
  assert.match(run.stderr, /tool browser_verify started/);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'frame-receipt.txt'), 'utf8'), `iframe form verified ${stamp}`);
});

test('acceptance: model remembers a durable fact through the installed CLI and a later CLI process reads it back', async (t) => {
  const fx = fixture(t);
  const stamp = Date.now();
  const provider = await fakeProvider(t, (body) => {
    const remembered = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'majin_memory' && String(message.content).includes('owner.favourite-city'));
    const wrote = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'fs_write');
    if (!remembered) return toolCall('remember-city', 'majin_memory', { action: 'remember', kind: 'preference', key: 'owner.favourite-city', text: `Owner favourite city marker ${stamp} is Gothenburg.`, tags: ['city'] });
    if (!wrote) return toolCall('remember-receipt', 'fs_write', { path: 'remember-receipt.txt', content: `remembered ${stamp}` });
    return { role: 'assistant', content: 'Stored the favourite-city fact in long-term memory and wrote the receipt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'remember-receipt.txt', contains: `remembered ${stamp}` }]);
  const run = await runCli(['run', 'Remember that my favourite city is Gothenburg for future goals, then write remember-receipt.txt',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files'],
  { ...fx, timeoutMs: 300000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stderr, /tool majin_memory started/);

  // Independent cross-process proof: a fresh CLI invocation (new process,
  // owner surface) reads the exact entry the model stored during the goal.
  const readBack = await runCli(['memory', 'get', 'owner.favourite-city', '--kind', 'preference', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(readBack.status, 0, `${readBack.stdout}\n${readBack.stderr}`);
  const parsed = JSON.parse(readBack.stdout);
  assert.equal(parsed.entries.length, 1);
  assert.match(parsed.entries[0].text, new RegExp(`marker ${stamp} is Gothenburg`));
  assert.equal(parsed.entries[0].rememberedBy, 'model');
});

test('acceptance: installed CLI proves a remember-goal with an independent memory criterion, no receipt file', async (t) => {
  const fx = fixture(t);
  const stamp = Date.now();
  const provider = await fakeProvider(t, (body) => {
    const remembered = (body.messages || []).some((message) => message.role === 'tool' && message.name === 'majin_memory' && String(message.content).includes('owner.dog-name'));
    if (!remembered) return toolCall('remember-dog', 'majin_memory', { action: 'remember', kind: 'preference', key: 'owner.dog-name', text: `Owner dog marker ${stamp} is named Bosse.` });
    return { role: 'assistant', content: 'Stored the dog name in long-term memory.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'memory', memoryKind: 'preference', key: 'owner.dog-name', contains: `marker ${stamp} is named Bosse` }]);
  const run = await runCli(['run', 'Remember that my dog is named Bosse for future goals',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files'],
  { ...fx, timeoutMs: 300000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Verification evidence: 1/);
  assert.match(run.stdout, /verified memory /);
  assert.match(run.stderr, /tool majin_memory started/);
  assert.equal(fs.existsSync(path.join(fx.workspace, 'remember-receipt.txt')), false, 'completion must rest on the memory criterion, not a proxy file');
});

test('acceptance: a long installed-CLI task stays within a bounded model context and finishes verified', async (t) => {
  const fx = fixture(t);
  for (let index = 0; index < 8; index++) {
    fs.writeFileSync(
      path.join(fx.workspace, `context-${index}.txt`),
      `CLI-SEGMENT-${index} ${String.fromCharCode(97 + index).repeat(12_000)}`,
    );
  }
  const provider = await fakeProvider(t, (body, count) => {
    if (count <= 8) return toolCall(`read-context-${count - 1}`, 'fs_read', { path: `context-${count - 1}.txt` });
    if (count === 9) {
      const sent = observedText(body);
      const compacted = sent.includes('Host context checkpoint:')
        && !sent.includes('CLI-SEGMENT-0 ')
        && sent.includes('CLI-SEGMENT-7 ');
      return toolCall('write-context-proof', 'fs_write', {
        path: 'cli-context-proof.txt',
        content: compacted ? 'installed CLI context compacted and completed' : 'installed CLI context was not bounded correctly',
      });
    }
    return { role: 'assistant', content: 'Read all eight context files and wrote the bounded-context proof.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'cli-context-proof.txt', contains: 'installed CLI context compacted and completed' }]);
  const run = await runCli([
    'run', 'Read context-0.txt through context-7.txt, then create cli-context-proof.txt',
    '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'files', '--context-chars', '70000',
  ], { ...fx, timeoutMs: 300000 });

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Verification evidence: 1/);
  assert.match(run.stderr, /context compacted for this model request/);
  assert.match(run.stderr, /model: Read all eight context files/);
  assert.equal(provider.requests.length, 10);
  assert.ok(provider.requests.every((request) => request.body.stream === true));
  const compactedRequest = observedText(provider.requests[8].body);
  assert.match(compactedRequest, /Host context checkpoint:/);
  assert.doesNotMatch(compactedRequest, /CLI-SEGMENT-0 /);
  assert.match(compactedRequest, /CLI-SEGMENT-7 /);
  const logs = await runCli(['logs', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(logs.status, 0, `${logs.stdout}\n${logs.stderr}`);
  const goal = parseJson(logs).goal;
  assert.equal(goal.context.compacted, true);
  assert.ok(goal.trace.some((event) => event.type === 'context_compacted' && event.omittedMessages > 0));
  assert.ok(goal.trace.some((event) => event.type === 'model_output_delta' && /Read all eight context files/.test(event.text)));
});
