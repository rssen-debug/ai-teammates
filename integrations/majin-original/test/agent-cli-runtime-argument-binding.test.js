import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'majin-cli-unbound-'));
process.env.MAJIN_HOME=root;
const workspace=path.join(root,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const name='qa-real-cli.mjs';
const goal='Actually create a working Node.js CLI agent module in '+name+
  '. Export function respond(message) that returns a helpful non-placeholder response containing the message. '+
  'When run as node '+name+' QA_PING, the CLI MUST print a response that includes QA_PING. '+
  'Running it with a DIFFERENT argument must print that other argument. No external dependencies.';
const bad='export function respond(message) { return "Received: " + message; } '+
  "const QA_PING = 'QA_PING'; const QA_DIFFERENT = 'DIFFERENT'; "+
  'const args = process.argv.slice(2); '+
  'if (args.length === 0) { console.log(QA_PING); } '+
  'else if (args[0] === QA_PING) { console.log(QA_PING); } '+
  'else if (args[0] === QA_DIFFERENT) { console.log(QA_DIFFERENT); }';
const good='export function respond(message) { return "Received: " + message; }\n'+
  'console.log(respond(process.argv[2] || ""));\n';
const dest=path.join(workspace,name);
const {inspectRequestedArtifact,feedbackForJavaScriptWrite}=await import('../src/core/goal-artifact.js');
const {loop}=await import('../src/core/loop.js');
const {createRuntime}=await import('../src/core/runtime.js');

test('exact REAL Qwen hardcoded branches are rejected despite clean Node syntax',()=>{
  fs.writeFileSync(dest,bad);
  const check=spawnSync(process.execPath,['--check',dest],{encoding:'utf8'});
  assert.equal(check.status,0,'the bad code is syntactically valid');
  const result=inspectRequestedArtifact(goal,workspace);
  assert.equal(result.ok,false);
  assert.match(result.missing.join(';'),/does not call respond\(\) with the runtime argument/);
  const feedback=feedbackForJavaScriptWrite(goal,workspace,'fs.write',{path:name},true);
  assert.equal(feedback.ok,false);
  assert.match(feedback.text,/ANY new input/);
});

test('actual exported responder propagates two different unpredictable CLI args',()=>{
  fs.writeFileSync(dest,good);
  assert.equal(inspectRequestedArtifact(goal,workspace).ok,true);
  const a=spawnSync(process.execPath,[dest,'QA_PING_RANDOM_2026'],{encoding:'utf8'});
  const b=spawnSync(process.execPath,[dest,'QA_OTHER_RANDOM_2026'],{encoding:'utf8'});
  assert.equal(a.status,0);
  assert.equal(b.status,0);
  assert.match(a.stdout,/QA_PING_RANDOM_2026/);
  assert.match(b.stdout,/QA_OTHER_RANDOM_2026/);
  assert.notEqual(a.stdout,b.stdout);
});

test('legacy CLI that directly prints a new positional argument remains valid',()=>{
  const direct='export function respond(message) { return "Received: " + message; }\n'+
    "const args = process.argv.slice(2); if (args[0] === 'QA_PING') { console.log('QA_PING'); } else { console.log(args[0]); }\n";
  fs.writeFileSync(dest,direct);
  const verdict=inspectRequestedArtifact(goal,workspace);
  assert.equal(verdict.ok,true,verdict.reason);
  const a=spawnSync(process.execPath,[dest,'QA_PING_NEVER_SEEN_A'],{encoding:'utf8'});
  const b=spawnSync(process.execPath,[dest,'QA_PING_NEVER_SEEN_B'],{encoding:'utf8'});
  assert.equal(a.status,0);
  assert.equal(b.status,0);
  assert.match(a.stdout,/QA_PING_NEVER_SEEN_A/);
  assert.match(b.stdout,/QA_PING_NEVER_SEEN_B/);
});

test('real MAJIN agent receives immediate failure feedback then repairs original CLI',async()=>{
  fs.rmSync(dest,{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const patch=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:6}});
  assert.equal(patch.ok,true,JSON.stringify(patch.errors));
  const events=[];
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:6,
    messages:[{role:'system',content:'Use real tools to create a working CLI.'},{role:'user',content:goal}],
    ctx:{session:'qa-actual-unbound-responder',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    onEvent:e=>events.push(e),
    modelCall:async({step,messages})=>{
      if(step===2) {
        const msg=messages.filter(m=>m.role==='tool').at(-1)?.content||'';
        assert.match(msg,/CLI does not call respond\(\) with the runtime argument/);
      }
      if(step>=3) return {text:'CLI saved',toolCalls:[],usage:{input:1,output:1}};
      return {text:'',toolCalls:[{id:'w'+step,name:'fs.write',
        argsJson:JSON.stringify({path:name,content:step===1?bad:good})}],usage:{input:1,output:1}};
    },
  });
  assert.equal(result.incomplete,undefined,JSON.stringify(result));
  assert.equal(fs.readFileSync(dest,'utf8'),good);
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
  await rt.shutdown();
});
