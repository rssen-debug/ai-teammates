import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../src/core/provider/openai.js';
import { openaiOnce } from '../src/core/provider/openai.js';

test('empty messages fail locally before any upstream request', async () => {
  const previous = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('must not send'); };
  try {
    const route = { model: 'glm-5.3-flash', apiKey: 'fixture', endpoint: 'https://example.invalid/chat/completions', providerName: 'OpenCode Go' };
    await assert.rejects(() => openaiOnce({ route, messages: [], maxTokens: 12, temperature: 0.2 }), /No user or system message/);
    assert.equal(called, 0, 'no invalid HTTP request');
  } finally { globalThis.fetch = previous; }
});

test('normal user messages remain intact', () => {
  assert.deepEqual(buildMessages({}, [{ role: 'user', content: 'hello' }]), [{ role: 'user', content: 'hello' }]);
});
