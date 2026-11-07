import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcedureTools, usedProcedureLanes } from '../../src/v5/procedure-tools.js';

function fixture() {
  const proc = { procedureId: 'proc-file', canonicalSkillId: 'files.write', summary: 'Write and verify a file',
    keywords: ['document'], requiredLanes: ['files'], verifiedUses: 1, provenance: [{ receiptId: 'independent-file-proof' }],
    steps: [{ tool: 'fs.write', argKeys: ['path','content'], parameters: { path: '{{file_path}}', content: '{{content}}' } }] };
  const skill = { maturity_status: 'TRAINING', freshness: 'FRESH' };
  const options = { learning: { state: { procedures: [proc] } }, skillTree: { get: () => skill }, grantedLanes: ['files'], availableTools: ['fs_write'] };
  return { proc, skill, options };
}

test('procedural discovery is scoped metadata; activation returns parameterized untrusted guidance with current tool names', () => {
  const { options } = fixture(); const tools = createProcedureTools(options);
  const found = tools.get('procedures_search').run({ query: 'document' });
  assert.equal(found.procedures.length, 1);
  assert.equal(found.trusted, false);
  assert.equal(found.procedures[0].steps, undefined);
  assert.equal(found.procedures[0].provenance, undefined);
  const read = tools.get('procedures_read').run({ name: 'proc-file' });
  assert.equal(read.trusted, false); assert.equal(read.executable, false);
  assert.equal(read.steps[0].tool, 'fs_write');
  assert.equal(read.steps[0].parameters.path, '{{file_path}}');
  read.steps[0].parameters.path = 'changed';
  assert.equal(tools.get('procedures_read').run({ name: 'proc-file' }).steps[0].parameters.path, '{{file_path}}');
});

test('revoked permissions, unavailable tools, failed/stale skills and unverified procedures are withheld', () => {
  for (const alter of [
    x => { x.options.grantedLanes = []; }, x => { x.options.availableTools = []; },
    x => { x.skill.maturity_status = 'FAILED'; }, x => { x.skill.freshness = 'STALE'; },
    x => { x.proc.verifiedUses = 0; }, x => { x.proc.provenance = []; },
  ]) {
    const x = fixture(); alter(x); const tools = createProcedureTools(x.options);
    assert.deepEqual(tools.get('procedures_search').run({}).procedures, []);
    assert.throws(() => tools.get('procedures_read').run({ name: 'proc-file' }), /unavailable procedure/);
  }
});

test('procedures cannot accept raw execution parameters or grant permissions', () => {
  const tools = createProcedureTools(fixture().options);
  assert.throws(() => tools.get('procedures_read').run({ name: 'proc-file', execute: true }));
  assert.throws(() => tools.get('procedures_search').run({ query: '', grant: ['shell'] }));
  assert.deepEqual(usedProcedureLanes([{ tool: 'fs_write', ok: true }, { tool: 'shell_run', ok: true }, { tool: 'browser_click', ok: false }], ['files','shell','browser']), ['files','shell']);
});
