import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCodexHost } from '../../src/v5/codex-host.js';

test('host keeps owner actions same-origin and passes uploaded files to Codex', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-codex-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new EventEmitter(); client.workspace = root;
  client.start = async () => {};
  client.close = async () => {};
  client.status = async () => ({ connected: true, inferenceVerified: false });
  client.send = async text => ({ acceptedText: text });
  const host = createCodexHost({ workspace: root, stateDir: root, port: 0 }, { client });
  const { url } = await host.start(); t.after(() => host.stop());
  const post = (route, data, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(url + '/api/codex/status')).status, 200);
  assert.equal((await post('/api/codex/message', { text: 'untrusted cross-origin' }, { origin: 'https://example.com' })).status, 403);
  const wrongType = await fetch(url + '/api/codex/message', { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 400);
  const upload = await (await post('/api/codex/attachment', { name: '../../test.txt', base64: Buffer.from('fixture').toString('base64') })).json();
  assert.equal(fs.readFileSync(upload.path, 'utf8'), 'fixture');
  const sent = await (await post('/api/codex/message', { text: 'read attachment', attachments: [upload.path] })).json();
  assert.match(sent.acceptedText, /read attachment/); assert(sent.acceptedText.includes(upload.path));
  assert.equal((await post('/api/codex/message', { text: 'read outside', attachments: ['../outside'] })).status, 400);
});
