import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresOrderedToolCalls, runToolCalls } from '../src/core/loop.js';

test('browser.open then browser.read and screenshot must run sequentially in ONE agent step',async()=>{
  const calls=[{name:'browser.open'},{name:'browser.read'},{name:'browser.shot'}];
  assert.equal(requiresOrderedToolCalls(calls),true);
  let opened=false;
  const seen=[];
  const results=await runToolCalls(calls,async(call)=>{
    seen.push('start:'+call.name);
    if(call.name==='browser.open') {
      await new Promise(r=>setTimeout(r,25));
      opened=true;
    }else{
      assert.equal(opened,true,call.name+' raced before browser.open completed');
    }
    seen.push('done:'+call.name);
    return {ok:true,name:call.name};
  });
  assert.deepEqual(seen,[
    'start:browser.open','done:browser.open',
    'start:browser.read','done:browser.read',
    'start:browser.shot','done:browser.shot'
  ]);
  assert.deepEqual(results.map(r=>r.name),calls.map(c=>c.name));
});

test('filesystem write/read and exec start/wait are ordered for correct side effects',async()=>{
  for(const names of [
    ['fs.write','fs.read'],
    ['fs.delete','fs.list'],
    ['exec.start','exec.wait'],
    ['browser.fill','browser.click'],
  ]){
    const calls=names.map(name=>({name}));
    assert.equal(requiresOrderedToolCalls(calls),true,names.join('/'));
    const seen=[];
    await runToolCalls(calls,async c=>{
      seen.push('begin:'+c.name);
      await new Promise(r=>setTimeout(r,10));
      seen.push('end:'+c.name);
      return c.name;
    });
    assert.deepEqual(seen,['begin:'+names[0],'end:'+names[0],'begin:'+names[1],'end:'+names[1]]);
  }
});

test('independent tools still launch concurrently without performance regression',async()=>{
  const calls=[{name:'web.search'},{name:'math.calculate'},{name:'fs.list'}];
  assert.equal(requiresOrderedToolCalls(calls),false);
  const started=[];
  const promises=[];
  const p=runToolCalls(calls,async c=>{
    started.push(c.name);
    return await new Promise(resolve=>promises.push(()=>resolve(c.name)));
  });
  await Promise.resolve();
  assert.deepEqual(started,calls.map(c=>c.name));
  for(const finish of promises)finish();
  assert.deepEqual(await p,calls.map(c=>c.name));
});

test('agent.parallel=false explicitly serializes even otherwise independent tools',async()=>{
  let concurrent=0,peak=0;
  const result=await runToolCalls([{name:'a'},{name:'b'},{name:'c'}],async c=>{
    concurrent++;peak=Math.max(peak,concurrent);
    await new Promise(resolve=>setTimeout(resolve,5));
    concurrent--;
    return c.name;
  },{parallel:false});
  assert.equal(peak,1);
  assert.deepEqual(result,['a','b','c']);
});

test('no-op or single tool call does not invent ordering requirements',()=>{
  assert.equal(requiresOrderedToolCalls([]),false);
  assert.equal(requiresOrderedToolCalls([{name:'browser.open'}]),false);
  assert.equal(requiresOrderedToolCalls([{name:'fs.write'},{name:'fs.write'}]),false);
});
