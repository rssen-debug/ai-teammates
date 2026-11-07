/**
 * Second hardening pass. Same question as leaks.test.js: what grows, what is
 * retained, and what happens at the edges of a long-running host?
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GoalStore } from '../../src/v4/store.js';
import { Goal } from '../../src/v2/runtime/goal.js';
import { tempHome } from './helpers.mjs';

test('leak: the goal store does not retain every goal object forever', () => {
  const home = tempHome();
  const store = new GoalStore({ dir: path.join(home, 'goals') });
  for (let i = 0; i < 300; i += 1) {
    const goal = new Goal({ objective: `må ${i}`, acceptance: [] });
    store.save(goal);
  }
  assert.ok(store.live.size <= 200, `live map kept ${store.live.size} goals`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('leak: a goal evicted from memory still loads from disk unchanged', () => {
  const home = tempHome();
  const store = new GoalStore({ dir: path.join(home, 'goals') });
  const first = new Goal({ objective: 'behåll mig', acceptance: [{ id: 'a1', description: 'x' }] });
  first.transition('PLANNING', 't');
  store.save(first);
  const id = first.id;
  for (let i = 0; i < 400; i += 1) store.save(new Goal({ objective: `f${i}`, acceptance: [] }));

  assert.equal(store.live.has(id), false, 'it was evicted from memory');
  const reloaded = store.get(id);
  assert.ok(reloaded, 'but it still loads');
  assert.equal(reloaded.objective, 'behåll mig');
  assert.equal(reloaded.state, 'PLANNING');
  fs.rmSync(home, { recursive: true, force: true });
});

test('leak: a goal that is still open survives eviction (a live turn keeps its instance)', () => {
  const home = tempHome();
  const store = new GoalStore({ dir: path.join(home, 'goals'), cacheMax: 2 });
  const running = new Goal({ objective: 'pågår', acceptance: [] });
  running.transition('PLANNING', 't');
  running.transition('READY', 't');
  running.transition('RUNNING', 't');
  store.save(running);
  // filler pushes the running goal out of the cache
  for (let i = 0; i < 5; i += 1) store.save(new Goal({ objective: `f${i}`, acceptance: [] }));
  // An in-flight goal is never evicted, so the cache holds it plus fillers.
  assert.ok(store.live.has(running.id), 'a running goal stays in memory');
  assert.ok(store.live.size <= 3, `cache bounded, got ${store.live.size}`);

  // The in-memory instance the agent still holds is untouched; a fresh load
  // sees the last persisted state, which is what crash recovery relies on.
  assert.equal(running.state, 'RUNNING');
  const reloaded = store.get(running.id);
  assert.ok(reloaded);
  assert.equal(reloaded.id, running.id);
  fs.rmSync(home, { recursive: true, force: true });
});
