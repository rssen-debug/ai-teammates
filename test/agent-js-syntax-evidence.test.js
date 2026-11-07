import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-syntax-proof-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const { inspectRequestedArtifact }=await import('../src/core/goal-artifact.js');
const { loop }=await import('../src/core/loop.js');
const { createRuntime }=await import('../src/core/runtime.js');
const name='actual-agent.mjs';
const prompt='Actually create and save a working Node.js CLI agent module in '+name+
  '. Export function respond(message) that returns the message. '+
  'When run as a CLI with QA_PING and a DIFFERENT argument, print each input.';
const valid="export function respond(message){ return 'Reply: ' + message; }\nconsole.log(respond(process.argv[2] || ''));\n";
const invalid="export function respond(message){ return 'Reply: ' + message;\nconsole.log(respond(process.argv[2] || ''));\n";

test('regression: syntactically broken Qwen CLI is NOT independently verified',()=>{
  fs.writeFileSync(path.join(workspace,name),invalid);
  const result=inspectRequestedArtifact(prompt,workspace);
  assert.equal(result.ok,false,result.reason);
  assert.ok(result.missing.some(x=>x.includes('node --check')),result.reason);
});

test('valid JS passes syntax and declared static contract without running user code',()=>{
  fs.writeFileSync(path.join(workspace,name),valid);
  const result=inspectRequestedArtifact(prompt,workspace);
  assert.equal(result.ok,true,result.reason);
});

test('non-JavaScript files are not passed to the Node parser',()=>{
  const txt='receipt.txt';
  fs.writeFileSync(path.join(workspace,txt),'Text with } intentionally not JavaScript');
  const result=inspectRequestedArtifact('Create receipt.txt with a short note',workspace);
  assert.equal(result.ok,true,result.reason);
});

test('production agent loop does not announce done until syntax fault was repaired',async()=>{
  fs.rmSync(path.join(workspace,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const patched=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:7}});
  assert.equal(patched.ok,true,JSON.stringify(patched.errors));
  const events=[];
  const out=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    messages:[{role:'system',content:'Use real tools.'},{role:'user',content:prompt}],
    ctx:{session:'qa-syntax-repair',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    onEvent:e=>events.push(e),
    modelCall:async({step})=>{
      if(step===1||step===3) return {text:'',usage:{input:1,output:1},
        toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:name,content:step===1?invalid:valid})}]};
      return {text:'Done, CLI agent saved',usage:{input:1,output:1},toolCalls:[]};
    },
  });
  assert.equal(out.incomplete,undefined,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(workspace,name),'utf8'),valid);
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===true));
  await rt.shutdown();
});

test('never auto-execute the saved CLI file while checking its syntax',()=>{
  const marker=path.join(workspace,'should-never-execute.txt');
  const malicious="import fs from 'node:fs'; fs.writeFileSync("+JSON.stringify(marker)+",'executed');\n"+
    "export function respond(message){return message;}\nconsole.log(respond(process.argv[2]));";
  fs.writeFileSync(path.join(workspace,name),malicious);
  const verdict=inspectRequestedArtifact(prompt,workspace);
  assert.equal(verdict.ok,true,verdict.reason);
  assert.equal(fs.existsSync(marker),false,'syntax check must NOT execute model-generated code');
});
