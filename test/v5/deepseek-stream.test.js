import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError } from '../../src/v5/providers.js';
import { openaiStream, buildMessages } from '../../src/core/provider/openai.js';

test('DeepSeek streamed parallel calls survive fragmented UTF-8 and an unterminated final SSE line', async () => {
  const previous = globalThis.fetch;
  const event = (delta, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ delta, ...extra }] }) + '\n\n';
  const wire = event({ reasoning_content: 'Inspect the observed form.' })
    + event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'browser_fill', arguments: '{"selector":"#name","value":"' } },
      { index: 1, id: 'b', function: { name: 'browser_inspect', arguments: '{' } }] })
    + event({ tool_calls: [{ index: 1, function: { arguments: '}' } },
      { index: 0, function: { arguments: 'Åsa Öberg"}' } }] }, { finish_reason: 'tool_calls' })
    + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } });
  const bytes = new TextEncoder().encode(wire);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const route = { model: 'deepseek-fixture', endpoint: 'http://127.0.0.1/fixture', apiKey: 'fixture' };
    const result = await openaiStream({ route, messages: [{ role: 'user', content: 'Execute the fixture tools' }], maxTokens: 1000, temperature: 0 });
    assert.equal(result.toolCalls.length, 2);
    assert.equal(JSON.parse(result.toolCalls[0].argsJson).value, 'Åsa Öberg');
    assert.deepEqual(JSON.parse(result.toolCalls[1].argsJson), {});
    assert.equal(result.usage.input, 123);
    assert.equal(result.usage.output, 45);
    assert.equal(result.stopReason, 'tool_calls');
    const messages = buildMessages(route, [{ role: 'assistant', content: null,
      reasoning_content: result.reasoning, tool_calls: [{ id: 'a', function: { name: 'browser_fill', arguments: result.toolCalls[0].argsJson } }] }]);
    assert.equal(messages[0].reasoning_content, 'Inspect the observed form.');
  } finally { globalThis.fetch = previous; }
});

test('a tool-call delta in the final SSE line is not silently dropped', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{
    delta: { tool_calls: [{ index: 0, id: 'last', function: { name: 'fs_read', arguments: '{"path":"cv.txt"}' } }] }, finish_reason: 'tool_calls',
  }] }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await openaiStream({ route: { model: 'deepseek-fixture', endpoint: 'http://127.0.0.1/fixture' }, messages: [{ role: 'user', content: 'Execute the fixture tools' }], maxTokens: 100 });
    assert.equal(result.toolCalls[0].name, 'fs_read');
    assert.equal(JSON.parse(result.toolCalls[0].argsJson).path, 'cv.txt');
  } finally { globalThis.fetch = previous; }
});

for (const [label, payload, code] of [
  ['malformed JSON', '{"choices":', 'invalid_stream_data'],
  ['upstream error', JSON.stringify({ error: { message: 'private-request-secret', code: 'upstream' } }), 'provider_stream_error'],
  ['null event', 'null', 'invalid_stream_data'],
]) {
  test(`stream rejects ${label} after partial tool arguments without exposing the payload`, async () => {
    const previous = globalThis.fetch;
    let requests = 0;
    const first = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: {
      name: 'browser_fill', arguments: '{"selector":"#name","value":"',
    } }] } }] };
    // Ignoring the broken middle event would turn this into a valid but wrong call.
    const last = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] };
    globalThis.fetch = async () => {
      requests++;
      return new Response(`data: ${JSON.stringify(first)}\n\ndata: ${payload}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    try {
      await assert.rejects(openaiStream({ route: { model: 'deepseek-fixture', endpoint: 'http://127.0.0.1/fixture' },
        messages: [{ role: 'user', content: 'Execute the fixture tools' }], maxTokens: 100 }), error => {
        assert.equal(error.code, code);
        assert.equal(error.retryable, false);
        const classified = classifyProviderError(error);
        assert.equal(classified.code, 'PROVIDER_STREAM_ERROR');
        assert.equal(classified.retryable, false);
        assert.match(classified.message, /Incomplete tool calls were discarded/);
        assert.doesNotMatch(error.message, /private-request-secret/);
        return true;
      });
      assert.equal(requests, 1);
    } finally { globalThis.fetch = previous; }
  });
}
