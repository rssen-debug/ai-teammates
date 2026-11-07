/** Deterministic fleet commands: parser unit tests (no LLM anywhere). */
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseTaskCommand, resolveRef, statusText } = await import('../src/core/intent-tasks.js');

const T = [
  { id: 't-aaa', input: 'sök 100 IT-jobb', status: 'running', created: 1, session: 'task:t-aaa' },
  { id: 't-bbb', input: 'bygg en snygg hemsida', status: 'running', created: 2, session: 'task:t-bbb' },
  { id: 't-ccc', input: 'analysera min dator', status: 'paused', created: 3, session: 'task:t-ccc' },
];

test('ordinals are the creation order the user means, Swedish and English', () => {
  assert.equal(resolveRef('agent 1', T).task.id, 't-aaa');
  assert.equal(resolveRef('agent 2', T).task.id, 't-bbb');
  assert.equal(resolveRef('andra', T).task.id, 't-bbb');
  assert.equal(resolveRef('agent tredje', T).task.id, 't-ccc');
  assert.equal(resolveRef('task t-bbb', T).task.id, 't-bbb', 'a raw id resolves too');
});

test('name-based resolution is forgiving but never invents', () => {
  assert.equal(resolveRef('jobbsökningen', T).task.id, 't-aaa');
  assert.equal(resolveRef('hemsidan', T).task.id, 't-bbb');
  const none = resolveRef('agent 9', T);
  assert.equal(none.ok, false);
  assert.match(none.error, /no active agent 9/, 'missing ordinals say the truth');
  const quiet = resolveRef('agent 1', []);
  assert.equal(quiet.ok, false);
  assert.match(quiet.error, /no agents are running/, 'an empty fleet says so');
});

test('commands stop/pause/resume/status parse to the right task', () => {
  assert.deepEqual(matchIds(parseTaskCommand('stoppa agent 2', T)), ['stop', 't-bbb']);
  assert.deepEqual(matchIds(parseTaskCommand('stop t-ccc', T)), ['stop', 't-ccc']);
  assert.deepEqual(matchIds(parseTaskCommand('pausa agent 1', T)), ['pause', 't-aaa']);
  assert.deepEqual(matchIds(parseTaskCommand('resume agent 3', T)), ['resume', 't-ccc']);
  assert.deepEqual(parseTaskCommand('visa alla agenter', T).action, 'status');
  assert.deepEqual(parseTaskCommand('vad gör agenterna?', T).action, 'status');
  assert.equal(parseTaskCommand('bygg en app åt mig', T), null, 'an ordinary message is NOT a command');
  // assist: "agent 2, hjälp agent 1"
  const a = parseTaskCommand('agent 2 hjälp agent 1', T);
  assert.equal(a.action, 'assist');
  assert.equal(a.helper.task.id, 't-bbb');
  assert.equal(a.target.task.id, 't-aaa');
  // "stötta" and "förstärk" variants
  assert.equal(parseTaskCommand('agent 1 ska stötta agent 2', T).action, 'assist');
  // unknown in assist must throw out an error object, never a guess
  assert.equal(parseTaskCommand('hjälp agent 9', T).target.ok, false);
});

function matchIds(cmd) {
  return [cmd.action, cmd.target.task.id];
}

test('statusText is one line per live agent, honest when quiet', () => {
  const txt = statusText(T);
  assert.match(txt, /agent 1 \(t-aaa\).*running.*sök 100/s);
  assert.match(txt, /agent 3 \(t-ccc\).*paused/);
  assert.match(statusText([]), /No agents are running/);
});
