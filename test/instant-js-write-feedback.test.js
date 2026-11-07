import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-live-write-feedback-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const { feedbackForJavaScriptWrite }=await import('../src/core/goal-artifact.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { loop }=await import('../src/core/loop.js');

const name='cli-agent-repair.mjs';
const goal='Actually create a working Node.js CLI agent in '+name+
  '. Export function respond(message) to reply to messages. When run as a CLI with QA_PING and DIFFERENT inputs, print the input.';
const broken="export function respond(message) { return message; }\n"+
  "const respond = (message) => message;\n"+
  "console.log(respond(process.argv[2] || ''));\n";
const working="export function respond(message) { return 'Reply: ' + message; }\n"+
  "console.log(respond(process.argv[2] || ''));\n";

test('JavaScript duplicate-declaration defect is flagged IMMEDIATELY after fs.write',()=>{
  fs.writeFileSync(path.join(ws,name),broken);
  const check=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(check.ok,false);
  assert.match(check.text,/node --check failed/);
  assert.match(check.text,/Repair THIS SAME file/);
});

test('valid saved JS yields static proof but does NOT claim CLI execution',()=>{
  fs.writeFileSync(path.join(ws,name),working);
  const check=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(check.ok,true);
  assert.match(check.text,/not yet execution-tested/);
});

test('unrelated, failed or differently targeted fs.write gets no artificial verification claim',()=>{
  const opts=[
    [goal,'fs.write',{path:'unrelated.mjs'},true],
    [goal,'fs.write',{path:name},false],
    [goal,'fs.read',{path:name},true],
    ['Write a note in report.txt','fs.write',{path:'report.txt'},true],
    ['Write both one.mjs and two.mjs','fs.write',{path:'one.mjs'},true],
  ];
  for(const args of opts)assert.equal(feedbackForJavaScriptWrite(args[0],ws,...args.slice(1)),null);
});

test('production agent writes broken Qwen code, sees feedback NEXT turn and corrects actual file',async()=>{
  fs.rmSync(path.join(ws,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const patched=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},
    guard:{mode:'off'},agent:{maxSteps:7}});
  assert.equal(patched.ok,true,JSON.stringify(patched.errors));
  let sawImmediateError=false;
  const events=[];
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    messages:[{role:'system',content:'Use tools and repair errors.'},{role:'user',content:goal}],
    ctx:{session:'qa-immediate-js-feedback',enforceActionEvidence:true,toolSubsetNames:['fs.write','fs.read']},
    onEvent:e=>events.push(e),
    modelCall:async({step,messages})=>{
      if(step===2){
        const lastTool=messages.filter(m=>m.role==='tool').at(-1);
        assert.ok(lastTool,'second model turn must see fs.write result');
        assert.match(lastTool.content,/ARTIFACT WRITE CHECK FAILED/);
        assert.match(lastTool.content,/node --check failed/);
        sawImmediateError=true;
      }
      if(step===1||step===2) return {text:'',usage:{input:1,output:1},
        toolCalls:[{id:'fs'+step,name:'fs.write',argsJson:JSON.stringify({path:name,content:step===1?broken:working})}]};
      return {text:'Done, exported CLI is ready',usage:{input:1,output:1},toolCalls:[]};
    }
  });
  assert.equal(sawImmediateError,true);
  assert.equal(result.incomplete,undefined,JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(ws,name),'utf8'),working);
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
  await rt.shutdown();
});
