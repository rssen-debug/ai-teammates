import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserActionReceipt } from '../src/core/browser-action-receipt.js';

test('browser receipt distinguishes rejection, attempted click and verified side effect',()=>{
  const rejected=browserActionReceipt({reason:'occluded'});
  assert.deepEqual(rejected,{status:'not_started',evidence:'none',retryAdvice:'correct_or_reobserve',reason:'occluded'});
  const dispatched=browserActionReceipt({dispatched:true});
  assert.equal(dispatched.status,'browser_completed');
  assert.equal(dispatched.evidence,'action_only');
  assert.equal(dispatched.retryAdvice,'do_not_automatically_retry');
  const verified=browserActionReceipt({dispatched:true,verified:true});
  assert.equal(verified.evidence,'postcondition_verified');
  const unknown=browserActionReceipt({dispatched:true,uncertain:true});
  assert.equal(unknown.status,'unknown');
  assert.equal(unknown.retryAdvice,'do_not_automatically_retry');
});
test('click results carry receipts and inline composer has distinct evidence pending visual',()=>{
  const web=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(web,/receipt:browserActionReceipt\(\{dispatched:true,verified:proof\?\.ok===true\}\)/);
  assert.match(web,/receipt:browserActionReceipt\(\{dispatched:true,reason:'assertion_failed'\}\)/);
  assert.match(app,/receipt\.evidence==='action_only'/);
  assert.match(html,/data-phase="action"/);
  assert.match(html,/majin-action-pulse/);
});
