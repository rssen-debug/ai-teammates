import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderManager } from '../../src/v5/providers.js';
import { browserBinary } from '../../src/v4/tools/host.js';
import { MemoryStore } from '../../src/v2/memory/store.js';

const BIN = fileURLToPath(new URL('../../bin/majin-v5.mjs', import.meta.url));

test('compact chat starts without inference and can toggle detailed output', t => {
  const { root, dataDir } = fixture(t);
  const result = spawnSync(process.execPath, [BIN, 'chat', '--compact', '--data-dir', dataDir], {
    input: 'cls\n/details\n/details\n/exit\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NO_COLOR: '1', HOME: root, USERPROFILE: root, MAJIN_HOME: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tell MAJIN what to do/);
  assert.match(result.stdout, /Detailed view enabled/);
  assert.match(result.stdout, /Compact view enabled/);
  assert.ok(!result.stdout.includes('\x1b'));
  assert.ok(!fs.existsSync(path.join(dataDir, 'provider-agent', 'current.json')));
});

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-cli-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { root, dataDir, workspace };
}

function runCli(args, { root, timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      detached: process.platform !== 'win32',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        MAJIN_HOME: path.join(root, 'majin-home'),
        ...env,
      },
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

async function waitForCondition(predicate, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function startCliSession(args, { root, timeoutMs = 120000, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      MAJIN_HOME: path.join(root, 'majin-home'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const session = {
    child,
    stdout: '',
    stderr: '',
    status: null,
    waiters: new Set(),
    closed: null,
  };
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
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
  session.waitFor = (pattern, stream = 'stdout', waitMs = 30000) => {
    const waiter = { pattern, stream, resolve: null, reject: null, timer: null };
    if (matches(waiter)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        session.waiters.delete(waiter);
        // A failed interactive assertion must not leave the CLI, its isolated
        // tool worker, or a real browser alive behind the test process.
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
      requests.push({ body: {}, headers: req.headers, url: req.url, method: req.method });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [
        { id: 'deepseek-v4-pro', tools: true },
        { id: 'deepseek-v4-flash', tools: true },
      ] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ body, headers: req.headers, url: req.url, method: req.method });
    const message = await respond(body, requests.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'cli-local-response',
      model: body.model,
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    }));
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

test('CLI grants persist, doctor reports parity, and tools call executes through the isolated driver', async (t) => {
  const fx = fixture(t);

  const help = await runCli(['help'], fx);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /majin-v5 run "Gör XYZ"/);
  assert.match(help.stdout, /tools call <tool_name>/);
  assert.match(help.stdout, /chat \[first goal\.\.\.\]/);
  assert.match(help.stdout, /grants grant/);

  const version = await runCli(['version'], fx);
  assert.equal(version.status, 0, version.stderr);
  assert.doesNotMatch(version.stdout, /undefined/);

  const granted = await runCli(['grants', 'grant', '--data-dir', fx.dataDir, '--lanes', 'files,sys,re', '--json'], fx);
  assert.equal(granted.status, 0, granted.stderr);
  const grantJson = parseJson(granted);
  assert.deepEqual(new Set(grantJson.grantedLanes), new Set(['files', 'sys', 're']));
  assert.ok(grantJson.grantedFolders.includes(fx.workspace));

  const originGranted = await runCli([
    'grants', 'browser-origin', 'grant', 'https://Employer.Example:443/apply?job=1',
    '--data-dir', fx.dataDir, '--json',
  ], fx);
  assert.equal(originGranted.status, 0, originGranted.stderr);
  const originJson = parseJson(originGranted);
  assert.deepEqual(originJson.browserWriteOrigins, ['https://employer.example']);
  assert.ok(originJson.grantedLanes.includes('browser'), 'a persisted browser origin implies the browser lane');

  const credentialOrigin = await runCli([
    'grants', 'browser-origin', 'grant', 'https://user:secret@employer.example/apply',
    '--data-dir', fx.dataDir, '--json',
  ], fx);
  assert.equal(credentialOrigin.status, 1);
  assert.match(credentialOrigin.stderr, /embedded credentials are not allowed/);

  const originList = await runCli(['grants', 'browser-origin', 'list', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(originList.status, 0, originList.stderr);
  assert.deepEqual(parseJson(originList).browserWriteOrigins, ['https://employer.example']);
  assert.equal(parseJson(originList).browserLaneGranted, true);

  const doctor = await runCli(['doctor', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = parseJson(doctor);
  assert.equal(doctorJson.toolParity.universe, 157);
  assert.ok(doctorJson.toolParity.available >= 35, `expected bridge lanes in doctor parity, got ${doctorJson.toolParity.available}`);
  assert.deepEqual(doctorJson.browser.writeOrigins, ['https://employer.example']);
  assert.equal(doctorJson.browser.visible, true);
  assert.equal(doctorJson.provider.activeModelId, null);
  assert.equal(doctorJson.toolParity.assessment, 'availability-only');
  assert.equal(doctorJson.toolParity.executionVerified, false);
  assert.equal(doctorJson.toolParity.unavailableTools.length, doctorJson.toolParity.unavailable);
  assert.ok(doctorJson.toolParity.unavailableTools.every(entry => entry.sourceName && entry.category && entry.reason));
  const inventory = parseJson(await runCli(['tools', '--data-dir', fx.dataDir, '--json'], fx));
  assert.deepEqual(doctorJson.toolParity.unavailableTools, inventory.toolParity.unavailableTools);
  const doctorText = await runCli(['doctor', '--data-dir', fx.dataDir], fx);
  assert.equal(doctorText.status, 0, doctorText.stderr);
  assert.match(doctorText.stdout, /does not execute tools/);
  for (const entry of doctorJson.toolParity.unavailableTools) {
    assert.ok(doctorText.stdout.includes(`${entry.sourceName} [${entry.category}] — ${entry.reason}`));
  }


  fs.writeFileSync(path.join(fx.workspace, 'sample.bin'), 'cli proof');
  const call = await runCli([
    'tools', 'call', 're_hash',
    '--data-dir', fx.dataDir,
    '--args', JSON.stringify({ path: 'sample.bin' }),
    '--operation-id', 'cli-test-re-hash',
    '--json',
  ], fx);
  assert.equal(call.status, 0, call.stderr);
  const callJson = parseJson(call);
  assert.equal(callJson.structuredContent.status, 'completed');
  assert.equal(callJson.structuredContent.result.meta.hashes[0].sha256.length, 64);

  const unavailable = await runCli(['tools', 'call', 'research_run', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /Tool is not available in this driver: research_run/);

  const originRevoked = await runCli([
    'grants', 'browser-origin', 'revoke', 'https://employer.example/apply',
    '--data-dir', fx.dataDir, '--json',
  ], fx);
  assert.equal(originRevoked.status, 0, originRevoked.stderr);
  assert.deepEqual(parseJson(originRevoked).browserWriteOrigins, []);
  assert.ok(parseJson(originRevoked).grantedLanes.includes('browser'), 'revoking an origin does not remove browser read access');
});

test('CLI run refuses to fake a free-form goal when no provider model is configured', async (t) => {
  const fx = fixture(t);
  const result = await runCli(['run', 'Create a file', '--data-dir', fx.dataDir], fx);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No active provider model is configured/);
  assert.match(result.stderr, /tools call/);
});

test('CLI run, bare goal form, logs and completed resume use the live provider agent end to end', async (t) => {
  const fx = fixture(t);
  const script = { round: 0, file: 'cli-proof.txt', content: 'verified cli' };
  const provider = await fakeProvider(t, () => {
    script.round += 1;
    if (script.round === 1) return toolCall('write-proof', 'fs_write', { path: script.file, content: script.content });
    return { role: 'assistant', content: `Created ${script.file}.` };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);

  const criteria = JSON.stringify([{ kind: 'file', path: 'cli-proof.txt', contains: 'verified cli' }]);
  const run = await runCli(['run', 'Create cli-proof.txt with verified cli content', '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'sys,re', '--json'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(parseJson(run).status, 'COMPLETED');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'cli-proof.txt'), 'utf8'), 'verified cli');
  assert.equal(new Set(provider.requests.map((r) => r.headers['x-opencode-session'])).size, 1);
  const advertised = new Set(provider.requests[0].body.tools.map((tool) => tool.function?.name || tool.name));
  assert.ok(advertised.has('sys_info'), 'explicit CLI sys lane must reach the live provider catalog');
  assert.ok(advertised.has('re_hash'), 'explicit CLI re lane must reach the live provider catalog');
  const grants = await runCli(['grants', 'show', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(grants.status, 0, grants.stderr);
  assert.ok(parseJson(grants).grantedLanes.includes('sys'));
  assert.ok(parseJson(grants).grantedLanes.includes('re'));

  script.round = 0;
  script.file = 'bare-proof.txt';
  script.content = 'verified bare';
  const bareCriteria = JSON.stringify([{ kind: 'file', path: 'bare-proof.txt', contains: 'verified bare' }]);
  const bare = await runCli(['Create bare-proof.txt with verified bare content', '--data-dir', fx.dataDir, '--criteria', bareCriteria, '--json'], fx);
  assert.equal(bare.status, 0, `${bare.stdout}\n${bare.stderr}`);
  assert.equal(parseJson(bare).status, 'COMPLETED');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'bare-proof.txt'), 'utf8'), 'verified bare');

  const logs = await runCli(['logs', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(logs.status, 0, logs.stderr);
  const logsJson = parseJson(logs);
  assert.equal(logsJson.goal.status, 'COMPLETED');
  assert.match(logsJson.goal.objective, /bare-proof/);
  assert.ok(logsJson.goal.tool_results.some((row) => row.tool === 'fs_write' && row.ok));

  const beforeResume = provider.requests.length;
  const resumed = await runCli(['resume', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(parseJson(resumed).goal.status, 'COMPLETED');
  assert.equal(provider.requests.length, beforeResume, 'completed resume must not call the model or replay tools');
});

test('CLI run streams the live trace, prints evidence details, and logs replays the trace', async (t) => {
  const fx = fixture(t);
  let completions = 0;
  const provider = await fakeProvider(t, () => {
    completions += 1;
    if (completions === 1) return toolCall('inspect-host', 'majin_status', { detail: 'summary' });
    if (completions === 2) return toolCall('write-visible-proof', 'fs_write', { path: 'visible-proof.txt', content: 'visible verified secret-body-9e1' });
    return { role: 'assistant', content: 'Created visible-proof.txt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'visible-proof.txt', contains: 'visible verified' }]);
  const run = await runCli(['run', 'Inspect MAJIN host state and create visible-proof.txt', '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'sys,re'], fx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Status: COMPLETED/);
  assert.match(run.stdout, /Acceptance checks \(1\):/);
  assert.match(run.stdout, /✓ file visible-proof\.txt contains "visible verified" — verified/);
  assert.match(run.stdout, /Verification evidence: 1/);
  assert.match(run.stdout, / {2}verified file .*visible-proof\.txt — \d+ bytes, sha256 /);
  assert.match(run.stderr, /\[majin\] strategy: /);
  assert.match(run.stderr, /\[majin\] model is preparing tool majin_status/);
  assert.match(run.stderr, /\[majin\] tool majin_status started detail=summary/);
  assert.match(run.stderr, /\[majin\] tool majin_status ok in \d+ms/);
  assert.match(run.stderr, /\[majin\] model: Created visible-proof\.txt\./);
  assert.match(run.stderr, /\[majin\] tool fs_write started path=visible-proof\.txt content=<\d+ chars>/);
  assert.match(run.stderr, /\[majin\] tool fs_write ok in \d+ms/);
  assert.match(run.stderr, /\[majin\] verified file visible-proof\.txt — file .*visible-proof\.txt — \d+ bytes, sha256 /);
  assert.match(run.stderr, /\[majin\] goal finished: COMPLETED/);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /secret-body-9e1/, 'file contents must never be echoed into the terminal trace');

  const logs = await runCli(['logs', '--data-dir', fx.dataDir], fx);
  assert.equal(logs.status, 0, `${logs.stdout}\n${logs.stderr}`);
  assert.match(logs.stdout, /Trace \(\d+ events\)/);
  assert.match(logs.stdout, /#1 goal started/);
  assert.match(logs.stdout, /model is preparing tool majin_status/);
  assert.match(logs.stdout, /model: Created visible-proof\.txt\./);
  assert.match(logs.stdout, /tool fs_write started path=visible-proof\.txt/);
  assert.match(logs.stdout, /goal finished: COMPLETED/);
  assert.doesNotMatch(logs.stdout, /secret-body-9e1/);
});

test('CLI logs checklist shows exactly which acceptance checks failed or remain unverified', async (t) => {
  const fx = fixture(t);
  // The model only ever claims success in prose; nothing is ever written.
  const provider = await fakeProvider(t, () => ({ role: 'assistant', content: 'All done, trust me.' }));
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([
    { kind: 'file', path: 'never-a.txt', contains: 'alpha' },
    { kind: 'file', path: 'never-b.txt', contains: 'beta' },
  ]);
  const run = await runCli(['run', 'Create never-a.txt and never-b.txt', '--data-dir', fx.dataDir, '--criteria', criteria, '--lanes', 'sys,re'], fx);
  assert.notEqual(run.status, 0, 'an unverified claim must not exit 0');
  assert.doesNotMatch(run.stdout, /Status: COMPLETED/);

  const logs = await runCli(['logs', '--data-dir', fx.dataDir], fx);
  assert.equal(logs.status, 0, `${logs.stdout}\n${logs.stderr}`);
  assert.match(logs.stdout, /Acceptance checks \(2\):/);
  assert.match(logs.stdout, /✗ file never-a\.txt contains "alpha" — FAILED verification/);
  assert.match(logs.stdout, /· file never-b\.txt contains "beta" — not yet verified/);
  assert.doesNotMatch(logs.stdout, /✓ file never-/, 'no check may be shown verified without host evidence');
});

test('CLI model commands configure from env, discover a live catalog, and never echo the secret', async (t) => {
  const fx = fixture(t);
  const provider = await fakeProvider(t, () => ({ role: 'assistant', content: 'not used in this test' }));

  const rawKey = await runCli([
    'model', 'configure', '--data-dir', fx.dataDir, '--provider', 'opencode-go', '--api-key', 'do-not-print-me',
  ], fx);
  assert.equal(rawKey.status, 1);
  assert.match(rawKey.stderr, /Refusing --api-key in argv/);
  assert.doesNotMatch(rawKey.stderr, /do-not-print-me/);

  const configured = await runCli([
    'model', 'configure',
    '--data-dir', fx.dataDir,
    '--provider', 'opencode-go',
    '--base-url', provider.baseUrl,
    '--api-key-env', 'TEST_PROVIDER_KEY',
    '--discover',
    '--json',
  ], { ...fx, env: { TEST_PROVIDER_KEY: 'local-test-key' } });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);
  assert.doesNotMatch(configured.stdout, /local-test-key/);
  const configuredJson = parseJson(configured);
  assert.equal(configuredJson.discovery.ok, true);
  assert.deepEqual(configuredJson.discovery.models, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.equal(configuredJson.provider.activeProvider, 'opencode-go');
  assert.equal(configuredJson.provider.activeModelId, 'deepseek-v4-pro');
  assert.equal(configuredJson.provider.connectionVerified, true);
  assert.equal(configuredJson.provider.providers['opencode-go'].hasKey, true);
  assert.equal(configuredJson.provider.providers['opencode-go'].maskedKey, 'loc••••ey');

  const selected = await runCli(['model', 'select', 'deepseek-v4-flash', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(parseJson(selected).activeModelId, 'deepseek-v4-flash');
  assert.equal(parseJson(selected).canonicalSelection, 'opencode-go/deepseek-v4-flash');

  const listed = await runCli(['model', 'list', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(parseJson(listed).providers['opencode-go'].discoveredModels, ['deepseek-v4-pro', 'deepseek-v4-flash']);

  const status = await runCli(['model', 'status', '--data-dir', fx.dataDir], fx);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Active model: opencode-go\/deepseek-v4-flash/);
  assert.doesNotMatch(status.stdout, /local-test-key/);
});

test('CLI chat persists and clears exact browser write origins without accepting URL credentials', async (t) => {
  const fx = fixture(t);
  const session = startCliSession(['chat', '--data-dir', fx.dataDir], fx);
  await session.waitFor('Type a goal');

  session.write('/browser-origin grant https://Employer.Example:443/apply?job=1');
  await session.waitFor('Browser write origins (1): https://employer.example');
  await session.waitFor('Exact origin grant is effective immediately');

  session.write('/browser-origin grant https://user:secret@employer.example/apply');
  await session.waitFor('embedded credentials are not allowed', 'stderr');

  session.write('/status');
  await session.waitFor('Browser write origins (1): https://employer.example');

  session.write('/browser-origin clear');
  await session.waitFor('Browser write origins (0): (none; browser writes/submits blocked)');

  session.write('/browser-origin grant https://portal.example/form');
  await session.waitFor('Browser write origins (1): https://portal.example');
  const closed = await session.exit();
  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);

  const listed = await runCli(['grants', 'browser-origin', 'list', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(parseJson(listed).browserWriteOrigins, ['https://portal.example']);
});

test('CLI chat grants a blocked browser origin in the same host and resumes the retained filled page to portal receipt', async (t) => {
  const browserPath = await browserBinary();
  if (!browserPath) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const fx = fixture(t);
  const marker = `chat-retained-${Date.now()}`;
  const submissions = [];
  const portal = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submissions.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      res.setHeader('content-type', 'text/html');
      res.end('<h1>CHAT PORTAL RECEIVED</h1>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<h1>Chat application portal</h1><form method="post" action="/submit">
      <label>Name <input name="name" required></label>
      <label>Marker <input name="marker" required></label>
      <button type="submit">Send application</button>
    </form>`);
  });
  await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${portal.address().port}`;
  t.after(async () => {
    portal.closeAllConnections();
    await new Promise((resolve) => portal.close(resolve));
  });

  let completions = 0;
  const provider = await fakeProvider(t, () => {
    completions += 1;
    if (completions === 1) return toolCall('chat-open-portal', 'browser_open', { url: origin });
    if (completions === 2) return toolCall('chat-fill-name', 'browser_fill', { selector: 'input[name="name"]', value: 'Chat User' });
    if (completions === 3) return toolCall('chat-fill-marker', 'browser_fill', { selector: 'input[name="marker"]', value: marker });
    if (completions === 4) return toolCall('chat-submit-blocked', 'browser_click', { selector: 'button[type="submit"]' });
    if (completions === 5) return toolCall('chat-inspect-retained', 'browser_inspect', {});
    if (completions === 6) return toolCall('chat-submit-granted', 'browser_click', { selector: 'button[type="submit"]' });
    if (completions === 7) return toolCall('chat-inspect-receipt', 'browser_inspect', {});
    if (completions === 8) return toolCall('chat-write-receipt', 'fs_write', { path: 'chat-browser-receipt.txt', content: `Chat portal receipt ${marker}` });
    return { role: 'assistant', content: 'Submitted the retained chat form and observed the receipt.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'chat-browser-receipt.txt', contains: marker }]);

  const session = startCliSession([
    'chat', '--data-dir', fx.dataDir, '--criteria', criteria,
    '--lanes', 'files,browser', '--browser-headless',
  ], { ...fx, timeoutMs: 600000, env: { MAJIN_V4_BROWSER: browserPath } });
  t.after(() => session.terminate());
  await session.waitFor('Type a goal', 'stdout', 60000);
  session.write(`Open ${origin}, fill it for Chat User with marker ${marker}, submit it, and save chat-browser-receipt.txt`);
  // A cold real Edge/Chromium launch plus four isolated driver operations can
  // exceed the generic 30s chat wait on a loaded Windows runner. The product
  // still has its own per-model/per-tool timeouts; this waits for the same
  // real WAITING_USER checkpoint without weakening any assertion below, but
  // fails fast if the goal reaches a terminal state instead of the handoff.
  await session.waitFor(/Status: (WAITING_USER|COMPLETED|PARTIAL|BLOCKED|CANCELLED)/, 'stdout', 240000);
  assert.match(
    session.stdout,
    /Status: WAITING_USER/,
    `the blocked submit must pause for the owner instead of finishing\nSTDOUT:\n${session.stdout}\nSTDERR:\n${session.stderr}`,
  );
  await session.waitFor('Browser handoff: BROWSER_ORIGIN');
  await session.waitFor(`Exact origin: ${origin}`);
  await session.waitFor('Browser session retained at handoff: yes');
  assert.deepEqual(submissions, [], 'the blocked chat submit must not reach the portal');
  assert.equal(completions, 4);

  session.write(`/browser-origin grant ${origin}/submit`);
  await session.waitFor(`Browser write origins (1): ${origin}`, 'stdout', 60000);
  await session.waitFor('Exact origin grant is effective immediately', 'stdout', 60000);

  session.write('/resume');
  await session.waitFor('Status: COMPLETED', 'stdout', 240000);
  session.write('/status');
  await session.waitFor('resumes: 1', 'stdout', 60000);
  const closed = await session.exit();

  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
  assert.deepEqual(submissions, [{ name: 'Chat User', marker }], 'resume submitted the already-filled page exactly once');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'chat-browser-receipt.txt'), 'utf8'), `Chat portal receipt ${marker}`);
  assert.equal(completions, 9);
});

test('CLI chat keeps a queued goal parked across WAITING_USER and starts it only after grant, resume and completion', async (t) => {
  const browserPath = await browserBinary();
  if (!browserPath) { t.skip('No installed Chromium/Edge on this runner'); return; }
  const fx = fixture(t);
  const marker = `queue-wait-${Date.now()}`;
  const submissions = [];
  const portal = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submissions.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      res.setHeader('content-type', 'text/html');
      res.end('<h1>QUEUE PORTAL RECEIVED</h1>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<h1>Queue application portal</h1><form method="post" action="/submit">
      <label>Name <input name="name" required></label>
      <label>Marker <input name="marker" required></label>
      <button type="submit">Send application</button>
    </form>`);
  });
  await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${portal.address().port}`;
  t.after(async () => {
    portal.closeAllConnections();
    await new Promise((resolve) => portal.close(resolve));
  });

  let completions = 0;
  const provider = await fakeProvider(t, () => {
    completions += 1;
    if (completions === 1) return toolCall('queue-open-portal', 'browser_open', { url: origin });
    if (completions === 2) return toolCall('queue-fill-name', 'browser_fill', { selector: 'input[name="name"]', value: 'Queue User' });
    if (completions === 3) return toolCall('queue-fill-marker', 'browser_fill', { selector: 'input[name="marker"]', value: marker });
    if (completions === 4) return toolCall('queue-submit-blocked', 'browser_click', { selector: 'button[type="submit"]' });
    if (completions === 5) return toolCall('queue-inspect-retained', 'browser_inspect', {});
    if (completions === 6) return toolCall('queue-submit-granted', 'browser_click', { selector: 'button[type="submit"]' });
    if (completions === 7) return toolCall('queue-inspect-receipt', 'browser_inspect', {});
    if (completions === 8) return toolCall('queue-write-receipt', 'fs_write', { path: 'queue-wait-receipt.txt', content: `Queue wait receipt ${marker}` });
    if (completions === 9) return { role: 'assistant', content: 'Submitted the retained form and saved the receipt.' };
    if (completions === 10) return toolCall('queued-write', 'fs_write', { path: 'queued-after-wait.txt', content: 'queued goal ran after resume' });
    return { role: 'assistant', content: 'Queued goal done.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'queue-wait-receipt.txt', contains: marker }]);
  const queuedPath = path.join(fx.workspace, 'queued-after-wait.txt');

  const session = startCliSession([
    'chat', '--data-dir', fx.dataDir, '--criteria', criteria,
    '--lanes', 'files,browser', '--browser-headless',
  ], { ...fx, timeoutMs: 600000, env: { MAJIN_V4_BROWSER: browserPath } });
  t.after(() => session.terminate());
  await session.waitFor('Type a goal', 'stdout', 60000);
  session.write(`Open ${origin}, fill it for Queue User with marker ${marker}, submit it, and save queue-wait-receipt.txt`);
  await waitForCondition(() => completions >= 1, 'the first provider request of the waiting goal', 60000);
  session.write('/queue Create queued-after-wait.txt');
  await session.waitFor('Queued after the active goal', 'stdout', 60000);
  await session.waitFor(/Status: (WAITING_USER|COMPLETED|PARTIAL|BLOCKED|CANCELLED)/, 'stdout', 240000);
  assert.match(session.stdout, /Status: WAITING_USER/, `the blocked submit must pause for the owner\nSTDOUT:\n${session.stdout}\nSTDERR:\n${session.stderr}`);
  // The queue must stay parked: blindly starting the next goal here would
  // replace the WAITING_USER checkpoint and its retained filled page.
  await session.waitFor('Queued goal kept', 'stdout', 60000);
  assert.equal(fs.existsSync(queuedPath), false, 'queued goal must not run while the checkpoint waits for the owner');
  assert.deepEqual(submissions, [], 'the blocked submit must not reach the portal');
  assert.equal(completions, 4);

  // Give the parked queued goal its own acceptance criteria while the first
  // goal still waits; they must apply to the queued goal, not the checkpoint.
  session.write('/criteria [{"kind":"file","path":"queued-after-wait.txt","contains":"queued goal ran after resume"}]');
  await session.waitFor('Acceptance criteria will apply to the next new goal', 'stdout', 60000);

  session.write(`/browser-origin grant ${origin}/submit`);
  await session.waitFor(`Browser write origins (1): ${origin}`, 'stdout', 60000);
  session.write('/resume');
  await session.waitFor('Status: COMPLETED', 'stdout', 240000);
  await session.waitFor('Starting queued goal: Create queued-after-wait.txt', 'stdout', 120000);
  await waitForCondition(
    () => fs.existsSync(queuedPath) && fs.readFileSync(queuedPath, 'utf8').includes('queued goal ran after resume'),
    'the queued goal to run after the resumed goal completed',
    120000,
  );
  const closed = await session.exit();
  // Exit 0 also proves the queued goal itself finished COMPLETED: chat exits
  // with the last goal's code, and an unverified PARTIAL would exit 2.
  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
  assert.match(closed.stderr, /tool fs_write started path=queued-after-wait\.txt/, 'live trace must stream the queued goal too');
  assert.deepEqual(submissions, [{ name: 'Queue User', marker }], 'resume submitted the already-filled page exactly once');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'queue-wait-receipt.txt'), 'utf8'), `Queue wait receipt ${marker}`);
  assert.equal(completions, 11);
});

test('CLI chat steers the live provider goal before its stale tool batch can execute', async (t) => {
  const fx = fixture(t);
  let completions = 0;
  const provider = await fakeProvider(t, async () => {
    completions += 1;
    if (completions === 1) {
      await delay(1500);
      return toolCall('stale-chat-write', 'fs_write', { path: 'chat-steer.txt', content: 'obsolete draft' });
    }
    if (completions === 2) {
      return toolCall('steered-chat-write', 'fs_write', { path: 'chat-steer.txt', content: 'owner steered final' });
    }
    return { role: 'assistant', content: 'Created the steered output.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);

  const criteria = JSON.stringify([{ kind: 'file', path: 'chat-steer.txt', contains: 'owner steered final' }]);
  const session = startCliSession(['chat', '--data-dir', fx.dataDir, '--criteria', criteria], fx);
  await session.waitFor('Type a goal');
  session.write('Create chat-steer.txt with obsolete draft');
  await session.waitFor('Goal started');
  await waitForCondition(
    () => provider.requests.some((request) => request.method === 'POST'),
    'the first provider completion request',
  );
  session.write('Use owner steered final instead; do not write obsolete draft.');
  await session.waitFor('Steering accepted');
  await session.waitFor('Status: COMPLETED');
  session.write('/checkpoint');
  await session.waitFor('Checkpoint file:');
  const closed = await session.exit();

  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'chat-steer.txt'), 'utf8'), 'owner steered final');
  assert.match(closed.stderr, /tool fs_write ok/);
  assert.equal(completions, 3);
  const completionBodies = provider.requests.filter((request) => request.method === 'POST').map((request) => request.body);
  assert.ok(
    completionBodies[1].messages.some((message) => String(message.content || '').includes('do not write obsolete draft')),
    'the second model round must receive the owner steering as a user instruction',
  );
});

test('CLI chat pause survives process exit and the next chat process resumes the same checkpoint and provider session', async (t) => {
  const fx = fixture(t);
  let completions = 0;
  const provider = await fakeProvider(t, async () => {
    completions += 1;
    if (completions === 1) {
      await delay(1500);
      return toolCall('late-paused-write', 'fs_write', { path: 'late-paused.txt', content: 'must never be written' });
    }
    if (completions === 2) {
      return toolCall('resumed-chat-write', 'fs_write', { path: 'chat-pause.txt', content: 'resumed final' });
    }
    return { role: 'assistant', content: 'Finished after resume.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);
  const criteria = JSON.stringify([{ kind: 'file', path: 'chat-pause.txt', contains: 'resumed final' }]);

  const first = startCliSession(['chat', '--data-dir', fx.dataDir, '--criteria', criteria], fx);
  await first.waitFor('Type a goal');
  first.write('Create chat-pause.txt with resumed final');
  await waitForCondition(
    () => provider.requests.some((request) => request.method === 'POST'),
    'the first provider completion request',
  );
  first.write('/pause');
  await first.waitFor('Status: PAUSED');
  const firstClosed = await first.exit();
  assert.equal(firstClosed.status, 1, 'exiting with only a paused goal must not claim shell success');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'late-paused.txt')), false);

  const checkpoint = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'provider-agent', 'current.json'), 'utf8'));
  assert.equal(checkpoint.goal.status, 'PAUSED');
  assert.deepEqual(checkpoint.goal.criteria, JSON.parse(criteria));

  const second = startCliSession(['chat', '--data-dir', fx.dataDir], fx);
  await second.waitFor('Saved goal: PAUSED');
  second.write('Continue and finish the saved work');
  await second.waitFor('Saved checkpoint found');
  await second.waitFor('Status: COMPLETED');
  second.write('/status');
  await second.waitFor('resumes: 1');
  const secondClosed = await second.exit();

  assert.equal(secondClosed.status, 0, `${secondClosed.stdout}\n${secondClosed.stderr}`);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'chat-pause.txt'), 'utf8'), 'resumed final');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'late-paused.txt')), false);
  const completionSessionHeaders = provider.requests
    .filter((request) => request.method === 'POST')
    .map((request) => request.headers['x-opencode-session']);
  assert.equal(completionSessionHeaders.length, 3);
  assert.equal(new Set(completionSessionHeaders).size, 1, 'resume in a new CLI process must retain the saved provider conversation');
  const logs = await runCli(['logs', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(parseJson(logs).goal.resume_count, 1);
});

test('CLI chat queues the next goal without losing the active checkpoint and can cancel a later live goal', async (t) => {
  const fx = fixture(t);
  let completions = 0;
  const provider = await fakeProvider(t, async () => {
    completions += 1;
    if (completions === 1) {
      await delay(1200);
      return toolCall('queue-first-write', 'fs_write', { path: 'queue-first.txt', content: 'first queued output' });
    }
    if (completions === 2) return { role: 'assistant', content: 'First goal done.' };
    if (completions === 3) return toolCall('queue-second-write', 'fs_write', { path: 'queue-second.txt', content: 'second queued output' });
    if (completions === 4) return { role: 'assistant', content: 'Second goal done.' };
    if (completions === 5) {
      await delay(1500);
      return toolCall('cancelled-chat-write', 'fs_write', { path: 'cancelled-chat.txt', content: 'must never be written' });
    }
    return { role: 'assistant', content: 'Unexpected extra completion.' };
  });
  await configureProvider(fx.dataDir, provider.baseUrl);

  const firstCriteria = JSON.stringify([{ kind: 'file', path: 'queue-first.txt', contains: 'first queued output' }]);
  const secondCriteria = JSON.stringify([{ kind: 'file', path: 'queue-second.txt', contains: 'second queued output' }]);
  const session = startCliSession(['chat', '--data-dir', fx.dataDir, '--criteria', firstCriteria], fx);
  await session.waitFor('Type a goal');
  session.write('Create queue-first.txt');
  await waitForCondition(() => completions >= 1, 'the first queued-test provider request');
  session.write('/queue Create queue-second.txt');
  await session.waitFor('Queued after the active goal');
  session.write(`/criteria ${secondCriteria}`);
  await session.waitFor('Acceptance criteria will apply to the next new goal');
  await session.waitFor('Starting queued goal: Create queue-second.txt');
  await waitForCondition(
    () => (session.stdout.match(/Status: COMPLETED/g) || []).length >= 2,
    'both queued goals to complete',
  );
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'queue-first.txt'), 'utf8'), 'first queued output');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'queue-second.txt'), 'utf8'), 'second queued output');

  session.write('/new Create cancelled-chat.txt');
  await waitForCondition(() => completions >= 5, 'the cancellable provider request');
  session.write('/cancel');
  await session.waitFor('Status: CANCELLED');
  const closed = await session.exit();
  assert.equal(closed.status, 1, 'the final cancelled goal determines the interactive process exit code');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'cancelled-chat.txt')), false);
  assert.equal(completions, 5);
});

test('CLI memory command lets the owner review, search, forget and clear long-term memory', async (t) => {
  const fx = fixture(t);
  const store = new MemoryStore(path.join(fx.dataDir, 'memory'));
  store.put('preference', { key: 'owner.language', text: 'Owner prefers Swedish answers.', tags: ['language'], importance: 0.9, meta: { via: 'majin_memory', rememberedBy: 'model' } });
  store.put('project', { key: 'garden.plan', text: 'Plant tomatoes in May.', tags: ['garden'], importance: 0.6 });

  const listed = await runCli(['memory', 'list', '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const listedJson = parseJson(listed);
  assert.equal(listedJson.count, 2);
  assert.equal(listedJson.entries.find((entry) => entry.key === 'owner.language')?.rememberedBy, 'model');

  const searched = parseJson(await runCli(['memory', 'search', 'tomatoes', '--data-dir', fx.dataDir, '--json'], fx));
  assert.deepEqual(searched.entries.map((entry) => entry.key), ['garden.plan']);

  const got = parseJson(await runCli(['memory', 'get', 'owner.language', '--data-dir', fx.dataDir, '--json'], fx));
  assert.equal(got.entries[0].text, 'Owner prefers Swedish answers.');

  const clearRefused = await runCli(['memory', 'clear', '--data-dir', fx.dataDir], fx);
  assert.notEqual(clearRefused.status, 0, 'clear without --yes must be refused');
  assert.match(`${clearRefused.stdout}\n${clearRefused.stderr}`, /without --yes/);
  assert.ok(new MemoryStore(path.join(fx.dataDir, 'memory')).get('preference', 'owner.language'));

  const forgotten = parseJson(await runCli(['memory', 'forget', 'owner.language', '--data-dir', fx.dataDir, '--json'], fx));
  assert.deepEqual(forgotten.forgotten, ['preference:owner.language']);
  assert.equal(new MemoryStore(path.join(fx.dataDir, 'memory')).get('preference', 'owner.language'), null);

  const forgetMissing = await runCli(['memory', 'forget', 'owner.language', '--data-dir', fx.dataDir], fx);
  assert.equal(forgetMissing.status, 0);
  assert.match(forgetMissing.stdout, /Nothing was deleted/);

  const cleared = await runCli(['memory', 'clear', '--data-dir', fx.dataDir, '--yes'], fx);
  assert.equal(cleared.status, 0, `${cleared.stdout}\n${cleared.stderr}`);
  assert.equal(new MemoryStore(path.join(fx.dataDir, 'memory')).get('project', 'garden.plan'), null);

  const badKind = await runCli(['memory', 'list', '--kind', 'secrets', '--data-dir', fx.dataDir], fx);
  assert.notEqual(badKind.status, 0);
});

test('CLI memory export/import round-trips a full backup and refuses unsafe restores', async (t) => {
  const fx = fixture(t);
  const store = new MemoryStore(path.join(fx.dataDir, 'memory'));
  store.put('preference', { key: 'owner.city', text: 'Owner lives in Stockholm.', importance: 0.8 });
  store.put('project', { key: 'boat.name', text: 'The boat is called Aurora.', importance: 0.7 });

  const backup = path.join(fx.root, 'memory-backup.json');
  const exported = await runCli(['memory', 'export', '--out', backup, '--data-dir', fx.dataDir, '--json'], fx);
  assert.equal(exported.status, 0, `${exported.stdout}\n${exported.stderr}`);
  assert.equal(parseJson(exported).exported, 2);
  assert.ok(fs.existsSync(backup));

  // Mutate live memory, then prove import refuses without --yes and data stays.
  store.put('preference', { key: 'owner.city', text: 'Owner moved to Gothenburg.', importance: 0.9 });
  const refused = await runCli(['memory', 'import', backup, '--data-dir', fx.dataDir], fx);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /REPLACES all current/);
  assert.equal(new MemoryStore(path.join(fx.dataDir, 'memory')).get('preference', 'owner.city')?.text, 'Owner moved to Gothenburg.');

  const imported = parseJson(await runCli(['memory', 'import', backup, '--yes', '--data-dir', fx.dataDir, '--json'], fx));
  assert.equal(imported.imported, 2);
  const restored = new MemoryStore(path.join(fx.dataDir, 'memory'));
  assert.equal(restored.get('preference', 'owner.city')?.text, 'Owner lives in Stockholm.');
  assert.equal(restored.get('project', 'boat.name')?.text, 'The boat is called Aurora.');

  // A tampered export carrying a sensitive entry is rejected before any write.
  const tampered = JSON.parse(fs.readFileSync(backup, 'utf8'));
  tampered.records[0].entry.sensitive = true;
  const tamperedFile = path.join(fx.root, 'tampered.json');
  fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
  const rejected = await runCli(['memory', 'import', tamperedFile, '--yes', '--data-dir', fx.dataDir], fx);
  assert.notEqual(rejected.status, 0);
  assert.equal(new MemoryStore(path.join(fx.dataDir, 'memory')).get('preference', 'owner.city')?.text, 'Owner lives in Stockholm.', 'a rejected import must not partially replace memory');
});

test('serve persists explicit owner lanes, folders and browser origins before listening', async (t) => {
  const { root, dataDir } = fixture(t);
  const session = startCliSession(['serve', '--host', '127.0.0.1', '--port', '0',
    '--data-dir', dataDir, '--all-lanes', '--folder', root,
    '--browser-origin', 'https://example.com'], { root });
  t.after(async () => { killProcessTree(session.child); await session.closed; });
  await session.waitFor('listening on');
  const result = await runCli(['grants', 'show', '--data-dir', dataDir, '--json'], { root });
  assert.equal(result.status, 0, result.stderr);
  const access = parseJson(result);
  assert.ok(access.grantedLanes.includes('shell'));
  assert.ok(access.grantedLanes.includes('browser'));
  assert.ok(access.grantedFolders.includes(root));
  assert.deepEqual(access.browserWriteOrigins, ['https://example.com']);
});

test('serve rejects unknown owner lanes before listening', async (t) => {
  const { root, dataDir } = fixture(t);
  const result = await runCli(['serve', '--host', '127.0.0.1', '--port', '0',
    '--data-dir', dataDir, '--lanes', 'invalid-lane'], { root, timeoutMs: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown lane/);
  assert.doesNotMatch(result.stdout, /listening on/);
});

test('idle test is local and does not resume or replace a saved blocked goal', async t => {
  const { root, dataDir } = fixture(t);
  const dir = path.join(dataDir, 'provider-agent'); fs.mkdirSync(dir, { recursive: true });
  const state = { goal: { goal_id: 'retained-test-goal', objective: 'Old application task', status: 'BLOCKED', criteria: [] }, messages: [] };
  const file = path.join(dir, 'current.json'); fs.writeFileSync(file, JSON.stringify(state));
  const session = startCliSession(['chat', '--data-dir', dataDir], { root });
  t.after(() => session.terminate());
  await session.waitFor(/Type a goal/);
  session.write('test');
  await session.waitFor(/No model request was sent and no saved goal was resumed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), state);
  assert.doesNotMatch(session.stdout, /Goal started|Resuming goal/);
  assert.equal((await session.exit()).status, 0);
});
