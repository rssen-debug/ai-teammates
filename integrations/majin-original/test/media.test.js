import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-media-'));
const { mediaTools, endpointFor } = await import('../src/core/tools/media.js');
const imageTool = mediaTools.find((tool) => tool.name === 'media.generate_image');
const speechTool = mediaTools.find((tool) => tool.name === 'media.speak');
const route = { kind: 'openai', providerName: 'test-provider', model: 'gpt-image-1', ref: 'test-provider/gpt-image-1', baseUrl: 'https://api.example.test/v1', apiKey: 'test-secret' };
const ctx = { cfg: { resolveModel: () => route, get: (key) => key === 'workspace' ? workspace : null }, emit: () => {} };

test('media endpoint builder normalizes provider base URLs and rejects unsupported kinds', () => {
  assert.equal(endpointFor(route, '/images/generations'), 'https://api.example.test/v1/images/generations');
  assert.equal(endpointFor({ ...route, baseUrl: 'https://api.example.test' }, '/audio/speech'), 'https://api.example.test/v1/audio/speech');
  assert.throws(() => endpointFor({ ...route, kind: 'anthropic' }, '/images/generations'), /does not expose/);
});

test('media.generate_image saves provider base64 output locally without logging the prompt', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options, payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png-fixture').toString('base64'), content_type: 'image/png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await imageTool.run({ model: 'test-provider/gpt-image-1', prompt: 'a test landscape', path: 'images/test-image.png' }, ctx);
    assert.match(request.url, /\/v1\/images\/generations$/);
    assert.equal(request.options.headers.authorization, 'Bearer test-secret');
    assert.equal(request.payload.prompt, 'a test landscape');
    assert.equal(fs.readFileSync(path.join(workspace, 'images/test-image.png'), 'utf8'), 'png-fixture');
    assert.match(result.result, /test-image\.png/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media.speak writes generated audio and validates input length', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options, payload: JSON.parse(options.body) };
    return new Response(Buffer.from('audio-fixture'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  try {
    const result = await speechTool.run({ model: 'test-provider/tts-1', text: 'Hello from MAJIN', path: 'audio/hello.mp3' }, ctx);
    assert.match(request.url, /\/v1\/audio\/speech$/);
    assert.equal(request.payload.voice, 'alloy');
    assert.equal(fs.readFileSync(path.join(workspace, 'audio/hello.mp3'), 'utf8'), 'audio-fixture');
    assert.match(result.result, /hello\.mp3/);
    await assert.rejects(speechTool.run({ model: 'test-provider/tts-1', text: 'x'.repeat(4001) }, ctx), /1–4000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
