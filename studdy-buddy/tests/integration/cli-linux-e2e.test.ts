import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { resolveAgentDesktopBinary } from '@studdy/core';

const root = resolve(__dirname, '../..');
const bundle = join(root, 'dist/cli/studdy.mjs');
const runFile = promisify(execFile);
let dir: string;
let server: Server;
let base: string;
const requests: { model: string; messages: { role: string; content: unknown }[]; stream?: boolean }[] = [];
const secret = 'local-e2e-secret-not-a-real-key';

interface Result { code: number; stdout: string; stderr: string }
function cli(args: string[], input?: string, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bundle, ...args, '--no-color'], {
      cwd: root, env: { ...process.env, STUDDY_DATA_DIR: dir, NO_COLOR: '1', ...env }, stdio: 'pipe',
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
async function json(args: string[], input?: string): Promise<Record<string, any>> {
  const r = await cli([...args, '--json'], input);
  expect(r.stderr, r.stdout).toBe('');
  return JSON.parse(r.stdout);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-linux-e2e-'));
  await runFile(process.execPath, ['scripts/build-cli.mjs'], { cwd: root });
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    expect(req.headers.authorization).toBe(`Bearer ${secret}`);
    res.setHeader('content-type', 'application/json');
    if (payload.stream) {
      res.write('data: {"choices":[{"delta":{"content":"{\\"directAnswer\\":\\"Lokal ström\\","}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"\\"evidence\\":[],\\"confidence\\":\\"medium\\"}"}}],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    const vision = Array.isArray(payload.messages.at(-1)?.content);
    const content = vision ? 'En röd testpixel syns.' : payload.tools ? '' : JSON.stringify({
      directAnswer: 'Subnetting delar ett nät i mindre delar.', simpleExplanation: 'Som mindre rum i ett hus.',
      example: '', nextAction: '', deeperExplanation: '', evidence: ['Lokal HTTP-E2E'], confidence: 'medium',
    });
    res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content, ...(payload.tools ? { tool_calls: [{ id: 'call1', function: { name: 'ping', arguments: '{}' } }] } : {}) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 9 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local HTTP port');
  base = `http://127.0.0.1:${address.port}/v1`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('built CLI in a real OS process, real HTTP and real native helper', () => {
  it('version/help flags are clean, deterministic and do not create a database', async () => {
    for (const flag of ['--version', '-v']) {
      const r = await cli([flag, '--json']);
      expect(r.code).toBe(0); expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout).version).toMatch(/^\d+\.\d+\.\d+/);
    }
    const help = await cli(['--help']);
    expect(help.code).toBe(0); expect(help.stdout).toContain('Användning');
    expect(existsSync(join(dir, 'studdy.db'))).toBe(false);
    expect((await cli(['--unknown'])).code).toBe(2);
  });

  it('setup, encrypted stdin key, provider test, chat, memory and history cross process boundaries', async () => {
    expect((await cli(['setup'])).code).toBe(0);
    const saved = await json(['provider', 'set', 'custom', '--key-stdin', '--base-url', base, '--model', 'local-text', '--vision-model', 'local-vision'], secret);
    expect(saved.ok).toBe(true);
    expect(readFileSync(join(dir, 'secrets.vault'), 'utf8')).not.toContain(secret);
    expect((await json(['provider', 'test'])).ok).toBe(true);
    const answer = await json(['ask', 'Förklara subnetting']);
    expect(answer.degraded).toBe(false); expect(answer.message.text).toContain('Subnetting');
    expect(requests.some(r => r.model === 'local-text')).toBe(true);
    const memory = await json(['memory']);
    expect(memory.path).toBe(join(dir, 'Obsidian-Vault'));
    expect(existsSync(join(memory.path, 'Buddy – Studieläge.md'))).toBe(true);
    expect(existsSync(join(dir, 'Obsidian-Vault', 'Obsidian-Vault'))).toBe(false);
    expect((await json(['progress'])).skills.verified).toBeGreaterThan(0);
    expect(JSON.stringify(await json(['history']))).toContain('Subnetting');
    const status = await json(['status']);
    expect(status.provider.hasApiKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);
    // On a headless Linux runner observation must stay blocked; on a real desktop
    // (Windows CI) it may legitimately succeed. Never assert one OS's blocker on another.
    if (process.platform === 'linux') {
      expect(status.live.observing).toBe(false);
      expect((await cli(['watch', '--once'])).code).toBe(1);
    } else if (status.live.observing) {
      expect(status.live.elementCount).toBeGreaterThan(0);
      expect(status.live.windowTitle).toBeTruthy();
    }
  }, 30_000);

  it('measures streaming, JSON, vision and tools over the actual fetch socket', async () => {
    const caps = await json(['provider', 'probe']);
    expect(caps.ok).toBe(true);
    expect(caps.data).toMatchObject({ text: true, streaming: true, json: true, vision: true, tools: true });
    expect(requests.some(r => r.stream)).toBe(true);
    expect(requests.some(r => r.model === 'local-vision')).toBe(true);
  }, 30_000);

  it('scripted interactive REPL consumes every line and exits on EOF', async () => {
    const r = await cli(['repl'], '/status\n/memory\nhar du full åtkomst?\nFörklara subnetting\n');
    expect(r.code).toBe(0); expect(r.stderr).toBe('');
    expect(r.stdout).toContain('verkliga åtkomst');
    expect(r.stdout).toContain('Subnetting delar');
    expect(r.stdout).toContain('Obsidian-Vault');
  }, 20_000);

  it.runIf(process.platform === 'linux')('runs the real installed Linux helper and reports the missing desktop bus honestly', async () => {
    const binary = resolveAgentDesktopBinary({ platform: 'linux', arch: 'x64', moduleDir: root });
    expect(binary).toContain('agent-desktop-linux-x64');
    const version = JSON.parse((await runFile(binary, ['version'])).stdout);
    expect(version.ok).toBe(true);
    const doctor = await json(['doctor']);
    expect(doctor.checks.find((c: any) => c.name === 'Native helper')).toMatchObject({ ok: false, blocked: true });
    const windows = await json(['windows']);
    expect(windows.windows).toEqual([]);
    expect(windows.error).toMatch(/AT-SPI|D-Bus|desktop/i);
    expect((await json(['apps'])).error).toBeTruthy();
    expect((await json(['open', 'bash'])).ok).toBe(false);
    expect((await json(['see', 'fake-window', 'vad ser du'])).error.code).toBe('CAPTURE_FAILED');
    expect((await json(['voice', 'hej'])).error).toMatch(/Linux-röst|espeak/);
  }, 30_000);

  it('bridge authenticates a real WebSocket, accepts an allowed page and rejects a foreign page', async () => {
    expect((await json(['sites', 'allow', 'course.example.com'])).allowed).toContain('course.example.com');
    const child = spawn(process.execPath, [bundle, 'bridge', '--port', '0', '--json'], {
      cwd: root, env: { ...process.env, STUDDY_DATA_DIR: dir, NO_COLOR: '1' }, stdio: 'pipe',
    }) as ChildProcessWithoutNullStreams;
    let output = '', errors = '';
    child.stderr.on('data', c => { errors += c; });
    const ready = new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge did not start: ' + output + errors)), 10_000);
      child.stdout.on('data', c => {
        output += c;
        try { const value = JSON.parse(output); if (value.running) { clearTimeout(timer); resolve(value); } } catch { /* wait for complete JSON */ }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Bridge exited ' + code + errors)); });
    });
    try {
      const credentials = await ready;
      const socket = new WebSocket(`ws://127.0.0.1:${credentials.port}`);
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
      const replies: any[] = [];
      socket.on('message', raw => replies.push(JSON.parse(raw.toString())));
      const send = (type: string, payload?: unknown) => socket.send(JSON.stringify({ type, token: credentials.token, payload }));
      send('hello');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(replies[0].type).toBe('welcome');
      const page = { url: 'https://course.example.com/lesson', title: 'Nätverk', courseName: 'Nätverk', headingPath: ['Nätverk'], detectedAt: new Date().toISOString() };
      const snapshot = { url: page.url, title: page.title, courseName: page.courseName, headings: [{ level: 1, text: 'Subnetting' }, { level: 2, text: 'Övning' }], navLinks: [], contentInIframe: false };
      send('page-context', { page, snapshot });
      send('page-context', { page: { ...page, url: 'https://evil.example.net/' }, snapshot: { ...snapshot, url: 'https://evil.example.net/' } });
      send('selection', { url: page.url, text: 'Vad betyder prefixlängd?' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No rejection: ' + JSON.stringify(replies) + ' stderr=' + errors + ' stdout=' + output)), 3000);
        const check = () => { if (replies.some(r => r.type === 'rejected')) { clearTimeout(timer); resolve(); } };
        socket.on('message', check); check();
      });
      expect((await json(['progress'])).learning).toBeTruthy();
      const sites = await json(['sites']);
      expect(sites.bridge.running).toBe(true); // authenticated probe from a different process
      socket.close();
    } finally {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGINT');
      await exited;
    }
  }, 20_000);
  it.runIf(process.platform === 'linux')('masks the interactive secret in a real pseudoterminal', async () => {
    const script = `import os,pty,select,time,subprocess,sys\n` +
      `secret='pty-synthetic-key-123456'\n` +
      `master,slave=pty.openpty()\n` +
      `p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(bundle)}],stdin=slave,stdout=slave,stderr=slave,env=dict(os.environ),close_fds=True)\n` +
      `os.close(slave); out=b''; sent=False; end=time.time()+12\n` +
      `while time.time()<end and p.poll() is None:\n` +
      ` r,_,_=select.select([master],[],[],0.1)\n` +
      ` if r:\n` +
      `  try: out+=os.read(master,65536)\n` +
      `  except OSError: break\n` +
      ` if not sent and 'du › '.encode() in out:\n` +
      `  for line in ['/setup','kilo',secret,'/status','/exit']:\n` +
      `   os.write(master,(line+'\\r').encode()); time.sleep(.3)\n` +
      `  sent=True\n` +
      `try: p.wait(timeout=3)\n` +
      `except subprocess.TimeoutExpired: p.kill(); p.wait()\n` +
      `print('SECRET_LEAK' if secret.encode() in out else 'SECRET_MASKED'); print('EXIT',p.returncode)\n`;
    const r = await runFile('python3', ['-c', script], { cwd: root, env: { ...process.env, STUDDY_DATA_DIR: dir, NO_COLOR: '1' }, timeout: 20_000 });
    expect(r.stdout).toContain('SECRET_MASKED');
    expect(r.stdout).toContain('EXIT 0');
  }, 25_000);
});
