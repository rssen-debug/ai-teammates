/**
 * The journal must never forget a turn that is still running.
 *
 * Two eviction paths existed and neither consulted `done`:
 *   - age: a turn older than the TTL was dropped, even mid-flight
 *   - size: creating a newer turn evicted the oldest by insertion order
 *
 * The consequence is the one the journal exists to prevent: a phone that
 * reconnects after a long turn gets 404 "turn no longer buffered" while the host
 * is still working, so the work is invisible and the client reports failure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnJournal } from '../../src/v4/turns.js';

test('journal: a turn older than the TTL is kept while it is still running', () => {
  let now = 1_000_000;
  const journal = new TurnJournal({ ttlMs: 1000, maxTurns: 10, now: () => now });
  const running = journal.create({ conversationId: 'c1' });
  journal.append(running, 'delta', { text: 'arbetar' });

  now += 5000; // five times the TTL
  journal.prune();

  assert.equal(journal.get(running.id), running, 'the same turn object, not a copy');
  assert.equal(running.done, false);
});

test('journal: a finished turn older than the TTL is dropped', () => {
  let now = 1_000_000;
  const journal = new TurnJournal({ ttlMs: 1000, maxTurns: 10, now: () => now });
  const done = journal.create({ conversationId: 'c' });
  journal.append(done, 'delta', { text: 'x' });
  journal.finish(done, 'completed');

  now += 5000;
  journal.prune();
  assert.equal(journal.get(done.id), null, 'a finished turn may expire');
});

test('journal: creating new turns does not evict a running one', () => {
  const journal = new TurnJournal({ maxTurns: 3, ttlMs: 60_000 });
  const running = journal.create({ conversationId: 'long' });
  journal.append(running, 'delta', { text: 'arbetar' });

  for (let i = 0; i < 10; i += 1) {
    const t = journal.create({ conversationId: `c${i}` });
    journal.finish(t, 'completed');
  }

  assert.ok(journal.get(running.id), 'the live turn survived ten newer turns');
});

test('journal: finished turns are still evicted, so the buffer stays bounded', () => {
  const journal = new TurnJournal({ maxTurns: 3, ttlMs: 60_000 });
  for (let i = 0; i < 10; i += 1) {
    const t = journal.create({ conversationId: `c${i}` });
    journal.finish(t, 'completed');
  }
  assert.ok(journal.turns.size <= 4, `bounded, got ${journal.turns.size}`);
});

test('journal: a burst of live turns is bounded too, but generously', () => {
  const journal = new TurnJournal({ maxTurns: 2, ttlMs: 60_000 });
  const live = [];
  for (let i = 0; i < 20; i += 1) live.push(journal.create({ conversationId: `c${i}` }));
  // Live work is protected up to a hard ceiling; beyond that something has to go.
  assert.ok(journal.turns.size <= 20, `got ${journal.turns.size}`);
  assert.ok(journal.turns.size > 2, 'the cap must not silently drop live turns');
});

test('journal: a reattaching client still finds a turn that outlived the TTL', () => {
  let now = 1_000_000;
  const journal = new TurnJournal({ ttlMs: 1000, maxTurns: 50, now: () => now });
  const turn = journal.create({ conversationId: 'slow' });
  journal.append(turn, 'open', { turnId: turn.id });
  journal.append(turn, 'delta', { text: 'ett' });

  // the model is slow and the turn takes 15 minutes, then the phone reconnects
  now += 15 * 60 * 1000;
  journal.prune();
  journal.create({ conversationId: 'other' });

  const found = journal.get(turn.id);
  assert.ok(found, 'the running turn is still buffered');
  const seen = [];
  journal.subscribe(found, 0, (e) => seen.push(e.type));
  assert.deepEqual(seen, ['open', 'delta'], 'and it can be replayed from the start');
});
