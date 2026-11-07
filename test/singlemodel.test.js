/**
 * Single-model-läget: en vald modell ska täcka ALLA jobb, MOA ska vara av.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-single-'));
const { Config, DEFAULTS, clone, JOBS, hasKey } = await import('../src/core/config.js');

const CONFIG_KEYS = { built: false };
function fresh() {
  const cfg = new Config(clone(DEFAULTS), path.join(tmp, 'conf-' + Math.random().toString(36).slice(2) + '.json'));
  const rid = 'localstub';
  cfg.patch({
    providers: { [rid]: { label: 'Stub', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', models: ['stub-flash', 'stub-pro'] } },
    models: { provider: rid, routes: Object.fromEntries(JOBS.map((j) => [j, rid + '/stub-flash'])) },
    moa: { policy: 'off' },
  });
  return { cfg, rid };
}

test('alla jobb löser till samma ref när single-model är satt', () => {
  const { cfg, rid } = fresh();
  for (const job of JOBS) {
    const r = cfg.resolveModel('', job);
    assert.equal(r.ref, rid + '/stub-flash', `job ${job} ska lösas till single-ref, fick ${r.ref}`);
    assert.equal(r.providerName, rid);
  }
});

test('MOA är av i single-model-läget och explicit override ruttar fortfarande rätt', () => {
  const { cfg, rid } = fresh();
  assert.equal(cfg.get('moa.policy'), 'off');
  const r = cfg.resolveModel(rid + '/stub-pro', 'code');
  assert.equal(r.model, 'stub-pro', 'explicit modellval ska slå igenom oavsett rutt');
});

test('provider räknas som redo när den har nyckel — onboarding-flaggan stängs', () => {
  const { cfg } = fresh();
  const p = cfg.get('providers.localstub');
  assert.ok(hasKey({ ...p, kind: 'openai' }), 'stub med key ska räknas som redo-att-svara');
});
