/**
 * SAFE EXEC lane — the injection-proof spawn boundary.
 * The headline test is empirical: a `$`-laden text would have been evaluated
 * by the old shell path; under runSafe the bytes pass through LITERALLY and
 * the would-be payload file is proven never to exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSafe, tokenize, substitute, scrubEnv, SafeExecError } from '../src/v2/spawn/safe-exec.js';
import { CommandTtsProvider } from '../src/v2/voice/tts.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = (n) => path.join(REPO, 'test', 'fixtures', 'safe-exec', n);
const NODE = process.execPath;
const echoT = (extra = '') => `{NODE} "${FX('argv-echo.mjs')}" ${extra}`.trim();

test('1. INJECTION PROOF: $(...) in text passes literally, payload file PROVEN absent', async (t) => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const pwn = path.join(os.tmpdir(), `PWNED-safe-exec-${uid}`);
  t.after(() => fs.rmSync(pwn, { force: true }));
  const payload = `$(touch ${pwn}) hello $(whoami) \`id\``;
  const r = await runSafe(echoT('--say {TEXT}'), { NODE, TEXT: payload });
  const echo = JSON.parse(r.stdout);
  assert.equal(echo.argv[1], payload, 'argv carries the BYTES, shell would have evaluated them');
  assert.ok(!fs.existsSync(pwn), 'payload must never exist — the old shell path would have created it');
});

test('2. CONTROL REFUSAL: shell operators in the TEMPLATE die honestly (SAFE_REFUSED with the offending token)', () => {
  for (const tmpl of ['a && b', 'x | y', 'c > /tmp/f', 'd $(e)', 'f `g`', 'h; i', 'j || k']) {
    assert.throws(() => tokenize(tmpl), (e) => e instanceof SafeExecError && e.cls === 'SAFE_REFUSED' && e.message.includes('refused'), tmpl);
  }
  // but operators INSIDE QUOTES are data, not control — quotes are honored
  const argv = tokenize('say "a && b" plain');
  assert.deepEqual(argv, ['say', 'a && b', 'plain']);
});

test('3. placeholder discipline: unknown {NAME} refused (never guessed), substitution is whole-argv safe', () => {
  assert.throws(() => substitute(['x', '{NOPE}'], {}), (e) => e.cls === 'SAFE_REFUSED' && /unknown placeholder/.test(e.message));
  assert.deepEqual(substitute(['{A}', 'pre-{B}-post'], { A: '1 2', B: 'x' }), ['1 2', 'pre-x-post']);
});

test('4. ENV SCRUB: *_KEY/_TOKEN/_SECRET never cross; PATH/HOME survive', async () => {
  const polluted = { NODE, NOTHING: '1', MAJIN_TEST_SECRET_KEY: 'topsecret', GH_TOKEN_VALUE: 'ghp_x', MY_PASSWORD: 'pw' };
  const r = await runSafe(echoT(), { NODE }, { env: polluted });
  const keys = JSON.parse(r.stdout).envKeys;
  assert.ok(!keys.includes('MAJIN_TEST_SECRET_KEY') && !keys.includes('GH_TOKEN_VALUE') && !keys.includes('MY_PASSWORD'), 'secrets must not cross');
  const scrubbed = scrubEnv({ PATH: '/bin', HOME: '/home/u', OPENCODE_API_KEY: 'oc_sk_x', LANG: 'en_US.UTF-8' });
  assert.deepEqual(scrubbed, { PATH: '/bin', HOME: '/home/u', LANG: 'en_US.UTF-8' });
});

test('5. TIMEOUT is mandatory and honest: sleeper killed inside budget with elapsed evidence', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => runSafe(`{NODE} "${FX('sleeper.mjs')}"`, { NODE }, { timeoutMs: 250, maxBuffer: 1024 }),
    (e) => e.cls === 'TIMEOUT' && /killed after/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, 'must not hang');
});

test('6. output cap honest: flood → truncated flag, no silent loss, process exits', async () => {
  const r = await runSafe(`{NODE} "${FX('blaster.mjs')}"`, { NODE }, { maxBuffer: 4096, timeoutMs: 20_000 });
  assert.equal(r.truncated, true, 'overflow must be REPORTED, not hidden');
  assert.ok(r.stdout.length <= 4096);
});

test('7. SPAWN honesty: missing binary → SPAWN class (dependency missing, never success-shaped)', async () => {
  await assert.rejects(
    () => runSafe('definitely-not-a-real-binary-xyz123 {X}', { X: '1' }),
    (e) => e.cls === 'SPAWN' && /not found/.test(e.message));
});

test('8. CommandTtsProvider hardened: literal-$ text lands verbatim in the file; PWNED never exists', async (t) => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const pwn = path.join(os.tmpdir(), `PWNED-tts-${uid}`);
  fs.rmSync(pwn, { force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-safe-'));
  t.after(() => { fs.rmSync(pwn, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  const out = path.join(dir, 'out.wav');
  const script = path.join(dir, 'writer.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], process.argv[3]);\n`);
  const text = `cost: $(touch ${pwn}) <- must stay literal`;
  const p = new CommandTtsProvider({ commandTemplate: `"${NODE}" "${script}" {OUT} {TEXT}` });
  const r = await p.speech(text, { outPath: out });
  assert.equal(r.provider, 'command');
  assert.equal(fs.readFileSync(out, 'utf8'), text, 'the text is DATA — shell metacharacters travel as bytes');
  assert.ok(!fs.existsSync(pwn), 'no injection through the provider path');
  await assert.rejects(() => new CommandTtsProvider({ commandTemplate: 'rm -rf /' }).speech('hi', { outPath: out }), (e) => e.cls === 'PERMISSION_DENIED');
  await assert.rejects(() => new CommandTtsProvider({ commandTemplate: '`id` {OUT} {TEXT}' }).speech('hi', { outPath: out }), (e) => e.cls === 'PERMISSION_DENIED', 'control token in template refused honestly');
});
