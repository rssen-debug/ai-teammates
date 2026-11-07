import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-delete-outcome-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const name='delete-only-this-agent-fixture.txt';
const goal='Delete the test fixture file '+name+' using fs.delete with permanent:true. Only this file. Wait for approval.';
const target=path.join(workspace,name);
const { verifySingleFileDeletion }=await import('../src/core/goal-artifact.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { loop }=await import('../src/core/loop.js');

test('the real fs.delete is required, with the exact requested path, permanent:true and absent-file evidence',()=>{
  fs.writeFileSync(target,'qa-only');
  const args={path:name,permanent:true};
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',args,true)?.ok,false,'file still exists');
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',args,false),null,'failed tool is never proof');
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.read',args,true),null,'read cannot prove delete');
  fs.rmSync(target);
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',args,true)?.ok,true);
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',{path:name,permanent:false},true),null);
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',{path:'other.txt',permanent:true},true),null);
  assert.equal(verifySingleFileDeletion(goal,workspace,'fs.delete',{path:'../'+name,permanent:true},true),null);
});

test('multi-action, how-to and ambiguous requests cannot short-circuit work',()=>{
  assert.equal(verifySingleFileDeletion('How do I delete '+name+'?',workspace,'fs.delete',{path:name,permanent:true},true),null);
  assert.equal(verifySingleFileDeletion('Delete '+name+' and then send an email',workspace,'fs.delete',{path:name,permanent:true},true),null);
  assert.equal(verifySingleFileDeletion('Delete '+name+' and other.txt',workspace,'fs.delete',{path:name,permanent:true},true),null);
});

test('actual MAJIN agent never asks an LLM again after verified single permanent deletion',async()=>{
  fs.writeFileSync(target,'qa-delete-fixture');
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(k=>[k,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},
    guard:{mode:'off'},agent:{maxSteps:5}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  let modelCalls=0;
  const events=[];
  try {
    const result=await loop({
      cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:5,
      ctx:{session:'qa-verified-delete-one-step',enforceActionEvidence:true,toolSubsetNames:['fs.delete']},
      messages:[{role:'system',content:'Use the real tool.'},{role:'user',content:goal}],
      onEvent:e=>events.push(e),
      modelCall:async()=>{
        modelCalls++;
        if(modelCalls>1)throw Error('ollama sent an empty stream — this second call must NEVER happen');
        return {text:'',usage:{input:1,output:1},
          toolCalls:[{id:'del-1',name:'fs.delete',argsJson:JSON.stringify({path:name,permanent:true})}]};
      }
    });
    assert.equal(modelCalls,1,'no follow-up provider request after a verified destructive action');
    assert.equal(fs.existsSync(target),false,'actual fs.delete removed the isolated temp file');
    assert.equal(result.stopReason,'verified_single_delete');
    assert.equal(result.error,undefined);
    assert.equal(result.incomplete,undefined);
    assert.match(result.text,/verified absent/);
    assert.ok(events.some(e=>e.type==='artifact_delete_verified'&&e.ok===true));
    assert.ok(result.toolLog.some(x=>x.tool==='fs.delete'&&x.ok));
  }finally{await rt.shutdown();}
});
