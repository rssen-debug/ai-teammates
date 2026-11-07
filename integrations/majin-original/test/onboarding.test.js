/**
 * Onboarding + model picker: strukturella garantier.
 * (beteendet garanteras av providerflow/singlemodel + screenshot-pass)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS } from '../src/core/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const onboard = read('src/ui/onboard.js');
const runtimeSrc = read('src/core/runtime.js');
const index = read('src/ui/index.html');
const cfgSrc = read('src/core/config.js');
const runtimeText = runtimeSrc + '\n' + cfgSrc;

test('onboarding-modulen finns, mountas före app.js och exponerar en stabil API', () => {
  assert.ok(fs.existsSync(path.join(root, 'src/ui/onboard.js')), 'src/ui/onboard.js saknas');
  const iOb = index.indexOf('onboard.js');
  const iApp = index.indexOf('app.js');
  assert.ok(iOb > -1 && iOb < iApp, 'onboard.js ska laddas före app.js, fick ob=' + iOb + ' app=' + iApp);
  for (const sym of ['MAJIN_ONBOARD', 'maybe', 'togglePicker', 'reopen']) {
    assert.ok(onboard.includes(sym), 'onboard.js saknar ' + sym);
  }
});

test('headern har modellchip och wizard-mounten finns i index.html', () => {
  for (const id of ['c-model', 'onboard', 'ob-skip']) {
    assert.ok(index.includes(id) || onboard.includes(id), '#' + id + ' saknas (index eller onboard.js)');
  }
});

test('onboarding hyfstar inte: öppnar bara när needsSetup + ej undertryckt', () => {
  assert.ok(onboard.includes('needsSetup'), 'måste respektera state.needsSetup');
  assert.ok(onboard.includes('majin.onboard.skip') && onboard.includes('skipForNow'), 'måste ha session-undertryckning (Skip for now)');
  assert.ok(!/localStorage\.setItem\(.{0,8}majin\.onboard\.skip/.test(onboard), 'skip får inte vara permanent (sessionStorage!)');
});

test('alla felsteg visar förståeliga meddelanden från servern (error + hint)', () => {
  assert.ok(onboard.includes('function tellErr'), 'tellErr måste finnas');
  assert.ok(onboard.includes('.hint'), 'hint ska visas');
  assert.ok(onboard.includes('needsKey'), 'no_key-fallet måste kännas igen');
});

test('modellval är single-model: ALLA jobb-rutter + MOA explicit AV', () => {
  const m = onboard.match(/const ROUTE_JOBS = \[([\s\S]*?)\];/);
  assert.ok(m, 'ROUTE_JOBS-listan saknas i onboard.js');
  const jobsUi = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const j of JOBS) assert.ok(jobsUi.includes(j), 'onboard ROUTE_JOBS saknar core-jobbet ' + j);
  assert.ok(onboard.includes("policy: 'off'") || onboard.includes('policy:"off"'), 'MOA måste kopplas AV vid onboarding-val');
});

test('server-state exponerar det UI behöver: presets + needsSetup + providerReady-hjälp', () => {
  assert.ok(runtimeText.includes('presets'), 'state.presets saknas');
  assert.ok(runtimeText.includes('needsSetup'), 'state.needsSetup saknas');
  assert.ok(cfgSrc.includes('providerStatus'), 'providerStatus-hjälpen ska finnas i config');
});

test('onboarding alltid kan öppnas igen (reopen) — ingen en-gångs-fälla', () => {
  assert.ok(onboard.includes('reopen()'), 'reopen måste finnas');
  assert.ok(!onboard.includes('innerHTML'), 'innerHTML är bannad i onboard.js');
});
