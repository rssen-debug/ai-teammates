import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-mixed-esm-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const {repairSimpleMixedEsmCliWrite,inspectRequestedArtifact}=await import('../src/core/goal-artifact.js');
const {createRuntime}=await import('../src/core/runtime.js');
const {loop}=await import('../src/core/loop.js');
const name='qwen-respond-agent.mjs';
const goal='Actually create a working Node.js CLI agent module in '+name+
 '. Export function respond(message) that returns a helpful non-placeholder response containing the message. '+
 'When run as node '+name+' QA_PING, the CLI MUST print QA_PING, and with a DIFFERENT argument print that other argument. No external dependencies.';
const modelCode='export function respond(message) { return '+String.fromCharCode(96)+'Received: '+String.fromCharCode(36)+'{message}'+String.fromCharCode(96)+'; } module.exports = { respond };';

test('exact free-Qwen failure is repaired into truly runnable ESM CLI with two distinct outputs',()=>{
  const proof=repairSimpleMixedEsmCliWrite(goal,workspace,'fs.write',{path:name,content:modelCode});
  assert.equal(proof?.corrected,true,'real artifact must match safe narrow rewrite');
  assert.doesNotMatch(proof.args.content,/module\.exports|require\(/);
  const target=path.join(workspace,name);
  fs.writeFileSync(target,proof.args.content);
  assert.equal(inspectRequestedArtifact(goal,workspace).ok,true);
  for(const arg of ['QA_PING','DIFFERENT_INPUT']){
    const run=spawnSync(process.execPath,[target,arg],{encoding:'utf8',timeout:3000});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,new RegExp(arg));
  }
  const imported=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify('file://'+target.replaceAll('\\','/'))+')'],{encoding:'utf8',timeout:3000});
  assert.equal(imported.status,0,imported.stderr);
  assert.equal(imported.stdout,'','import should not print CLI side effects');
});

test('never rewrite user modules with real imports, side effects, options or already implemented CLI',()=>{
  const variations=[
    modelCode+'\nconsole.log(42);',
    'import fs from "node:fs";\n'+modelCode,
    modelCode.replace('module.exports = { respond };','module.exports={ respond, other };'),
    modelCode.replace('return ','return process.env.SECRET || '),
    modelCode.replace('export function respond','function respond'),
    modelCode.replace('return ','return eval("1") + '),
    modelCode.replace('module.exports = { respond };',''),
  ];
  for(const content of variations)assert.equal(repairSimpleMixedEsmCliWrite(goal,workspace,'fs.write',{path:name,content}),null,content);
  assert.equal(repairSimpleMixedEsmCliWrite(goal,workspace,'fs.read',{path:name,content:modelCode}),null);
  assert.equal(repairSimpleMixedEsmCliWrite(goal,workspace,'fs.write',{path:'another.mjs',content:modelCode}),null);
  assert.equal(repairSimpleMixedEsmCliWrite('Make a basic module '+name,workspace,'fs.write',{path:name,content:modelCode}),null);
});

test('production MAJIN loop safely patches requested fs.write and preserves actual CLI output',async()=>{
  fs.rmSync(path.join(workspace,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(j=>[j,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:5}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  const events=[];
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,label:'main',job:'tasks',maxSteps:5,
    ctx:{session:'qa-real-bad-esm-repair',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    messages:[{role:'system',content:'Use tools.'},{role:'user',content:goal}],
    onEvent:e=>events.push(e),
    modelCall:async({step})=>step===1
      ? {text:'',toolCalls:[{id:'w1',name:'fs.write',argsJson:JSON.stringify({path:name,content:modelCode})}],usage:{input:1,output:1}}
      : {text:'Done',toolCalls:[],usage:{input:1,output:1}},
  });
  assert.equal(result.incomplete,undefined,JSON.stringify(result));
  assert.ok(events.some(e=>e.type==='artifact_cli_dependency_repaired'));
  assert.ok(events.some(e=>e.type==='artifact_write_verify'&&e.ok===true));
  const run=spawnSync(process.execPath,[path.join(workspace,name),'QA_PING'],{encoding:'utf8',timeout:3000});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/QA_PING/);
  await rt.shutdown();
});
