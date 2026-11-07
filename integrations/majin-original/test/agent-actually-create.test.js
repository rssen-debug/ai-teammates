import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-actually-create-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const {loop,requiresRealAction}=await import('../src/core/loop.js');
const {createRuntime}=await import('../src/core/runtime.js');

test('action intents recognize actual real-model prompts, not exploratory questions',()=>{
  assert.equal(requiresRealAction('Actually create and save a working Node.js CLI agent module in my-agent.mjs. Export function respond(message).'),true);
  assert.equal(requiresRealAction('Actually build a landing page called landing.html.'),true);
  assert.equal(requiresRealAction('Faktiskt skapa filen minfil.txt'),true);
  assert.equal(requiresRealAction('How do I create a file named learning.txt?'),false);
});

test('real Qwen placeholder cannot be marked complete for Actually create Node.js CLI agent',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'}}).ok,true);
  const goal='Actually create and save a working Node.js CLI agent module in qa-real-cli.mjs. Export function respond(message) that returns a helpful non-placeholder response containing the message. When run with QA_PING, the CLI MUST print QA_PING, with a DIFFERENT argument print the other.';
  let calls=0;
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    ctx:{session:'qa-actual-cli',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    messages:[{role:'system',content:'Run tools'},{role:'user',content:goal}],
    modelCall:async({step})=>{calls++;
      if(step===1)return {text:'',toolCalls:[{id:'w1',name:'fs.write',argsJson:JSON.stringify({path:'qa-real-cli.mjs',content:'QA_PING'})}],usage:{input:1,output:1}};
      return {text:'Completed my CLI',toolCalls:[],usage:{input:1,output:1}};
    }
  });
  assert.equal(fs.readFileSync(path.join(workspace,'qa-real-cli.mjs'),'utf8'),'QA_PING');
  assert.equal(result.incomplete,true,'model cannot pass simply because fs.write succeeded');
  assert.equal(result.stopReason,'artifact_contract_failed');
  assert.ok(result.steps<=4,'bounded repair does not spin forever');
  assert.ok(calls<=4);
  await rt.shutdown();
});
