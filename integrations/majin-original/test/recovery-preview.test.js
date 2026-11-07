import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPreview } from '../src/core/recovery-preview.js';
test('preview never executes and lists safe recovery decisions',()=>{
 const result=recoveryPreview({schema:1,id:'demo',state:{steps:[{id:'a',status:'pending',risk:'read'},{id:'b',status:'running',risk:'external'}]}});
 assert.deepEqual(result.steps.map(s=>s.action),['resume','inspect']);
});
test('preview rejects oversized or missing step collections',()=>{
 assert.equal(recoveryPreview({}).ready,false);
 assert.equal(recoveryPreview({schema:1,id:'demo',state:{steps:Array.from({length:1001},()=>({}))}}).ready,false);
});

test('preview refuses duplicate or invalid step identifiers',()=>{
 const base={status:'pending',risk:'read'};
 assert.deepEqual(recoveryPreview({schema:1,id:'demo',state:{steps:[{...base,id:'same'},{...base,id:'same'}]}}),{ready:false,reason:'invalid-or-duplicate-step-id',steps:[]});
 assert.equal(recoveryPreview({schema:1,id:'demo',state:{steps:[{...base,id:'../bad'}]}}).ready,false);
});

test('recovery preview summarizes decisions without invoking actions',()=>{
 const result=recoveryPreview({schema:1,id:'demo',state:{steps:[
  {id:'read_1',status:'pending',risk:'read'},
  {id:'write_1',status:'pending',risk:'write'},
  {id:'unknown_1',status:'running',risk:'external'}
 ]}});
 assert.equal(result.ready,true);
 assert.deepEqual(result.counts,{resume:1,skip:0,inspect:1,approval:1});
});

test('preview rejects envelopes without checkpoint identity',()=>{
 assert.equal(recoveryPreview({state:{steps:[]}}).reason,'invalid-checkpoint');
});

test('preview rejects traversal-style checkpoint identities',()=>{
 assert.equal(recoveryPreview({schema:1,id:'../other',state:{steps:[]}}).reason,'invalid-checkpoint');
});

test('preview produces only known recovery actions',()=>{
 const result=recoveryPreview({schema:1,id:'safe',state:{steps:[{id:'step_1',status:'pending',risk:'read'}]}});
 assert.equal(result.ready,true);
 assert.deepEqual(result.counts,{resume:1,skip:0,inspect:0,approval:0});
 assert.ok(result.steps.every(step=>['resume','skip','inspect','approval'].includes(step.action)));
});

test('preview rejects array and scalar checkpoint states',()=>{
 for(const state of [[], 'bad', 123, null]) {
  assert.equal(recoveryPreview({schema:1,id:'valid',state}).ready,false);
 }
});

test('preview safely handles missing and null state',()=>{
 assert.equal(recoveryPreview({schema:1,id:'demo'}).reason,'invalid-state');
 assert.equal(recoveryPreview({schema:1,id:'demo',state:null}).reason,'invalid-state');
});

test('empty checkpoint cannot be presented as resumable',()=>{
 const result=recoveryPreview({schema:1,id:'empty',state:{steps:[]}});
 assert.deepEqual(result,{ready:false,reason:'empty-steps',steps:[]});
});

test('recovery preview rejects malformed step records',()=>{
 for (const step of [null,42,'invalid',[],{id:'fine',risk:'read',status:'pending'},]) {
  const result=recoveryPreview({schema:1,id:'demo',state:{steps:[step]}});
  if (step && !Array.isArray(step) && typeof step==='object') assert.equal(result.ready,true);
  else assert.equal(result.reason,'invalid-step');
 }
});

test('recovery decision output remains in the supported action set',()=>{
 const preview=recoveryPreview({schema:1,id:'known',state:{steps:[{id:'read',risk:'read',status:'pending'},{id:'unsafe',risk:'write',status:'pending'}]}});
 assert.equal(preview.ready,true);
 assert.deepEqual(preview.steps.map(s=>s.action),['resume','approval']);
});

test('preview returns string reasons suitable for UI rendering',()=>{
 const r=recoveryPreview({schema:1,id:'reason',state:{steps:[{id:'read',risk:'read',status:'pending'}]}});
 assert.equal(r.ready,true);
 assert.equal(typeof r.steps[0].reason,'string');
});

test('inherited checkpoint step ids cannot impersonate valid steps',()=>{
 const inherited=Object.create({id:'trusted'});
 inherited.status='pending'; inherited.risk='read';
 assert.equal(recoveryPreview({schema:1,id:'safe',state:{steps:[inherited]}}).ready,false);
});

test('recovery preview requires explicit risk and status metadata',()=>{
 const noRisk={id:'a',status:'pending'};
 const noStatus={id:'b',risk:'read'};
 for (const step of [noRisk,noStatus]) {
  assert.equal(recoveryPreview({schema:1,id:'valid',state:{steps:[step]}}).reason,'invalid-step');
 }
});

test('recovery rejects unknown risk and status values',()=>{
 for(const step of [{id:'a',risk:'surprise',status:'pending'},{id:'b',risk:'read',status:'magic'}]) {
  assert.equal(recoveryPreview({schema:1,id:'valid',state:{steps:[step]}}).reason,'invalid-step-metadata');
 }
});

test('single-pass decision counts match every preview action',()=>{
 const r=recoveryPreview({schema:1,id:'counts',state:{steps:[{id:'a',risk:'read',status:'pending'},{id:'b',risk:'read',status:'pending'},{id:'c',risk:'external',status:'pending'}]}});
 assert.equal(r.ready,true);
 assert.equal(r.steps.length,3);
 assert.deepEqual(r.counts,{resume:2,skip:0,inspect:0,approval:1});
});

test('own valid step id passes while inherited id is rejected',()=>{
 const valid={id:'own',risk:'read',status:'pending'};
 const inherited=Object.assign(Object.create({id:'borrowed'}),{risk:'read',status:'pending'});
 assert.equal(recoveryPreview({schema:1,id:'session',state:{steps:[valid]}}).ready,true);
 assert.equal(recoveryPreview({schema:1,id:'session',state:{steps:[inherited]}}).ready,false);
});

test('recovery previews identify work requiring human attention',()=>{
 const state=step=>({schema:1,id:'example',state:{steps:[step]}});
 assert.equal(recoveryPreview(state({id:'read',risk:'read',status:'pending'})).needsAttention,false);
 assert.equal(recoveryPreview(state({id:'write',risk:'write',status:'pending'})).needsAttention,true);
 assert.equal(recoveryPreview(state({id:'unknown',risk:'read',status:'running'})).needsAttention,true);
});
