import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-argv-dump-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const {inspectRequestedArtifact,feedbackForJavaScriptWrite}=await import('../src/core/goal-artifact.js');
const {createRuntime}=await import('../src/core/runtime.js');
const {loop}=await import('../src/core/loop.js');
const name='my-agent-qa-argv.mjs';
const goal='Actually create and save a working Node.js CLI agent module in '+name+
  '. Export function respond(message) that returns a helpful non-placeholder response containing the message. '+
  'When run as node '+name+' QA_PING, the CLI MUST print a response that includes QA_PING. '+
  'Running it with a DIFFERENT argument must print that other argument. No external dependencies.';
const bad="export function respond(message){return 'Reply: '+message;}\nconsole.log(process.argv);\n";
const badJson="export function respond(message){return 'Reply: '+message;}\nconsole.log(JSON.stringify(process.argv));\n";
const good="export function respond(message){return 'Reply: '+message;}\nconsole.log(respond(process.argv[2] || ''));\n";

test('genuine free-model bug: valid JS that dumps all argv instead of answering is NOT verified',()=>{
  fs.writeFileSync(path.join(workspace,name),bad);
  const p=inspectRequestedArtifact(goal,workspace);
  assert.equal(p.ok,false);
  assert.match(p.missing.join(' '),/raw process\.argv array/);
  const feedback=feedbackForJavaScriptWrite(goal,workspace,'fs.write',{path:name},true);
  assert.equal(feedback.ok,false);
  assert.match(feedback.text,/respond\(process\.argv\[2\]\)/);
});
test('JSON argv dump also fails, not fooled by syntax and exported function',()=>{
  fs.writeFileSync(path.join(workspace,name),badJson);
  const p=inspectRequestedArtifact(goal,workspace);
  assert.equal(p.ok,false);
  assert.match(p.missing.join(' '),/raw process\.argv array/);
});
test('legitimate CLI that calls exported responder with argument and prints string is accepted statically',()=>{
  fs.writeFileSync(path.join(workspace,name),good);
  const p=inspectRequestedArtifact(goal,workspace);
  assert.equal(p.ok,true,p.reason);
});
test('if user genuinely asks to inspect argv itself, do not impose respond(message) proof',()=>{
  const prompt='Create '+name+' with a Node.js CLI that prints process.argv; do not export respond(message)';
  // Explicit negative phrasing is not a simple responder fixture; this
  // contract only applies when the request actually asks for respond(message).
  fs.writeFileSync(path.join(workspace,name),'console.log(process.argv);\n');
  const result=inspectRequestedArtifact('Create '+name+' with a Node.js CLI that prints the full argument list',workspace);
  assert.equal(result.ok,true,result.reason);
});
test('production loop returns immediate argv-dump error and can repair it in next tool call',async()=>{
  fs.rmSync(path.join(workspace,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(j=>[j,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:7}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  const events=[];
  let saw=false;
  const out=await loop({
    cfg:rt.cfg,registry:rt.registry,label:'main',job:'tasks',maxSteps:7,
    ctx:{session:'argv-dump-repair',enforceActionEvidence:true,toolSubsetNames:['fs.write','fs.read']},
    messages:[{role:'system',content:'Use tools.'},{role:'user',content:goal}],
    onEvent:e=>events.push(e),
    modelCall:async({step,messages})=>{
      if(step===2) {
        const last=messages.filter(m=>m.role==='tool').at(-1);
        assert.match(last?.content||'',/raw process\.argv array/);
        saw=true;
      }
      if(step<=2)return {text:'',toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:name,content:step===1?bad:good})}],usage:{input:1,output:1}};
      return {text:'Done',toolCalls:[],usage:{input:1,output:1}};
    },
  });
  assert.equal(saw,true);
  assert.equal(out.incomplete,undefined,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(workspace,name),'utf8'),good);
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
  await rt.shutdown();
});
