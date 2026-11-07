import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-esm-qa-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const {inspectRequestedArtifact,feedbackForJavaScriptWrite}=await import('../src/core/goal-artifact.js');
const {loop}=await import('../src/core/loop.js');
const {createRuntime}=await import('../src/core/runtime.js');

const name='qa-cli-agent.mjs';
const goal='Actually create and save a working Node.js CLI agent module in '+name+
 '. Export function respond(message) that returns the message. When run as a CLI with QA_PING, print QA_PING; a DIFFERENT argument must print that input.';
const bad="module.exports = {respond: function(message) { return " +
  String.fromCharCode(96)+"Received: " + '$' + "{message}\\n" + String.fromCharCode(96) + "; }}";
const good="export function respond(message) { return 'Received: ' + message; }\n"+
  "console.log(respond(process.argv[2] || ''));\n";

test('exact real Qwen .mjs CommonJS output is rejected with actionable ESM and CLI guidance',()=>{
  fs.writeFileSync(path.join(ws,name),bad);
  const r=inspectRequestedArtifact(goal,ws);
  assert.equal(r.ok,false,r.reason);
  assert.ok(r.missing.some(m=>/CommonJS module.exports/.test(m)),r.reason);
  const feedback=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(feedback.ok,false);
  for(const needle of ['CommonJS','export function respond(message)','process.argv[2]','Remove module.exports']) {
    assert.ok(feedback.text.includes(needle),needle+' must be visible to the model');
  }
});
test('valid ESM responder with CLI args is independently recognized (no code run)',()=>{
  fs.writeFileSync(path.join(ws,name),good);
  const verdict=inspectRequestedArtifact(goal,ws);
  assert.equal(verdict.ok,true,verdict.reason);
});
test('wrong target or unrelated goal cannot trigger guidance',()=>{
  fs.writeFileSync(path.join(ws,name),bad);
  assert.equal(feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:'other.mjs'},true),null);
  assert.equal(feedbackForJavaScriptWrite('Create a note.md',ws,'fs.write',{path:name},true),null);
  assert.equal(feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},false),null);
});
test('actual MAJIN loop surfaces exact hint after fs.write and resolves the same file',async()=>{
  fs.rmSync(path.join(ws,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},
    guard:{mode:'off'},agent:{maxSteps:7}}).ok,true);
  let hintSeen=false;
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    ctx:{session:'qa-exact-cjs-failure',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    messages:[{role:'system',content:'Use real tools to create working code.'},{role:'user',content:goal}],
    modelCall:async({step,messages})=>{
      if(step===2) {
        const text=messages.filter(x=>x.role==='tool').at(-1)?.content || '';
        assert.match(text,/CommonJS module.exports/);
        assert.match(text,/export function respond/);
        hintSeen=true;
      }
      if(step===1||step===2) return {
        text:'',usage:{input:1,output:1},
        toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:name,content:step===1?bad:good})}],
      };
      return {text:'Done',usage:{input:1,output:1},toolCalls:[]};
    },
  });
  assert.equal(hintSeen,true,'the repair hint must be in model context');
  assert.equal(result.incomplete,undefined,JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(ws,name),'utf8'),good);
  await rt.shutdown();
});
