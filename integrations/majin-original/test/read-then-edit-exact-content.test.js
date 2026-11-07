import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-read-edit-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const file='note-exact-edit-fixture.txt';
const target=path.join(workspace,file);
const old='QA_FILE_EDIT_FIXTURE';
const updated=old+'_EDITED';
const goal='Read '+file+', then modify it so its content is EXACTLY '+updated+'. Use fs.write.';
const { requiresRealAction, loop }=await import('../src/core/loop.js');
const { feedbackForExactContentWrite, inspectRequestedArtifact }=await import('../src/core/goal-artifact.js');
const { createRuntime }=await import('../src/core/runtime.js');

test('read-then-modify is a real action; explanatory question is not',()=>{
  assert.equal(requiresRealAction(goal),true);
  assert.equal(requiresRealAction('Read '+file+', then explain how to modify it'),false);
  assert.equal(requiresRealAction('How do I read '+file+' and modify it?'),false);
});

test('wrong exact content gets immediate repair feedback; correct file passes',()=>{
  fs.writeFileSync(target,old);
  const wrong=feedbackForExactContentWrite(goal,workspace,'fs.write',{path:file},true);
  assert.equal(wrong.ok,false);
  assert.match(wrong.text,/EXACT CONTENT WRITE CHECK FAILED/);
  assert.equal(inspectRequestedArtifact(goal,workspace).ok,false);
  fs.writeFileSync(target,updated);
  const good=feedbackForExactContentWrite(goal,workspace,'fs.write',{path:file},true);
  assert.equal(good.ok,true);
  assert.equal(inspectRequestedArtifact(goal,workspace).ok,true);
});

test('no fabricated proof for unrelated writes, failed tools or ambiguous goals',()=>{
  fs.writeFileSync(target,old);
  assert.equal(feedbackForExactContentWrite(goal,workspace,'fs.write',{path:'another.txt'},true),null);
  assert.equal(feedbackForExactContentWrite(goal,workspace,'fs.write',{path:file},false),null);
  assert.equal(feedbackForExactContentWrite(goal,workspace,'fs.patch',{path:file},true),null);
  assert.equal(feedbackForExactContentWrite('Read '+file+' and another.txt, then edit them EXACTLY',workspace,'fs.write',{path:file},true),null);
});

test('production MAJIN gives model wrong-content feedback and repairs exact bytes before DONE',async()=>{
  fs.writeFileSync(target,old);
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(k=>[k,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},
    guard:{mode:'off'},agent:{maxSteps:7}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  const events=[];
  let receivedFeedback=false;
  try{
    const out=await loop({
      cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
      ctx:{session:'qa-exact-edit',enforceActionEvidence:true,toolSubsetNames:['fs.read','fs.write']},
      messages:[{role:'system',content:'Use real tools and repair the exact file.'},{role:'user',content:goal}],
      onEvent:e=>events.push(e),
      modelCall:async({step,messages})=>{
        if(step===1)return {text:'',usage:{input:1,output:1},
          toolCalls:[{id:'r1',name:'fs.read',argsJson:JSON.stringify({path:file})}]};
        if(step===2)return {text:'',usage:{input:1,output:1},
          toolCalls:[{id:'w2',name:'fs.write',argsJson:JSON.stringify({path:file,content:old})}]};
        if(step===3){
          const recent=messages.filter(x=>x.role==='tool').at(-1)?.content||'';
          assert.match(recent,/EXACT CONTENT WRITE CHECK FAILED/);
          receivedFeedback=true;
          return {text:'',usage:{input:1,output:1},
            toolCalls:[{id:'w3',name:'fs.write',argsJson:JSON.stringify({path:file,content:updated})}]};
        }
        return {text:'Verified file updated',toolCalls:[],usage:{input:1,output:1}};
      },
    });
    assert.equal(receivedFeedback,true);
    assert.equal(out.incomplete,undefined,JSON.stringify(out));
    assert.equal(fs.readFileSync(target,'utf8'),updated);
    assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===false));
    assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
    assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===true));
  }finally{await rt.shutdown();}
});
