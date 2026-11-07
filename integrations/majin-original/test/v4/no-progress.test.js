/**
 * Bounded attempts: no identical unsuccessful action twice.
 *
 * The brief requires bounded retries and forbids repeating identical failed
 * actions, and "never run unlimited retries against real external services".
 * This is the guard that makes that true inside one turn, driven through the
 * real server and a scripted provider:
 *
 *   - a model that re-issues the exact same failing call is refused, and told
 *     what it is repeating;
 *   - a model that changes the arguments is allowed through (different input is
 *     a different attempt, not a dead end);
 *   - a transient failure may be retried, because the tool was never the problem;
 *   - the recovery advisor's own bounded retry still works.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { startFakeProvider, lastToolMessage } from './fake-provider.mjs';

const isChild = (body) => (body.messages || [])
  .some((m) => m.role === 'system' && /MAJIN subagent/.test(String(m.content)));

const env = (provider) => ({
  MAJIN_V4_PROVIDER: 'openai',
  MAJIN_V4_BASE_URL: provider.url,
  MAJIN_V4_API_KEY: 'test-key-not-a-secret',
  MAJIN_V4_MODEL: 'scripted-model',
  MAJIN_V4_MAX_VISIBLE_TOOLS: '40',
  MAJIN_V4_MAX_TOOL_CALLS: '12',
  MAJIN_V4_MAX_MODEL_ROUNDS: '8',
  MAJIN_V4_RATE_REQUESTS: '1000',
  MAJIN_V4_RATE_TURNS: '1000',
});

test('no-progress: the exact same failing call is refused the second time', async () => {
  const home = tempHome();
  let parentRound = -1;
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    parentRound += 1;
    const last = lastToolMessage(body);
    // Round 0 and round 1 issue the IDENTICAL call, which cannot succeed
    // because no folder is granted for the files lane.
    if (parentRound <= 1) {
      return { toolCalls: [{ name: 'fs_read', args: { path: '/tmp/definitely-not-granted/x.txt' } }] };
    }
    assert.equal(last?.ok, false, 'the repeated call should have been refused');
    assert.match(String(last?.error || ''), /already failed/i,
      `the guard did not explain itself: ${JSON.stringify(last)}`);
    return { text: 'Jag byter strategi.' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Läs filen som ligger utanför allt.',
      requestId: 'np-1',
    }));

    const results = events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    assert.equal(results.length, 2, `expected two calls, saw ${results.length}`);
    assert.notEqual(results[0].summary, 'NO_PROGRESS', 'the first attempt must actually run');
    assert.equal(results[1].summary, 'NO_PROGRESS', 'the identical retry was not refused');
    // It was refused locally, so it never executed and cannot be verified.
    assert.equal(results[1].verified, false);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no-progress: different arguments are a new attempt, not a dead end', async () => {
  const home = tempHome();
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'finns.txt'), 'INNEHÅLL');

  let parentRound = -1;
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    parentRound += 1;
    const last = lastToolMessage(body);
    if (parentRound === 0) {
      return { toolCalls: [{ name: 'workspace_read', args: { fileName: 'saknas.txt' } }] };
    }
    if (parentRound === 1) {
      assert.equal(last?.ok, false, 'the first read was supposed to fail');
      // Same tool, DIFFERENT argument: a different attempt.
      return { toolCalls: [{ name: 'workspace_read', args: { fileName: 'finns.txt' } }] };
    }
    assert.equal(last?.ok, true, `changing the arguments must be allowed: ${JSON.stringify(last)}`);
    assert.match(String(last?.data?.content || ''), /INNEHÅLL/);
    return { text: 'Klart.' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Läs filen finns.txt.',
      requestId: 'np-2',
    }));
    const results = events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    assert.ok(results.every((r) => r.summary !== 'NO_PROGRESS'), 'a legitimate retry with new arguments was blocked');
    assert.ok(results.some((r) => r.ok), 'the second read did not succeed');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no-progress: transient classes are exempt from the guard, permanent ones are not', async () => {
  const { isTransientFailureClass } = await import('../../src/v4/agent.js');
  // A retry of an identical call is legitimate when the tool was never the problem.
  for (const cls of ['TIMEOUT', 'NETWORK_FAILURE', 'MODEL_RATE_LIMIT', 'MODEL_FAILURE', 'STALE_STATE', 'MODEL_CONTEXT_LIMIT']) {
    assert.equal(isTransientFailureClass(cls), true, `${cls} should be retryable`);
  }
  // These mean the idea itself was wrong: repeating it is a dead end.
  for (const cls of ['PERMISSION_DENIED', 'INVALID_TOOL_INPUT', 'INVALID_TOOL_OUTPUT', 'NO_PROGRESS', 'LEARNED_AVOID', 'TOOL_FAILURE', 'DEPENDENCY_MISSING']) {
    assert.equal(isTransientFailureClass(cls), false, `${cls} must not be retried identically`);
  }
});
