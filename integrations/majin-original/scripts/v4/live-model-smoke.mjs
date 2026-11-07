/** Run only with owner authorization to use the already configured provider. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';

const original = loadConfig();
const route = original.model;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const orchestration = process.argv.includes('--orchestration');
const evidenceArg = process.argv.indexOf('--evidence');
const evidenceFile = evidenceArg >= 0
  ? path.resolve(process.argv[evidenceArg + 1])
  : path.join(root, 'docs/v4/evidence', orchestration ? 'live-orchestration.json' : 'live-model.json');
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
const evidence = { at: new Date().toISOString(), machine: os.hostname(), status: 'BLOCKED', live: false, credentialContentsRecorded: false };
if (!route || route.kind === 'demo') {
  evidence.reason = 'No usable active provider route in the authorized existing configuration.';
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  process.stdout.write('BLOCKED no usable configured provider; no credential was printed or changed\n');
  process.exit(2);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-authorized-live-'));
if (orchestration) {
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4/owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1', version: 1, lanes: ['agent'], folders: [],
    grantedAt: new Date().toISOString(), revokedAt: null, history: [],
  }));
}
// Import V1 transport only after isolating its logging/accounting directories.
process.env.MAJIN_HOME = home;
delete process.env.MAJIN_CONFIG;
const { startV4Server } = await import('../../src/v4/server.js');
const { readSse } = await import('../../test/v4/helpers.mjs');
const config = loadConfig({ env: { ...process.env, MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo' }, argv: [] });
let server;
try {
  const started = await startV4Server({ config: { ...config, port: 0, model: route, demo: false,
    limits: { ...config.limits, maxModelRounds: 8, maxToolCallsPerTurn: 16 } } });
  server = started.server;
  let active = 0;
  let peak = 0;
  let modelCalls = 0;
  const chat = started.context.model.chat.bind(started.context.model);
  started.context.model.chat = async (input) => {
    active += 1; modelCalls += 1; peak = Math.max(peak, active);
    try { return await chat(input); } finally { active -= 1; }
  };
  const base = `http://127.0.0.1:${started.port}`;
  const paired = await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code: started.context.pairingFresh }) });
  if (!paired.ok) throw new Error('PAIRING_FAILED');
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const marker = 'MAJIN_V4_LIVE_' + Date.now().toString(36);
  const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { origin: base, cookie, 'x-majin-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: orchestration
      ? `Use agent_graph once with concurrency 2 and these three steps. Step alpha has no dependencies, tools [workspace_write], task: create live-alpha.txt containing exactly ${marker}. Step beta has no dependencies, tools [workspace_write], task: create live-beta.txt containing exactly ${marker}. Step combine depends on alpha and beta, tools [workspace_read], task: read both live-alpha.txt and live-beta.txt and confirm they contain the same marker. Do not do the independent work in the parent. Report the verified outcome.`
      : `Use workspace_write to create exactly live-proof.txt with exactly this content: ${marker}. Then use workspace_read to verify it and report completion.`, requestId: marker }) });
  const events = await readSse(response);
  const names = orchestration ? ['live-alpha.txt', 'live-beta.txt'] : ['live-proof.txt'];
  const verifiedBytes = names.every((name) => {
    const file = path.join(home, 'workspace', name);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === marker;
  });
  const tools = events.filter((event) => event.type === 'tool_result' && event.data?.ok).map((event) => event.data.name);
  const done = events.find((event) => event.type === 'done')?.data;
  Object.assign(evidence, { live: !started.context.model.info.demo, provider: route.providerName, model: route.model,
    status: verifiedBytes && tools.includes(orchestration ? 'agent_graph' : 'workspace_write')
      && (!orchestration || peak >= 2) && done?.status === 'completed' ? 'PASS' : 'FAIL',
    streaming: events.some((event) => event.type === 'delta'), verifiedBytes, tools, modelCalls,
    peakConcurrentModelCalls: peak, orchestration, turnStatus: done?.status || 'missing' });
  process.stdout.write(`${evidence.status} live provider inference, streaming and verified workspace tool action (keys withheld)\n`);
  process.exitCode = evidence.status === 'PASS' ? 0 : 1;
} catch {
  evidence.status = 'FAIL';
  evidence.reason = 'Live request did not complete; no raw provider error or credentials were recorded.';
  process.stdout.write('FAIL live provider smoke; credentials and raw provider errors withheld\n');
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
