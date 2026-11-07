import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectRequestedArtifact,feedbackForJavaScriptWrite} from '../src/core/goal-artifact.js';
import {createRuntime} from '../src/core/runtime.js';
import {loop} from '../src/core/loop.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-qwen-cjs-repair-'));
process.env.MAJIN_HOME=dir;
const ws=path.join(dir,'workspace');
fs.mkdirSync(ws,{recursive:true});
const name='qwen-agent.mjs';
const goal='Actually create and save a working Node.js CLI agent module in '+name+
  '. Export function respond(message) that returns a helpful response containing the message. '+
  'When run as node '+name+' QA_PING, the CLI MUST print QA_PING. Different arguments produce different responses.';
const qwenResult="module.exports = {respond: function(message) { return 'Received: ' + message; }}\n";
const fixed="export function respond(message) { return 'Reply: ' + message; }\nconsole.log(respond(process.argv[2] || ''));\n";

test('REAL Qwen3B regression: syntax-valid CommonJS in .mjs is NOT verified',()=>{
  fs.writeFileSync(path.join(ws,name),qwenResult);
  const st=inspectRequestedArtifact(goal,ws);
  assert.equal(st.ok,false);
  assert.match(st.reason,/CommonJS module\.exports is not an ES module export in \.mjs/);
  const feedback=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(feedback.ok,false);
  assert.match(feedback.text,/CommonJS module\.exports is not an ES module export/);
  assert.match(feedback.text,/process\.argv\[2\]/);
  assert.match(feedback.text,/Remove module\.exports and exports\.respond entirely/);
});

test('REAL Qwen3B latest regression: ESM export plus require(commander) must fail IMMEDIATELY',()=>{
  const bad="export function respond(message) { return 'Received: ' + message; } "+
    "const cli = require('commander'); cli.parse(process.argv); "+
    "console.log(respond(cli.args[0] || ''));";
  fs.writeFileSync(path.join(ws,name),bad);
  const check=inspectRequestedArtifact(goal,ws);
  assert.equal(check.ok,false);
  assert.match(check.reason,/CommonJS require\(\.\.\.\) is not available in \.mjs/);
  const output=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(output.ok,false);
  assert.match(output.text,/Use NO external CLI parser/);
  assert.match(output.text,/process\.argv\[2\]/);
  assert.match(output.text,/Do not import or require commander/);
});

test('syntax failure reports bounded Node diagnostic not full arbitrary model source',()=>{
  const secret='FAKE_SECRET_LINE_NEVER_ECHO';
  fs.writeFileSync(path.join(ws,name),"// "+secret+"\nexport function respond(message) { return message;\n");
  const result=inspectRequestedArtifact(goal,ws);
  assert.equal(result.ok,false);
  assert.match(result.reason,/node --check failed/);
  assert.match(result.reason,/SyntaxError:/);
  assert.doesNotMatch(result.reason,/FAKE_SECRET_LINE_NEVER_ECHO/);
});

test('an ESM CLI responder is accepted only for static proof; it is not executed by contract',()=>{
  const marker=path.join(ws,'must-not-run.txt');
  fs.writeFileSync(path.join(ws,name),fixed+
    "import fs from 'node:fs'; fs.writeFileSync("+JSON.stringify(marker)+",'bad');\n");
  const st=inspectRequestedArtifact(goal,ws);
  assert.equal(st.ok,true,st.reason);
  assert.equal(fs.existsSync(marker),false);
  const feedback=feedbackForJavaScriptWrite(goal,ws,'fs.write',{path:name},true);
  assert.equal(feedback.ok,true);
  assert.match(feedback.text,/not yet execution-tested/);
});

test('actual agent loop surfaces precise ESM repair hint BEFORE next Qwen-like turn',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','code','final','analysis','plan','research','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const setup=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:7}});
  assert.equal(setup.ok,true,JSON.stringify(setup.errors));
  let showed=false;
  const events=[];
  const out=await loop({cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    messages:[{role:'system',content:'Follow file goal and repair failed checks.'},{role:'user',content:goal}],
    ctx:{session:'qa-cjs-mjs-fix',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    onEvent:e=>events.push(e),
    modelCall:async({step,messages})=>{
      if(step===2){
        const result=messages.filter(m=>m.role==='tool').at(-1)?.content || '';
        assert.match(result,/CommonJS module\.exports is not an ES module export/);
        assert.match(result,/module\.exports/);
        showed=true;
      }
      if(step===1||step===2){
        return {text:'',usage:{input:1,output:1},toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:name,content:step===1?qwenResult:fixed})}]};
      }
      return {text:'Done',usage:{input:1,output:1},toolCalls:[]};
    }
  });
  assert.equal(showed,true);
  assert.equal(out.incomplete,undefined,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(ws,name),'utf8'),fixed);
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
  await rt.shutdown();
});
