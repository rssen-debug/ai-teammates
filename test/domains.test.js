/* GRAND ARCHITECT Acceptans — Del 4D: REAL cross-domain tasks with
   independently checked results. Four domains now verify by CODE, not by
   asking a model: file (legacy), command (real exit code), JSON (real parse
   + key presence), HTTP (real fetch). Every check runs against actual bytes
   / processes / network from the mission workspace. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-dom-'));

const { verifyContract, buildContracts, runMission } = await import('../src/core/mission.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { setScript, resetCalls, lastCalls } = await import('../src/core/provider/mock.js');

const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'majin-domws-'));
// A cold Windows shell can take several seconds on a busy test host.
const cfgOf = (ws) => ({ get: (k) => (k === 'workspace' ? ws : k === 'missions.contractCmdTimeoutMs' ? 30000 : undefined) });
const serve = (txt) => new Promise((res) => {
  const s = http.createServer((req, r) => r.end(txt));
  s.listen(0, '127.0.0.1', () => res({ close: () => s.close(), url: `http://127.0.0.1:${s.address().port}` }));
});

test('4D.1 command domain: exit code is the evidence — pass, fail, denied', async () => {
  const ws = mkws();
  fs.writeFileSync(path.join(ws, 'ok.cjs'), 'console.log("hello-from-script"); process.exit(0);');
  fs.writeFileSync(path.join(ws, 'bad.cjs'), 'console.log("oops"); process.exit(3);');
  const ok = await verifyContract({ type: 'command_exits_zero', cmd: 'node ok.cjs' }, { cfg: cfgOf(ws) });
  assert.equal(ok.ok, true, ok.evidence);
  assert.match(ok.evidence, /exited 0/); assert.match(ok.evidence, /hello-from-script/);
  const bad = await verifyContract({ type: 'command_exits_zero', cmd: 'node bad.cjs' }, { cfg: cfgOf(ws) });
  assert.equal(bad.ok, false); assert.match(bad.evidence, /exit 3|failed/);
  const denied = await verifyContract({ type: 'command_exits_zero', cmd: 'rm -rf /' }, { cfg: cfgOf(ws) });
  assert.equal(denied.ok, false); assert.match(denied.evidence, /guardrail/);
});

test('4D.2 json domain: real parse + keys — valid passes, missing key names it, garbage is named', async () => {
  const ws = mkws();
  fs.writeFileSync(path.join(ws, 'cfg.json'), JSON.stringify({ host: 'x', port: 1, extra: true }));
  fs.writeFileSync(path.join(ws, 'nope.json'), 'this is not json {');
  const ok = await verifyContract({ type: 'json_topkeys', path: 'cfg.json', keys: ['host', 'port'] }, { cfg: cfgOf(ws) });
  assert.equal(ok.ok, true, ok.evidence);
  const missing = await verifyContract({ type: 'json_topkeys', path: 'cfg.json', keys: ['host', 'apiKey'] }, { cfg: cfgOf(ws) });
  assert.equal(missing.ok, false); assert.match(missing.evidence, /missing keys \[apiKey\]/);
  const garbage = await verifyContract({ type: 'json_topkeys', path: 'nope.json', keys: ['host'] }, { cfg: cfgOf(ws) });
  assert.equal(garbage.ok, false); assert.match(garbage.evidence, /not parse as JSON/);
  const escape = await verifyContract({ type: 'json_topkeys', path: '../../etc/passwd', keys: ['x'] }, { cfg: cfgOf(ws) });
  assert.equal(escape.ok, false); assert.match(escape.evidence, /escapes the workspace/);
});

test('4D.3 http domain: real fetch — marker found passes, absent names it, remote http refused', async () => {
  const srv = await serve('<html>gateway status: OK — build 613</html>');
  const ws = mkws();
  const ok = await verifyContract({ type: 'url_contains', url: srv.url + '/health', needle: 'status: OK' }, { cfg: cfgOf(ws) });
  srv.close();
  assert.equal(ok.ok, true, ok.evidence);
  assert.match(ok.evidence, /→ 200/);
  const srv2 = await serve('<html>nothing</html>');
  const miss = await verifyContract({ type: 'url_contains', url: srv2.url, needle: 'will never be here' }, { cfg: cfgOf(ws) });
  srv2.close();
  assert.equal(miss.ok, false); assert.match(miss.evidence, /does NOT contain/);
  const remote = await verifyContract({ type: 'url_contains', url: 'http://evil.example.net/x', needle: 'a' }, { cfg: cfgOf(ws) });
  assert.equal(remote.ok, false); assert.match(remote.evidence, /must be https/);
});

test('4D.4 buildContracts derives all three new phrasings — narrow on purpose', () => {
  const cs = buildContracts('1. write the file report.json with json keys "status engine version"\n2. make command "node app.js --check" exits 0\n3. fetch http://localhost:9999/health and confirm it contains "ready"');
  const types = cs.map((c) => c.type).sort();
  assert.ok(types.includes('command_exits_zero') && types.includes('json_topkeys') && types.includes('url_contains') && types.includes('file_exists'), `derived: ${JSON.stringify(cs.map((c) => c.type))}`);
  assert.equal(cs.find((c) => c.type === 'command_exits_zero').cmd, 'node app.js --check');
  assert.deepEqual(cs.find((c) => c.type === 'json_topkeys').keys, ['status', 'engine', 'version']);
});

test('4D.5 E2E cross-domain mission: file+json, repair on lies, VERIFIED markers', async () => {
  const ws = mkws();
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  resetCalls();
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: [
    { id: 'w1', input: 'write the file state.json with json keys "engine ready version"', deps: [], estMs: 30000 },
    { id: 'w2', input: 'tell me the weather in two words', deps: [], estMs: 1000 },
  ] }) }]);
  resetCalls();
  setScript('sub:tasks', [
    /* w1 attempt 1: LIES — claims the file, never writes it */
    { text: 'state.json written with keys engine ready version, all good' },
    /* w2 (parallel, independent) — honest small answer */
    { text: 'sunny calm' },
    /* w1 repair attempt: actually writes it */
    { text: 'writing for real now', toolCalls: [{ name: 'fs.write', args: { path: 'state.json', content: JSON.stringify({ engine: 'majin', ready: true, version: '0.6.8' }) } }] },
    { text: 'state.json written with json keys engine ready version — verified content created' },
  ]);
  const m = await runMission({
    cfg: rt.cfg, registry: rt.registry, session: 'dom-e2e',
    input: '1. write the file state.json with json keys "engine ready version"\n2. tell me the weather in two words',
    emit: () => {}, capOverride: 2,
  });
  assert.equal(m.kind, 'mission');
  assert.match(m.textSummary.join('\n'), /repair/i, 'the lying path must trigger a repair round');
  assert.match(m.textSummary.join('\n'), /VERIFIED/, 'after repair the artifact gets verified');
  const data = JSON.parse(fs.readFileSync(path.join(ws, 'state.json'), 'utf8'));
  assert.equal(data.engine, 'majin'); assert.equal(data.ready, true);
  await rt.shutdown();
});
