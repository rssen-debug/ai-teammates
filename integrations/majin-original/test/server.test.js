/* MAJIN — servern: autentisering, SPA-utservering, SSE, JSON-felkontrakt.
   Startar en riktig process på en udda port, samma kodväg som en webbläsare använder. */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-http-'));
const TOKEN = 'testtok';
let PORT = 0;
const base = (p) => `http://127.0.0.1:${PORT}${p}`;
let proc = null;
let log = '';

async function free(port = 0) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

function rawReq(p, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const rawGet = (p, headers) => rawReq(p, { headers });

async function get(p, opts = {}) {
  const r = await fetch(base(p), { ...opts, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body: buf.toString('utf8'), bytes: buf };
}

async function pickPort() {
  const srv = net.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));
  return port;
}

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(base('/healthz'));
      if (r.ok) return true;
    } catch {
      /* ej uppe än */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not come up:\n${log}`);
}

before(async () => {
  PORT = await pickPort();
  assert.equal(await free(PORT), true, `port ${PORT} must be free`);
  // En nyckel i hemmet stänger av förstakörningssidans "key required"-gate och
  // ger oss något att bevisa att /api/config rödar nycklar.
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    providers: { openai: { apiKey: 'sk-test-seed-1234' } },
    models: { provider: 'openai' },
    workspace: path.join(home, 'workspace'),
    server: { port: PORT, token: TOKEN },
  }));
  proc = spawn(process.execPath, [path.join(ROOT, 'src/cli/majin.js'), 'serve', '--no-browser', '--channels=false', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, MAJIN_HOME: home, MAJIN_TOKEN: TOKEN, MAJIN_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  await waitUp();
});

after(async () => {
  if (proc && proc.exitCode === null) proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(home, { recursive: true, force: true });
});

test('/healthz and /api/hello stay open', async () => {
  const h = await get('/healthz');
  assert.equal(h.status, 200);
  assert.equal(JSON.parse(h.body).ok, true);
  const hello = await get('/api/hello?t=nej');
  assert.equal(hello.status, 200);
  assert.equal(JSON.parse(hello.body).name, 'MAJIN');
});

test('completed task follow-up is running in the same session, then completes its next run', async () => {
  const config = JSON.parse((await get(`/api/config?t=${TOKEN}`)).body).config;
  const routes = Object.fromEntries(Object.keys(config.models.routes).map(job => [job, 'demo/demo-fast']));
  await get(`/api/config?t=${TOKEN}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: { provider: 'demo', routes }, moa: { policy: 'off' } }) });
  const first = await get(`/api/chat?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi', autopilot: true, stream: false }) });
  const task = JSON.parse(first.body).task;
  assert.ok(task);
  const response = await fetch(base(`/api/chat?t=${TOKEN}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi again', task }) });
  assert.equal(response.status, 200);
  const running = JSON.parse((await get(`/api/tasks?t=${TOKEN}`)).body).tasks.find(t => t.id === task);
  assert.equal(running.status, 'running');
  assert.equal(running.run, 2);
  await response.text();
  const done = JSON.parse((await get(`/api/tasks?t=${TOKEN}`)).body).tasks.find(t => t.id === task);
  assert.equal(done.status, 'done');
  assert.equal(done.run, 2);
});

test('workspace data APIs and isolated memory writes work over real HTTP', async (t) => {
  for (const endpoint of ['state?tools=0', 'tasks', 'usage', 'memory', 'skills', 'dataset', 'tools', 'schedule', 'channels', 'approvals', 'sessions', 'history?session=audit-missing', 'logs?n=3']) {
    await t.test(endpoint, async () => {
      const r = await get(`/api/${endpoint}${endpoint.includes('?') ? '&' : '?'}t=${TOKEN}`);
      assert.equal(r.status, 200, r.body.slice(0, 120));
      const payload = JSON.parse(r.body);
      if (endpoint.startsWith('state?')) assert.ok(payload.version && payload.config);
      else assert.equal(payload.ok, true);
    });
  }
  const marker = 'audit-memory-roundtrip-11927';
  const older = 'audit-memory-older-11928';
  const post = body => get(`/api/memory?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post({ text: older });
  assert.equal((await post({ text: marker })).status, 200);
  const saved = JSON.parse((await get(`/api/memory?q=${marker}&t=${TOKEN}`)).body);
  assert.ok(saved.facts.some(f => f.text === marker));
  assert.ok(JSON.parse((await get(`/api/memory?q=${older}&t=${TOKEN}`)).body).facts.some(f => f.text === older), 'saving another fact preserves earlier notes');
  await post({ action: 'forget', query: marker });
  const forgotten = JSON.parse((await get(`/api/memory?q=${marker}&t=${TOKEN}`)).body);
  assert.equal(forgotten.facts.some(f => f.text === marker), false);
  assert.ok(JSON.parse((await get(`/api/memory?q=${older}&t=${TOKEN}`)).body).facts.some(f => f.text === older), 'forgetting one fact preserves other notes');
});

test('skills and scheduler mutations reach their handlers instead of the GET response', async () => {
  const post = (endpoint, body) => get(`/api/${endpoint}?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const skill = JSON.parse((await post('skills', { name: 'audit skill 1291', when: 'audit check', steps: 'Read the local fixture.' })).body);
  assert.equal(skill.ok, true);
  assert.ok(skill.file, 'POST creates the skill file, rather than returning a list');
  const list = JSON.parse((await get(`/api/skills?t=${TOKEN}`)).body).skills;
  assert.ok(list.some(s => s.name === 'audit skill 1291'));
  const scheduled = await post('schedule', { when: '2099-01-01 12:00', task: 'hi', deliver: 'silent', name: 'audit-only' });
  assert.equal(scheduled.status, 200, scheduled.body);
  const job = JSON.parse(scheduled.body).job;
  assert.ok(job?.id, 'POST creates a future job without executing it');
  const jobs = JSON.parse((await get(`/api/schedule?t=${TOKEN}`)).body).jobs;
  assert.ok(jobs.some(j => j.id === job.id));
  const removed = JSON.parse((await get(`/api/schedule?id=${job.id}&t=${TOKEN}`, { method: 'DELETE' })).body);
  assert.equal(removed.ok, true);
  assert.equal(JSON.parse((await get(`/api/schedule?t=${TOKEN}`)).body).jobs.some(j => j.id === job.id), false);
  assert.equal((await post('schedule', { when: 'not a time', task: 'hi' })).status, 422);
});

test('SPA: index, /panel deep links and logo.png are served', async () => {
  const html = await get('/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.body, /MAJIN/, 'the brand must be in the html');
  assert.match(html.body, /id="c-wa"/, 'the whatsapp chip must exist in index');
  assert.match(html.body, /id="brand"/, 'the brand in the header');
  assert.match(html.body, /rel="icon"/, 'favicon-länk måste finnas');
  assert.match(html.body, /app\.js/, 'no ES modules or bundlers — classic script');
  const panel = await get('/panel');
  assert.equal(panel.status, 200, 'SPA deep links must fall back to index');
  assert.match(panel.body, /id="c-wa"/, 'the fallback must be the real UI');
  const logo = await get('/logo.png');
  assert.equal(logo.status, 200, 'logo.png must be served');
  assert.match(logo.headers.get('content-type'), /image\/png/);
  assert.equal(logo.bytes.readUInt32BE(0), 0x89504e47, 'logo måste vara en riktig PNG');
  assert.ok(logo.bytes.length > 4096, 'the logo must not be a stub');
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/, 'app.js must be served as javascript');
  const panels = await get('/panels.js');
  assert.equal(panels.status, 200, 'panels.js must ship too');
  const missing = await get('/finns-inte.png');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /not found/, 'the 404 must be English');
  const trav = await rawReq('/../../etc/passwd');
  assert.doesNotMatch(trav.body, /root:.*:0:0:/, 'path traversal must not leak /etc/passwd');
  const trav2 = await rawReq('/api/../../etc/passwd');
  assert.doesNotMatch(trav2.body, /root:.*:0:0:/, 'also via the api path');
});

test('token: query, header, cookie — and refusal from outside', async () => {
  const noAuth = await get('/api/state');
  assert.equal(noAuth.status, 200, 'loopback is trusted by default (server.trustLocal)');
  const evil = await rawGet('/api/state', { Host: 'evil.example' });
  assert.equal(evil.status, 401, 'an alien host without a token must be refused');
  assert.equal(JSON.parse(evil.body).error, 'token required');
  assert.match(evil.body, /\?t=/, 'the 401 must say how to authenticate');
  for (const [label, opts] of Object.entries({
    q: { headers: { Host: 'evil.example' } },
  })) {
    const withQuery = await rawGet(`/api/state?t=${TOKEN}`, { Host: 'evil.example' });
    assert.equal(withQuery.status, 200, 'a token in the query must work');
    assert.equal((await rawGet('/api/state', { Host: 'evil.example', authorization: `Bearer ${TOKEN}` })).status, 200, 'bearer must work');
    assert.equal((await rawGet('/api/state', { Host: 'evil.example', cookie: `majin=${TOKEN}` })).status, 200, 'the cookie must work');
    assert.equal((await rawGet('/api/state', { Host: 'evil.example', 'x-majin-token': TOKEN })).status, 200, 'x-majin-token must work');
    assert.equal((await rawGet('/api/state?t=fel', { Host: 'evil.example' })).status, 401, 'a wrong token must be refused');
    assert.equal((await rawReq('/api/chat', { method: 'POST', headers: { Host: 'evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 401, 'alien host without a token must be refused');
  }
});

test('fleet commands through /api/chat are deterministic (zero model calls, plain words)', async () => {
  const one = async (input) => {
    const r = await fetch(base('/api/chat?t=' + TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ input, stream: false }),
    });
    return { status: r.status, json: JSON.parse(await r.text()) };
  };
  const st = await one('visa alla agenter');
  assert.equal(st.status, 200);
  assert.equal(st.json.ok, true);
  assert.match(st.json.text, /No agents are running/, 'an empty fleet says so to your face');
  const bad = await one('stoppa agent 9');
  assert.equal(bad.json.ok, false);
  assert.match(String(bad.json.error), /no agents are running/, 'unknown agents are honest, never guessed (empty fleet says so outright)');
  const help9 = await one('hjälp agent 9');
  assert.equal(help9.json.ok, false, 'assist to a ghost is refused too');
});

test('/api/tasks/action: guard discipline over real HTTP (unknown, wrong state, unknown action)', async () => {
  // demo-providern = den lokala stand-in: ett ärligt task faktiskt Skapat via API:t
  await fetch(base('/api/config?t=' + TOKEN), { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ models: { provider: 'demo', routes: { chat: 'demo/demo-fast' } } }) });
  const made = await fetch(base('/api/chat?t=' + TOKEN), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ input: 'kort-paustest', autopilot: true, stream: false }) });
  assert.equal(made.status, 200);
  const task = JSON.parse(await made.text()).task;
  assert.ok(task, 'the chat endpoint handed us a real task id');
  const act = async (id, action) => {
    const r = await fetch(base('/api/tasks/action?t=' + TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ task: id, action }),
    });
    return JSON.parse(await r.text());
  };
  const bad = await act('nonsense-task', 'pause');
  assert.equal(bad.ok, false, 'unknown tasks are refused');
  const bogus = await act(task, 'explode');
  assert.equal(bogus.ok, false);
  assert.match(String(bogus.error), /unknown action/, 'unknown actions are named, not swallowed');
  const st = await fetch(base('/api/tasks?t=' + TOKEN), { headers: { authorization: 'Bearer ' + TOKEN } });
  const mine = JSON.parse(await st.text()).tasks.find((x) => x.id === task);
  assert.ok(mine, 'the task is in the registry');
  const pauseRes = await act(task, 'pause');
  if (mine.status === 'done' || mine.status === 'error') {
    assert.equal(pauseRes.ok, false, 'pause on a finished task refuses in plain words');
    assert.match(String(pauseRes.error), new RegExp('is ' + mine.status));
  } else {
    assert.equal(pauseRes.ok, true, 'pause on a live task works');
  }
  const resumeWrong = await act(task, 'resume');
  assert.equal(resumeWrong.ok, false, 'resume on a non-paused task refuses');
});

test('/api/state and /api/config: right shape and redacted keys', async () => {
  const st = JSON.parse((await get(`/api/state?t=${TOKEN}`)).body);
  assert.equal(st.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, 'the app must report the version it was released as');
  assert.equal(st.name, 'MAJIN');
  assert.equal(st.tools.length, 149, 'state must list each integrated tool, including github, browser, media and plugin capabilities');
  assert.equal(JSON.parse((await get(`/api/state?tools=0&t=${TOKEN}`)).body).tools.count, 149);
  assert.ok(st.groups.reverse.length >= 20, 'groups for the UI');
  assert.equal(st.guard.mode, 'confirm', 'the default mode is confirm');
  assert.ok(Array.isArray(st.routes) && st.routes.some((r) => r.job === 'tasks' && r.ref), 'the route table must exist');
  const cfg = JSON.parse((await get(`/api/config?t=${TOKEN}`)).body);
  assert.equal(cfg.ok, true);
  assert.ok(!JSON.stringify(cfg).includes('sk-test-seed'), 'real keys must not leak');
  assert.match(JSON.stringify(cfg), /set|\*\*\*|redacted/i, 'the redacted marker must still be visible');
  const bad = await get(`/api/config?t=${TOKEN}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"workspace":' });
  assert.ok([400, 422].includes(bad.status), `broken JSON must be refused, got  ${bad.status}`);
  assert.ok(JSON.parse(bad.body).errors, 'the 400 must carry field errors');
  const unknown = await get(`/api/config?t=${TOKEN}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }) });
  assert.ok(unknown.body.includes('nope'), 'the unknown key must be named in the error');
});

test('Meta marketing setup happens conversationally with ZERO model call or permanent panel', async () => {
  const page = await get('/index.html');
  assert.doesNotMatch(page.body, /<h3>MARKETING<\/h3>/, 'no permanent marketing UI');
  assert.match(page.body, /\/marketing\.js/, 'contextual secure connection UI is shipped');
  const formSrc = (await get('/marketing.js')).body;
  assert.match(formSrc, /window\.MAJIN_MARKETING/);
  assert.doesNotMatch(formSrc, /id="marketing"/);
  const chat = async (stream) => {
    const res = await fetch(base('/api/chat?t=' + TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'MAJIN optimera mina Facebook ads kampanjer', stream }),
    });
    return { status: res.status, text: await res.text() };
  };
  const plain = await chat(false);
  assert.equal(plain.status, 200);
  const data = JSON.parse(plain.text);
  assert.equal(data.needsMarketingSetup, true);
  assert.ok(!data.text.includes('sk-test-seed'));
  const sse = await chat(true);
  assert.equal(sse.status, 200);
  assert.match(sse.text, /event: marketing_setup/);
  assert.match(sse.text, /event: answer/);
  assert.doesNotMatch(sse.text, /private-test-token|sk-test-seed/);

  const metaToken = 'dont-leak-this-meta-key';
  const req = await get('/api/marketing?t=' + TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'save', accountId: 'act_1234567', currency: 'USD', accessToken: metaToken,
      economics: { price: 50, cogs: 10, shipping: 3, fees: 2, refundRate: 0.05, targetProfit: 10, dailyCap: 15 },
    }),
  });
  assert.equal(req.status, 200, req.body.slice(0,300));
  assert.doesNotMatch(req.body, /dont-leak-this-meta-key/);
  assert.equal(JSON.parse(req.body).connected, true);
  const saved = (await get('/api/config?t=' + TOKEN)).body;
  assert.doesNotMatch(saved, /dont-leak-this-meta-key/, 'Meta token must be masked in config API');
  const state = (await get('/api/marketing?t=' + TOKEN)).body;
  assert.doesNotMatch(state, /dont-leak-this-meta-key/);
  assert.equal(JSON.parse(state).mode,'analysis_only');
});

test('CLI config set while MAJIN runs goes through the live server and survives restart', async () => {
  const marker='cli-live-ownership-test';
  const cmd=spawnSync(process.execPath, [path.join(ROOT,'src/cli/majin.js'),'config','set','name',marker], {
    cwd:ROOT,
    env:{...process.env,MAJIN_HOME:home,MAJIN_PORT:String(PORT),MAJIN_TOKEN:TOKEN},
    encoding:'utf8',
    timeout:15000,
  });
  assert.equal(cmd.status,0, 'CLI exited without success: '+cmd.stderr+'\n'+cmd.stdout);
  assert.match(cmd.stdout,/running MAJIN/, 'second process must delegate change to live runtime');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8')).name,marker,'disk config must contain marker');
  const live=JSON.parse((await get('/api/state?t='+TOKEN)).body);
  assert.equal(live.name,marker,'running server must have same config value');
  const restore=await get('/api/config?t='+TOKEN, {method:'PATCH',
    headers:{'content-type':'application/json'},body:JSON.stringify({name:'MAJIN'})});
  assert.equal(restore.status,200);
});

test('TikTok + Google Ads request credentials privately in chat, never in model history',async()=>{
  const request=async(prompt)=>get('/api/chat?t='+TOKEN,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({input:prompt,stream:true}),
  });
  const tiktok=await request('MAJIN analysera TikTok Ads kampanjer');
  assert.equal(tiktok.status,200);
  assert.match(tiktok.body,/event: marketing_channel_setup/);
  assert.match(tiktok.body,/"platform":"tiktok"/);
  const google=await request('Analysera Google Ads annonser');
  assert.equal(google.status,200);
  assert.match(google.body,/"platform":"google"/);
  const general=await request('What is TikTok Ads?');
  assert.doesNotMatch(general.body,/event: marketing_channel_setup/,'general knowledge question should not ask for credentials');
  const src=(await get('/marketing.js')).body;
  assert.match(src,/showChannel/);
  const html=(await get('/index.html')).body;
  assert.doesNotMatch(html,/<h3>(TIKTOK|GOOGLE ADS)<\/h3>/,'no new permanent panels');
});

test('TikTok and Google credential endpoints save account details but never echo private tokens',async()=>{
  const tikTokSecret='test-only-tiktok-token-private';
  const googleSecret='test-only-google-oauth-private';
  const developerSecret='test-only-google-developer-private';
  const save=async body=>get('/api/marketing/channel?t='+TOKEN,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  });
  const tik=await save({action:'save',platform:'tiktok',advertiserId:'7123456789',currency:'SEK',accessToken:tikTokSecret});
  assert.equal(tik.status,200,tik.body);
  assert.doesNotMatch(tik.body,/test-only/);
  const goog=await save({action:'save',platform:'google',customerId:'1234567890',loginCustomerId:'',currency:'USD',accessToken:googleSecret,developerToken:developerSecret});
  assert.equal(goog.status,200,goog.body);
  assert.doesNotMatch(goog.body,/test-only/);
  const status=JSON.parse((await get('/api/marketing/channel?t='+TOKEN)).body);
  assert.equal(status.channels.tiktok.configured,true);
  assert.equal(status.channels.google.configured,true);
  assert.equal(status.channels.google.authorization,'credentials_saved_not_verified');
  const config=(await get('/api/config?t='+TOKEN)).body;
  for(const secret of [tikTokSecret,googleSecret,developerSecret])assert.ok(!config.includes(secret),'must redact '+secret);
  assert.equal((await save({action:'save',platform:'tiktok',advertiserId:'bad',currency:'SEK'})).status,422);
  assert.equal((await save({action:'disconnect',platform:'google'})).status,200);
  const end=JSON.parse((await get('/api/marketing/channel?t='+TOKEN)).body);
  assert.equal(end.channels.google.configured,false);
  assert.equal(end.channels.tiktok.configured,true);
});

test('/api/chat: demo answer without stream, 400 on empty input', async () => {
  const sw = await get(`/api/config?t=${TOKEN}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: { provider: 'demo', routes: { chat: 'demo/demo-fast' } } }) });
  assert.equal(sw.status, 200, JSON.stringify(sw.body).slice(0, 200));
  const post = async (payload) => {
    const r = await fetch(base(`/api/chat?stream=false&t=${TOKEN}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* icke-json */ }
    return { status: r.status, json, txt };
  };
  const a = await post({ input: 'hej där', session: 'http', stream: false });
  assert.equal(a.status, 200, a.txt.slice(0, 200));
  assert.equal(a.json.ok, true, JSON.stringify(a.json).slice(0, 240));
  const b = await post({ prompt: 'alias-formen', session: 'http', stream: false });
  assert.equal(b.status, 200, 'prompt must be accepted as an alias');
  const c = await post({ messages: [{ role: 'user', content: 'meddelande-formen' }], session: 'http', stream: false });
  assert.equal(c.status, 200, 'messages[] must be accepted');
  const streamForm = await fetch(base(`/api/chat?stream=false&t=${TOKEN}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'query-formen', session: 'http' }) });
  assert.equal(streamForm.status, 200);
  assert.match(streamForm.headers.get('content-type') || '', /application\/json/, '?stream=false must give JSON, not SSE');
  await streamForm.text();
  const empty = await post({});
  assert.equal(empty.status, 400);
  assert.match(JSON.stringify(empty.json), /empty input/, 'the 400 must explain');
});

test('/api/events: SSE headers, retry and streaming events', async () => {
  const ac = new AbortController();
  const res = await fetch(base(`/api/events?t=${TOKEN}`), { headers: { accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(res.headers.get('x-accel-buffering'), 'no', 'proxies must not buffer the stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const head = Buffer.from(value).toString('utf8');
  assert.match(head, /retry: 15000/, 'the reconnect directive must exist');
  // trigga ett event och läsa det
  await get(`/api/config?t=${TOKEN}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ui: { theme: 'jarvis' } }) });
  let rest = '';
  for (let i = 0; i < 6 && !/event: /.test(rest); i += 1) {
    const r = await reader.read();
    if (r.done) break;
    rest += Buffer.from(r.value).toString('utf8');
  }
  assert.match(rest, /event: /, 'events must stream');
  ac.abort();
});

test('authOk: the trusted-host rule cannot be reached from outside', async () => {
  const { authOk } = await import('../src/core/server/index.js');
  const cfg = { get: (k) => ({ 'server.trustLocal': true, 'server.allowRemote': false })[k] };
  const url = new URL('http://localhost:8787/api/state');
  const req = (host) => ({ headers: { host } });
  assert.equal(authOk(req('localhost:8787'), url, 'sekret', cfg, '127.0.0.1'), true, 'loopback peer + local host = no token');
  assert.equal(authOk(req('localhost:8787'), url, 'sekret', cfg, '10.0.0.5'), false, 'DNS rebinding: local Host from a remote peer must be refused');
  assert.equal(authOk(req('evil.example'), url, 'sekret', cfg, '127.0.0.1'), false, 'alien host needs the token');
  assert.equal(authOk(req('evil.example'), new URL('http://evil.example/api/state?t=sekret'), 'sekret', cfg, '10.0.0.5'), true, 'a token always works');
  assert.equal(authOk(req('evil.example'), url, '', cfg, '10.0.0.5'), true, 'no token configured = open (fresh install, loopback only)');
  const noTrust = { get: (k) => ({ 'server.trustLocal': false, 'server.allowRemote': false })[k] };
  assert.equal(authOk(req('localhost'), url, 'sekret', noTrust, '127.0.0.1'), false, 'trustLocal:false måste gälla även lokalt');
});

test('/api/keys/claim + /api/tool: pairing flow and tool calls', async () => {
  const pair = JSON.parse((await get(`/api/keys/pair?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).body);
  assert.match(String(pair.code), /^[A-Za-z0-9]{6,}$/, 'a one-time code must exist');
  assert.equal(pair.expiresSec, 300);
  assert.match(pair.url, /\?t=/, 'the pair URL must carry the token');
  const claim = await fetch(base(`/api/keys/claim?code=${pair.code}&provider=openai&key=sk-test-1234`), { method: 'POST' });
  assert.equal(claim.status, 200, 'claim must work without a token');
  const st = JSON.parse((await get(`/api/state?t=${TOKEN}`)).body);
  const openai = st.providers.find((p) => p.name === 'openai');
  assert.equal(openai.hasKey, true, 'the key must be stored');
  assert.equal(openai.ready, true, 'the provider must become ready from the paired key');
  assert.equal(JSON.parse((await get(`/api/state?t=${TOKEN}`)).body).needsSetup, false, 'the first-run gate must open');
  const again = await fetch(base(`/api/keys/claim?code=${pair.code}&provider=openai&key=sk-test-1234`), { method: 'POST' });
  assert.notEqual(again.status, 200, 'the one-time code must be single use');
  const tool = JSON.parse((await get(`/api/tool?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'fs.write', args: { path: 'http-prov.txt', content: 'från http\n' } }) })).body);
  assert.equal(tool.ok, true, JSON.stringify(tool));
  assert.ok(fs.existsSync(path.join(home, 'workspace', 'http-prov.txt')), 'the tool must write in the workspace');
  const badTool = JSON.parse((await get(`/api/tool?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nsaknas' }) })).body);
  assert.equal(badTool.error.code, 'unknown_tool');
  assert.match(badTool.error.message, /does not exist|finns inte/);
});

// This uses the actual server route, not a mocked browser response.
test('/api/models discovers every Anthropic page and preserves the last good list after failure', async (t) => {
  let rejectCatalog = false;
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] });
    res.setHeader('content-type', 'application/json');
    if (rejectCatalog) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'invalid key' } })); return; }
    if (req.url.includes('after_id=')) res.end(JSON.stringify({ data: [{ id: 'claude-final' }], has_more: false }));
    else res.end(JSON.stringify({ data: Array.from({ length: 650 }, (_, i) => ({ id: 'claude-' + i })), has_more: true, last_id: 'claude-649' }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const added = JSON.parse((await get(`/api/provider?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', name: 'catalog-fixture', kind: 'anthropic', baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'catalog-fixture-key' }) })).body);
  assert.equal(added.ok, true);
  const result = JSON.parse((await get(`/api/models?provider=catalog-fixture&t=${TOKEN}`)).body);
  assert.equal(result.ok, true);
  assert.equal(result.count, 651);
  assert.ok(seen.every(req => req.key === 'catalog-fixture-key' && req.version === '2023-06-01'));
  const cfg = JSON.parse((await get(`/api/config?t=${TOKEN}`)).body).config;
  assert.equal(cfg.providers['catalog-fixture'].models.length, 651);
  assert.doesNotMatch(JSON.stringify(result), /catalog-fixture-key/);
  rejectCatalog = true;
  const failed = JSON.parse((await get(`/api/models?provider=catalog-fixture&t=${TOKEN}`)).body);
  assert.equal(failed.ok, false);
  assert.equal(failed.models, undefined);
  const afterFailure = JSON.parse((await get(`/api/config?t=${TOKEN}`)).body).config;
  assert.equal(afterFailure.providers['catalog-fixture'].models.length, 651);
});

test('/api/tools exposes live JSON Schema contracts, not only parameter names', async () => {
  const r = await get(`/api/tools?t=${TOKEN}`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  for (const [name, required] of Object.entries({
    'shell.run': ['command'],
    'browser.open': ['url'],
    'fs.write': ['path', 'content'],
    'sys.ps': [],
  })) {
    const t = j.tools.find((tool) => tool.name === name);
    assert.ok(t, `${name} present in installed registry`);
    assert.deepEqual(t.parameters.required, required, `${name} exact required keys`);
    assert.equal(t.parameters.type, 'object');
  }
});


test('workspace previews serve actual files including Windows-style workspace prefixes, never outside paths', async () => {
  const root = path.join(home, 'workspace');
  const nested = path.join(root, 'preview-audit');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'index.html'), '<h1>MAJIN preview audited</h1>');
  const read = async file => get('/api/file?path=' + encodeURIComponent(file) + '&t=' + TOKEN);
  for (const name of ['preview-audit/index.html', 'workspace/preview-audit/index.html', 'workspace\\preview-audit\\index.html']) {
    const result = await read(name);
    assert.equal(result.status, 200, name + ': ' + result.body);
    assert.match(result.body, /MAJIN preview audited/);
  }
  const missing = await read('preview-audit/absent.html');
  assert.equal(missing.status, 404);
  const blocked = await read('../config.json');
  assert.equal(blocked.status, 403, 'do not expose files outside workspace');
  const link = path.join(nested, 'escape.html');
  try {
    fs.symlinkSync(path.join(home, 'config.json'), link);
    assert.equal((await read('preview-audit/escape.html')).status, 403, 'symlink must not bypass workspace restrictions');
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
  } finally { fs.rmSync(link, { force: true }); }
});
