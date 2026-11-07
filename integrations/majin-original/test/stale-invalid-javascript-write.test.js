import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-repeated-invalid-cli-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const {unchangedInvalidJavaScriptWrite,feedbackForJavaScriptWrite}=await import('../src/core/goal-artifact.js');
const {createRuntime}=await import('../src/core/runtime.js');
const {loop}=await import('../src/core/loop.js');
const target='qwen-stale-agent.mjs';
const goal='Actually create a working Node.js CLI agent module in '+target+
  '. Export function respond(message) that returns a helpful non-placeholder response containing the message. '+
  'When run as node '+target+' QA_PING, the CLI MUST print a response that includes QA_PING. '+
  'Running it with a DIFFERENT argument must print that other argument. No external dependencies. Not just a placeholder.';
const quote=String.fromCharCode(96), dollar=String.fromCharCode(36);
const invalid='export function respond(message) {\n  return '+quote+'Received: '+dollar+'{message}\n}\n\n'+
  "process.on('uncaughtException', (err) => {\n  console.error("+quote+'Error: '+dollar+'{err.message}\n'+quote+');\n});';
const valid='export function respond(message) { return "Received: " + message; }\n'+
  'console.log(respond(process.argv[2] || ""));\n';
const dest=path.join(ws,target);
function reset(){fs.rmSync(dest,{force:true});}

test('exact Qwen broken template string produces actionable syntax feedback',()=>{
  reset();fs.writeFileSync(dest,invalid);
  const bad=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:target,content:invalid},true);
  assert.equal(bad.ok,false);
  assert.match(bad.text,/node --check failed/);
  assert.match(bad.text,/minimal valid ESM CLI pattern/);
  const duplicate=unchangedInvalidJavaScriptWrite(goal,ws,'fs.write',
    {path:target,content:invalid},invalid);
  assert.match(duplicate.reason,/UNCHANGED INVALID JAVASCRIPT/);
  assert.equal(unchangedInvalidJavaScriptWrite(goal,ws,'fs.write',
    {path:target,content:valid},invalid),null);
});

test('previous invalid snapshot cannot block unrelated or externally corrected file',()=>{
  reset();fs.writeFileSync(dest,valid);
  assert.equal(unchangedInvalidJavaScriptWrite(goal,ws,'fs.write',
    {path:target,content:invalid},invalid),null);
  fs.writeFileSync(dest,invalid);
  assert.equal(unchangedInvalidJavaScriptWrite('Create note.txt',ws,'fs.write',
    {path:target,content:invalid},invalid),null);
  assert.equal(unchangedInvalidJavaScriptWrite(goal,ws,'fs.read',
    {path:target,content:invalid},invalid),null);
});

async function scenario(repair){
  reset();
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const cfg=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},
    moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:8}});
  assert.equal(cfg.ok,true,JSON.stringify(cfg.errors));
  const events=[];
  const out=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:8,
    messages:[{role:'system',content:'Use tools and repair errors.'},{role:'user',content:goal}],
    ctx:{session:'qa-duplicate-'+repair,enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    onEvent:e=>events.push(e),
    modelCall:async({step,messages})=>{
      const msgs=messages.filter(m=>m.role==='tool');
      if(step===2)assert.match(msgs.at(-1)?.content||'',/ARTIFACT WRITE CHECK FAILED/);
      if(step===3)assert.match(msgs.at(-1)?.content||'',/unchanged_invalid_artifact/);
      if(repair&&step>=4)return {text:'Done',toolCalls:[],usage:{input:1,output:1}};
      return {text:'',usage:{input:1,output:1},toolCalls:[{
        id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:target,content:repair&&step===3?valid:invalid})
      }]};
    }
  });
  const saved=fs.readFileSync(dest,'utf8');
  await rt.shutdown();
  return {out,events,saved};
}

test('real agent skips redundant invalid write, then repairs changed source',async()=>{
  const {out,events,saved}=await scenario(true);
  assert.equal(out.incomplete,undefined,JSON.stringify(out));
  assert.equal(saved,valid);
  assert.deepEqual(out.toolLog.map(t=>t.ok),[true,false,true]);
  assert.ok(events.some(e=>e.type==='artifact_unchanged_invalid'&&e.repeats===1));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
});

test('unresponsive agent gets honest repeat-block after duplicates, no false success',async()=>{
  const {out,events,saved}=await scenario(false);
  assert.equal(out.stopReason,'repeat_block');
  assert.ok(out.blocked);
  assert.equal(saved,invalid);
  assert.deepEqual(out.toolLog.map(t=>t.ok),[true,false,false]);
  assert.equal(events.filter(e=>e.type==='artifact_unchanged_invalid').length,2);
});
