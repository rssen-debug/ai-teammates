import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-turn-deadline-'));
process.env.MAJIN_HOME=home;
const { withAbortDeadline }=await import('../src/core/watchdog.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { loop }=await import('../src/core/loop.js');

test('hard turn deadline unblocks a model promise that ignores cancellation',async()=>{
  const start=Date.now();
  await assert.rejects(
    ()=>withAbortDeadline(()=>new Promise(()=>{}),{ms:80,label:'fake stalled model'}),
    e=>e.code==='turn_timeout' && e.timeoutMs===80
  );
  assert.ok(Date.now()-start<1200,'did not finish before bounded deadline');
});

test('hard turn deadline aborts real inference signal',async()=>{
  let noticed=false;
  await assert.rejects(
    ()=>withAbortDeadline((signal)=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>{
        noticed=true;
        reject(signal.reason);
      },{once:true});
    }),{ms:70,label:'slow provider'}),
    e=>e.code==='turn_timeout'
  );
  assert.equal(noticed,true,'model transport never got cancellation signal');
});

test('user stop cancels step immediately and is NOT called a timeout',async()=>{
  const controller=new AbortController();
  const t=setTimeout(()=>controller.abort(new Error('cancelled')),35);
  try{
    await assert.rejects(()=>withAbortDeadline(()=>new Promise(()=>{}),
      {ms:2000,parentSignal:controller.signal,label:'user task'}),e=>e.code==='aborted');
  }finally{clearTimeout(t);}
});

test('quick inference response does not trigger a delayed abort',async()=>{
  let signaled=false;
  const result=await withAbortDeadline(async(signal)=>{
    signal.addEventListener('abort',()=>{signaled=true;});
    return {text:'completed'};
  },{ms:500,label:'quick model'});
  assert.equal(result.text,'completed');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(signaled,false,'timeout was not cleared after success');
});

test('actual MAJIN loop reports INCOMPLETE instead of freezing on a stalled step',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const result=rt.cfg.patch({
    workspace:path.join(home,'workspace'),
    models:{provider:'demo',routes},
    moa:{policy:'off'},
    agent:{maxTurnSec:0.3,maxSteps:5}
  });
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  const events=[];
  const out=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:5,
    messages:[{role:'system',content:'Do the task'},{role:'user',content:'Create report-one.txt with useful content'}],
    ctx:{session:'qa-unresponsive-model'},
    onEvent:ev=>events.push(ev),
    modelCall:async()=>new Promise(()=>{}),
  });
  assert.equal(out.incomplete,true);
  assert.equal(out.stopReason,'turn_timeout');
  assert.ok(out.blocked);
  assert.ok(events.some(e=>e.type==='turn_timeout'));
  await rt.shutdown();
});
