import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postGoalJson } from '../../src/v5/cli-transport.js';

test('local goal transport waits for delayed completion and never retries uncertain effects', async t => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (req.url === '/disconnect') { req.socket.destroy(); return; }
    setTimeout(() => res.end(JSON.stringify({ ok: true, goal: { status: 'COMPLETED' } })), 100);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await postGoalJson(url, '/goal', { goalText: 'fixture' })).goal.status, 'COMPLETED');
  await assert.rejects(postGoalJson(url, '/disconnect'));
  assert.equal(calls, 2, 'failed POST must not replay the task');
  await assert.rejects(postGoalJson('https://example.com', '/goal'), /local HTTP/);
});
