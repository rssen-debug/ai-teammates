/* GRAND ARCHITECT Acceptans — Del 7D: a NEW capability runs end-to-end through
   the existing engine: validated descriptor (7B, re-read + re-validated per
   call) → permission class → approval gate for external writes → disk-backed
   rolling-hour rate limit → timeout → json mapping → self-disable after
   repeat failures → explicit enable. Proven against a LOCAL http server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Adapters, mapRows } from '../src/core/adapters.js';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adp7d-'));
const mk = (dir, extra = {}) => {
  const map = new Map([['adapters.dir', dir], ...Object.entries(extra)]);
  return new Adapters({ get: (k, d) => (map.has(k) ? map.get(k) : d ?? undefined) });
};

const server = (handler) => new Promise((res) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` }));
});

test('7D.1 read adapter: GET → json → dotted-path rows, end to end', async () => {
  const { s, url } = await server((req, res) => res.end(JSON.stringify({ items: [{ name: 'job A', city: 'hudiksvall' }, { name: 'job B', city: 'sundsvall' }] })));
  const dir = mkDir(); const a = mk(dir);
  const cr = a.create({ name: 'pb-dev', kind: 'http-json', baseUrl: url + '/api', permission: 'read', headers: {}, mapping: { title: 'items.0.name', city: 'items.0.city' }, timeoutMs: 5000, rate: { maxPerHour: 60 } });
  assert.equal(cr.ok, true);
  const r = await a.call('pb-dev');
  s.close();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.rows, [{ title: 'job A', city: 'hudiksvall' }, { title: 'job B', city: 'sundsvall' }], 'mapping enumerates the array');
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.state-pb-dev.json'), 'utf8'));
  assert.equal(st.calls.length, 1, 'the call is recorded on disk');
  assert.equal(st.streak, 1, 'success recorded honestly');
});

test('7D.2 disk-described descriptor is re-validated per call (defense in depth)', async () => {
  const dir = mkDir(); const a = mk(dir);
  a.create({ name: 'mut', kind: 'http-json', baseUrl: 'http://127.0.0.1:9/ok', permission: 'read', headers: {}, mapping: {}, timeoutMs: 5000, rate: { maxPerHour: 60 } });
  /* attacker hand-edits the descriptor to a remote non-TLS target */
  fs.writeFileSync(path.join(dir, 'mut.json'), JSON.stringify({ name: 'mut', kind: 'http-json', baseUrl: 'http://evil.example.net/x', permission: 'read', headers: {}, mapping: {}, timeoutMs: 5000, rate: { maxPerHour: 60 } }));
  const r = await a.call('mut');
  assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid_spec', 'per-call validation rejects the smuggled target');
});

test('7D.3 external-post requires THE HUMAN (approval arg + gate), posts json, self-disables on repeat failure, enable resurrects', async () => {
  let posted = 0; let last;
  const { s, url } = await server((req, res) => {
    if (req.method === 'POST') { posted++; let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { last = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(`{"ok":true}`); }); }
    else { res.end(); }
  });
  const dir = mkDir(); const a = mk(dir);
  a.create({ name: 'pub', kind: 'http-json', baseUrl: url + '/submit', permission: 'external-post', headers: {}, mapping: { result: 'ok' }, timeoutMs: 5000, rate: { maxPerHour: 60 } });

  const no = await a.call('pub', { params: { title: 'x' }, approved: false });
  assert.equal(no.ok, false); assert.equal(no.error.code, 'approval_required', 'never runs without the human flag');
  assert.equal(posted, 0, 'NOTHING was posted');

  const gate = { asked: 0, request: async (req, t) => { gate.asked++; assert.equal(String(req.tool), 'majin.adapter:pub'); return { approved: true }; } };
  const yes = await a.call('pub', { params: { bid: 3, title: 'job A' }, approved: true, approvals: gate });
  assert.equal(gate.asked, 1, 'the engine approval gate was actually consulted');
  assert.equal(yes.ok, true); assert.equal(posted, 1);
  assert.deepEqual(last, { bid: 3, title: 'job A' }, 'json body arrived unharmed');

  /* denial path: gate says no */
  const deny = { request: async () => ({ approved: false, why: 'declined' }) };
  const refused = await a.call('pub', { params: {}, approved: true, approvals: deny });
  assert.equal(refused.ok, false); assert.equal(refused.denied, true); assert.equal(posted, 1, 'declined decision never hits the wire');

  /* repeat failures disable the adapter itself */
  const { s: bad, url: badUrl } = await server((req, res) => { res.statusCode = 500; res.end('boom'); });
  fs.writeFileSync(path.join(dir, 'pub.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'pub.json'), 'utf8')), baseUrl: badUrl + '/submit' }));
  for (let i = 0; i < 3; i++) { const rr = await a.call('pub', { params: {}, approved: true, approvals: { request: async () => ({ approved: true }) } }); assert.equal(rr.ok, false); }
  const dead = await a.call('pub', { params: {}, approved: true, approvals: { request: async () => ({ approved: true }) } });
  assert.equal(dead.ok, false); assert.equal(dead.error.code, 'adapter_disabled', 'repeat failures self-disable — no more network attempts');
  const en = a.enable('pub'); assert.equal(en.ok, true);
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.state-pub.json'), 'utf8'));
  assert.equal(st.disabled, false); assert.equal(st.fails, 0, 'enable resets counters honestly');
  bad.close(); s.close();
});

test('7D.4 rolling-hour rate limit from disk; timeout counts as failure', async () => {
  const { s, url } = await server((req, res) => setTimeout(() => res.end('{}'), 30));
  const dir = mkDir(); const a = mk(dir);
  a.create({ name: 'slow', kind: 'http-json', baseUrl: url, permission: 'read', headers: {}, mapping: {}, timeoutMs: 5000, rate: { maxPerHour: 2 } });
  await a.call('slow'); await a.call('slow');
  const third = await a.call('slow');
  assert.equal(third.ok, false); assert.equal(third.error.code, 'rate_limited', '3rd call in the hour is refused');

  a.create({ name: 'timebomb', kind: 'http-json', baseUrl: url + '/hang', permission: 'read', headers: {}, mapping: {}, timeoutMs: 1000, rate: { maxPerHour: 60 } });
  const srv2 = await server((req, res) => { /* never answers */ });
  fs.writeFileSync(path.join(dir, 'timebomb.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'timebomb.json'), 'utf8')), baseUrl: srv2.url }));
  const t = await a.call('timebomb');
  assert.equal(t.ok, false); assert.equal(t.error.code, 'network', 'abort after timeoutMs');
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.state-timebomb.json'), 'utf8'));
  assert.equal(st.fails, 1, 'timeout counted as a failure');
  s.close(); srv2.s.close();
});

test('7D.5 mapRows: scalar mapping + no mapping stays honest', () => {
  assert.deepEqual(mapRows({ ok: true }, { result: 'ok' }), [{ result: true }]);
  assert.deepEqual(mapRows({ a: 1 }, {}), [{ value: { a: 1 } }]);
  assert.deepEqual(mapRows({ list: [] }, { x: 'list.0.x' }), []);
});
