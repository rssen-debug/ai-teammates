import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnoseToolFailure } from '../src/core/tool-failure-diagnosis.js';

test('browser stale ref gets inspect-first recovery, not automatic re-click',()=>{
  assert.deepEqual(diagnoseToolFailure('browser.click',{code:'ref_stale'}),{
    kind:'page_changed',action:'refresh_grounding',recoverable:true,label:'Rechecking the live page'});
});
test('time-out of mutating tool never auto-retries',()=>{
  const result=diagnoseToolFailure('fs.write',{code:'tool_timeout'});
  assert.equal(result.recoverable,false);assert.equal(result.action,'inspect_before_retry');
});
test('repeated writes and permissions are not silently retried',()=>{
  assert.equal(diagnoseToolFailure('fs.write',{code:'repeat_loop'}).recoverable,false);
  assert.equal(diagnoseToolFailure('computer.use',{code:'permission_denied'}).action,'request_permission');
});
test('unrecognized error remains honest and bounded',()=>{
  assert.equal(diagnoseToolFailure('anything',{code:'weird'}).kind,'unknown');
  assert.ok(diagnoseToolFailure('browser.read',{code:'invalid_selector'}).recoverable);
});
test('server emits sanitized diagnosis; UI shows in-place state without panel',()=>{
  const loop=fs.readFileSync('src/core/loop.js','utf8');
  const ui=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(loop,/type:'tool_diagnosis'/);
  assert.match(ui,/ev\.type === 'tool_diagnosis'/);
  assert.match(ui,/bar\.dataset\.phase='diagnose'/);
  assert.match(html,/#composer #work-progress\[data-phase="diagnose"\]/);
  assert.doesNotMatch(html,/id="recovery-panel"/);
});
