import test from 'node:test';
import assert from 'node:assert/strict';
import { compact } from '../src/core/context.js';

// V1 regression: summarizer outages must not erase the previous working memory.
test('compaction fallback preserves the prior brief and system goal', async () => {
  const original = { role: 'system', content: 'You are MAJIN.' };
  const goal = { role: 'system', content: 'ACTIVE GOAL: finish the current task' };
  const messages = [original, goal,
    { role: 'user', content: 'Important earlier decision '.repeat(150) },
    { role: 'assistant', content: 'Acknowledged '.repeat(100) },
    { role: 'user', content: 'Latest user request' }];
  const cfg = {
    get(key) { return key === 'agent.contextTokens' ? 200 : key === 'agent.keepRecent' ? 1 : null; },
    resolveModel() { throw new Error('Summarizer unavailable'); }
  };
  const result = await compact({ cfg, messages, brief: 'User prefers the original plan.' });
  assert.equal(result.compacted, true);
  assert.equal(result.brief, 'User prefers the original plan.');
  assert.equal(result.messages.filter(m => m.content === original.content).length, 1);
  assert.equal(result.messages.filter(m => m.content === goal.content).length, 1);
  assert.ok(result.messages.some(m => m.content.includes('WORKING MEMORY BRIEF') && m.content.includes('User prefers the original plan.')));
  assert.equal(result.messages.at(-1).content, 'Latest user request');
});
