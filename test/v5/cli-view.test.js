import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHeader, compactEvent, compactResult } from '../../src/v5/cli-view.js';

test('compact view keeps blockers and verification truthful without duplicating streamed prose', () => {
  const goal = { status: 'PARTIAL', model_reply: 'Förberedd, inte skickad.', summaryText: 'Förberedd, inte skickad.',
    tool_results: [{ ok: true }, { ok: false }], verification_evidence: [], cost: { modelCalls: 2, inputTokens: 1200 } };
  const text = compactResult(goal);
  assert.equal(text.split('Förberedd, inte skickad.').length - 1, 1);
  assert.match(text, /not final-verified/);
  assert.match(text, /0 verification receipts/);
  assert.match(text, /1 errors during this run/);
  assert.equal(compactEvent({ type: 'model_output_delta', text: 'duplicate' }), null);
  assert.match(compactEvent({ type: 'tool_call_finished', ok: false, errorCode: 'PATH_DENIED' }), /PATH_DENIED/);
  assert.match(compactResult({ status: 'WAITING_USER', browser_handoff: { action: 'Logga in i webbläsaren.' } }), /Logga in i webbläsaren/);
});

test('compact terminal rendering strips injected controls and only colors the trusted heading when enabled', () => {
  const header = compactHeader({ version: '5', model: 'deepseek\x1b[2J', color: false });
  assert.ok(!header.includes('\x1b'));
  assert.match(header, /deepseek/);
  assert.ok(!compactResult({ status: 'BLOCKED', blocker: '\x1b[2Jproblem\x07' }).includes('\x1b'));
  assert.match(compactHeader({ version: '5', color: true }), /\x1b\[1;36mMAJIN/);
});
