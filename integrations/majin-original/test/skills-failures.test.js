/* GRAND ARCHITECT Acceptans — Del 7C: learned skills get disk-backed failure
   tracking; 3 failures in a row disables the skill HONESTLY (never silently
   deleted); disabled skills are never selected (match/Prompt honor it);
   a success resets the streak; explicit enable resurrects. Multi-instance
   honesty: outcomes are counted on DISK state, so two agents share truth. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Skills } from '../src/core/memory.js';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'majin-skills-'));
const cfg = { map: new Map([['skills.maxFails', 3]]), get(k, d) { return this.map.has(k) ? this.map.get(k) : d ?? undefined; } };

test('7C.1 three failures in a row disable the skill; it drops out of match()', () => {
  const dir = mkDir();
  const s = new Skills({ ...cfg, get: (k, d) => (k === 'skills.dir' ? dir : cfg.get(k, d)), });
  s.save({ name: 'post-to-acme', when: 'when an acme ticket must be posted', steps: '1. open' });
  assert.equal(s.match('acme ticket', 5).length > 0, true, 'healthy skill is matchable');
  const r1 = s.recordOutcome('post-to-acme', { ok: false, why: 'endpoint 500' });
  assert.equal(r1.fails, 1); assert.equal(r1.disabled, false);
  const r2 = s.recordOutcome('post-to-acme', { ok: false, why: 'endpoint 500' });
  assert.equal(r2.disabled, false);
  const r3 = s.recordOutcome('post-to-acme', { ok: false, why: 'endpoint 500' });
  assert.equal(r3.disabled, true, 'third failure in a row disables');
  assert.equal(s.match('acme ticket', 5).length, 0, 'disabled skill never gets selected');
  const raw = fs.readFileSync(path.join(dir, 'post-to-acme.md'), 'utf8');
  assert.match(raw, /disabled: true/, 'disabled state lives on disk (honesty)');
  assert.match(raw, /fails: 3/, 'fail count persisted');
});

test('7C.2 a success resets the fail streak — intermittent failures never disable', () => {
  const dir = mkDir();
  const s = new Skills({ ...cfg, get: (k, d) => (k === 'skills.dir' ? dir : cfg.get(k, d)), });
  s.save({ name: 'flaky-net', when: 'when network is flaky', steps: '1. retry' });
  for (const ok of [false, false, true, false, false, true]) s.recordOutcome('flaky-net', { ok, why: ok ? '' : 'timeout' });
  const st = s.list().find((x) => x.name === 'flaky-net');
  assert.equal(st.disabled, false, 'two streaks of 2 never reach 3');
  assert.equal(Number(st.meta.fails), 0, 'a success resets the counter — latest outcome wins');
});

test('7C.3 explicit enable resurrects a disabled skill', () => {
  const dir = mkDir();
  const s = new Skills({ ...cfg, get: (k, d) => (k === 'skills.dir' ? dir : cfg.get(k, d)), });
  s.save({ name: 'world-changed', when: 'when api moves', steps: '1. migrate' });
  for (let i = 0; i < 3; i++) s.recordOutcome('world-changed', { ok: false, why: 'gone' });
  assert.equal(s.match('api moves', 5).length, 0);
  const e = s.enable('world-changed');
  assert.equal(e.ok, true);
  assert.equal(s.match('api moves', 5).length > 0, true, 're-enabled skill is selectable again');
  const st = s.list().find((x) => x.name === 'world-changed');
  assert.equal(st.disabled, false); assert.equal(Number(st.meta.fails), 0);
});

test('7C.4 prompt() never injects a disabled skill into the system prompt', () => {
  const dir = mkDir();
  const s = new Skills({ ...cfg, get: (k, d) => (k === 'skills.dir' ? dir : cfg.get(k, d)) });
  s.save({ name: 'p-good', when: 'when good', steps: '1. ok' });
  s.save({ name: 'p-bad', when: 'when bad', steps: '1. broken' });
  for (let i = 0; i < 3; i++) s.recordOutcome('p-bad', { ok: false, why: 'x' });
  const pr = s.prompt();
  assert.match(pr, /p-good/, 'healthy skill appears');
  assert.equal(pr.includes('p-bad'), false, 'disabled skill does NOT reach the model');
});

test('7C.5 two Skills instances on one dir share failure truth (multi-instance honesty)', () => {
  const dir = mkDir();
  const get = (k, d) => (k === 'skills.dir' ? dir : cfg.get(k, d));
  const a = new Skills({ get }); const b = new Skills({ get });
  a.save({ name: 'shared', when: 'when shared', steps: '1. x' });
  a.recordOutcome('shared', { ok: false, why: 'w1' });
  b.recordOutcome('shared', { ok: false, why: 'w2' }); /* instance B sees A's disk truth */
  a.recordOutcome('shared', { ok: false, why: 'w3' });
  assert.equal(b.list().find((x) => x.name === 'shared').disabled, true, 'combined 3 failures disable across instances');
});
