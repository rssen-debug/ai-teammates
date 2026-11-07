import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveRows, runLiveChaos, classifyHttp, LIVE_CHAOS_VERSION } from '../src/core/live-provider-chaos.js';

/** Offline engine-kontrakt: radfabrikens domar är bevisbara mot simulerade OpenAI-form-svar.
 *  Live-bevisekten ligger i de committade artifactsen; dessa tester bevisar maskinen. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('W13-live engine: baseline-raden ger recovered först mot RIKTIG-token-svar (usage + chars)', async () => {
  const call = async () => ({ ok: true, ms: 40, httpStatus: 200, textChars: 13, reasoningChars: 100, finishReason: 'stop', usage: { prompt: 28, completion: 173, total: 201 }, model: 'fake-model' });
  const rows = buildLiveRows({ call });
  const baseline = rows.find((r) => r.id === 'baseline.real-answer-arrives');
  const out = await baseline.method();
  assert.equal(out.verdict, 'recovered');
  assert.equal(out.facts.usage.total, 201);
  assert.equal(rows.length, 7, 'suiteskailen har 7 chaos-rader');
});

test('W13-live engine: deadline-abort klassas controlled, hängning = STUCK (bound-breach)', { timeout: 15000 }, async () => {
  const call = async (opts) => {
    if (opts.__forceBadKey) return { ok: false, httpStatus: 401, ms: 10, error: { code: 'auth_refused' } };
    if (opts.model === 'bogus-nonexistent-model-9000') return { ok: false, httpStatus: 404, ms: 10, error: { code: 'not_found' } };
    if (!Array.isArray(opts.messages) || opts.messages.length === 0) return { ok: false, httpStatus: 400, ms: 8, error: { code: 'request_refused' } };
    const timeoutMs = opts.timeoutMs ?? 1000;
    if (timeoutMs <= 400) { await sleep(timeoutMs); return { ok: false, aborted: true, ms: timeoutMs, error: { code: 'deadline_abort' } }; }
    return { ok: true, ms: 50, textChars: 5, usage: { prompt: 1, completion: 2, total: 3 } };
  };
  const report = await runLiveChaos({ call, model: 'x' });
  assert.equal(report.totals.stuck, 0, 'simulerad deadline/abort hanteras');
  assert.equal(report.unhandledRejections, 0);
  assert.equal(report.version, LIVE_CHAOS_VERSION);
});

test('W13-live engine: STUCK-classifiering av hängande provider + bound-flaggning är öppen', { timeout: 20000 }, async () => {
  const call = async () => { await sleep(2500); return { ok: true, ms: 2500, textChars: 3, usage: { prompt: 1, completion: 1, total: 2 } }; };
  const report = await runLiveChaos({ call, model: 'x', boundsMs: { baseline: 100, deadline: 60, abort: 60, authKey: 80, bogusModel: 80, burst: 500, empty: 80 } });
  assert.ok(report.totals.stuck >= 1, 'latent hängning MÅSTE bli STUCK — aldrig dold');
  assert.equal(report.invariants.I1_no_stuck_in_live_suite, false, 'invarianten rapporterar ärligt falskt');
});

test('W13-live engine: bad-key/bogus-model/empty-messages/burst — radfamiljens domergeringar', async () => {
  let callN = 0;
  const call = async (opts = {}) => {
    callN += 1;
    if (opts.__forceBadKey) return { ok: false, httpStatus: 401, ms: 12, error: { code: 'auth_refused', message: 'invalid key' } };
    if (opts.model === 'bogus-nonexistent-model-9000') return { ok: false, httpStatus: 404, ms: 9, error: { code: 'not_found', message: 'model not found' } };
    if (!Array.isArray(opts.messages) || opts.messages.length === 0) return { ok: false, httpStatus: 400, ms: 8, error: { code: 'request_refused', message: 'messages empty' } };
    if ((opts.timeoutMs ?? 1000) <= 100) return { ok: false, aborted: true, ms: opts.timeoutMs, error: { code: 'deadline_abort' } };
    return { ok: true, ms: 20, textChars: 6, usage: { prompt: 2, completion: 2, total: 4 } };
  };
  const report = await runLiveChaos({ call, model: 'x', boundsMs: { baseline: 2000, deadline: 2000, abort: 2000, authKey: 2000, bogusModel: 2000, empty: 2000, burst: 8000 } });
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
  assert.equal(byId['baseline.real-answer-arrives'].verdict, 'recovered');
  assert.equal(byId['auth.bad-key-plain-refusal'].verdict, 'controlled');
  assert.equal(byId['model.bogus-name-refused-plainly'].verdict, 'controlled');
  assert.equal(byId['empty-messages.client-or-server-refuses-plainly'].verdict, 'controlled');
  assert.equal(byId['concurrency.burst-of-5-settles-bounded'].verdict, 'recovered');
  assert.equal(byId['concurrency.burst-of-5-settles-bounded'].facts.leakedRejections, 0);
  assert.equal(byId['concurrency.burst-of-5-settles-bounded'].facts.oks, 5);
  assert.ok(byId['auth.bad-key-plain-refusal'].facts.ms < 2000);
  assert.equal(callN, 11, 'raderna nådde adaptern exakt väntade gånger (1+1+1+1+1+5+1, inget short-circuit)');
});

test('W13-live http-klassificeraren är tydlig mot varje statusspann', () => {
  assert.deepEqual(classifyHttp(200).code, 'http_200');
  assert.equal(classifyHttp(401).code, 'auth_refused');
  assert.equal(classifyHttp(403).code, 'auth_refused');
  assert.equal(classifyHttp(429).code, 'rate_limited');
  assert.equal(classifyHttp(429).retryable, true);
  assert.equal(classifyHttp(500).code, 'server_error');
  assert.equal(classifyHttp(502).retryable, true);
  assert.equal(classifyHttp(404).code, 'not_found');
});

/* ---------- evidential audit av de committade LIVE-artifactsen ---------- */

const LIVE = fileURLToPath(new URL('../docs/evidence/live-provider-chaos-2026-10-21.json', import.meta.url));

test('W13-live evidential audit: committad live-evidens existerar, alla rader avgjorda, noll stuck, noll nyckelläckage', () => {
  assert.ok(fs.existsSync(LIVE), 'live-artifact saknas — lane claims utan receipts');
  const raw = fs.readFileSync(LIVE, 'utf8');
  const d = JSON.parse(raw);
  assert.equal(d.totals.stuck, 0, 'inga stuck i committad evidens');
  assert.equal(d.unhandledRejections, 0);
  assert.equal(d.results.length, 7);
  const baseline = d.results.find((r) => r.id === 'baseline.real-answer-arrives');
  assert.equal(baseline.verdict, 'recovered');
  assert.ok(baseline.facts.usage.total > 0, 'riktiga token-siffror sitter i evidensen');
  assert.match(String(baseline.facts.model), /glm-5\.3-flash/, 'modellen som svarade identifierad');
  const burst = d.results.find((r) => r.id === 'concurrency.burst-of-5-settles-bounded');
  assert.equal(burst.facts.oks + burst.facts.refusedPlain, 5);
  // nyckelhygien: SDENAKTIGA nyckelformen ska inte läcka; den kasusha bad-nyckeln är däremot etiketterad och okej ute
  assert.ok(!raw.includes('oc_sk_5e0bbe5'), 'riktig nyckel läcker aldrig in i artifacts');
  assert.ok(raw.includes('oc_sk_DELIBERATELY_INVALID_KEY_for_chaos_row') === false, 'även chaos-nyckeln får inte fastna (maskad)');
  assert.equal(d.date, '2026-10-21');
});
