import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-local-token-proof-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const {verifyLocalTokenDemoFiles}=await import('../src/core/goal-artifact.js');
const {createRuntime}=await import('../src/core/runtime.js');
const {loop}=await import('../src/core/loop.js');
const solName='ExampleToken-qaunit.sol',notesName='deployment-notes-qaunit.md';
const goal='For a local QA demo ONLY, create '+solName+
  ' containing a simple Solidity ERC-20-like demo contract called ExampleToken with totalSupply and transfer support. '+
  'Write '+notesName+' describing a testnet-only deployment, NO live chain, NO wallet keys and NO real funds. Save both files.';
const sol='pragma solidity ^0.8.0;\ncontract ExampleToken {uint public totalSupply=1000; function transfer(address to,uint amount) public returns (bool){return true;}}\n';
const notes='# Testnet only deployment notes\nCompile locally, deploy only to a testnet. NO live release; no wallet keys, no real funds.\n';
const writes=()=>[
  {name:'fs.write',args:{path:solName},out:{ok:true}},
  {name:'fs.write',args:{path:notesName},out:{ok:true}}
];

test('real written Solidity+notes count as verified LOCAL demo artifacts, never deployed token',()=>{
  fs.writeFileSync(path.join(ws,solName),sol);
  fs.writeFileSync(path.join(ws,notesName),notes);
  const v=verifyLocalTokenDemoFiles(goal,ws,writes());
  assert.equal(v.ok,true);
  assert.match(v.text,/NO deployment performed/);
  assert.match(v.text,/NOT audited/);
});

test('pre-existing files alone, failed or incomplete tool calls cannot manufacture success',()=>{
  fs.writeFileSync(path.join(ws,solName),sol);
  fs.writeFileSync(path.join(ws,notesName),notes);
  assert.equal(verifyLocalTokenDemoFiles(goal,ws,[]),null);
  assert.equal(verifyLocalTokenDemoFiles(goal,ws,[writes()[0]]),null);
  assert.equal(verifyLocalTokenDemoFiles(goal,ws,[writes()[0],{...writes()[1],out:{ok:false}}]),null);
  assert.equal(verifyLocalTokenDemoFiles(goal.replace('NO live chain','launch on mainnet'),ws,writes()),null);
  assert.equal(verifyLocalTokenDemoFiles('Create a crypto and send real funds',ws,writes()),null);
});

test('missing/invalid source markers and symlink source are never called verified',()=>{
  fs.writeFileSync(path.join(ws,solName),'contract ExampleToken {}');
  fs.writeFileSync(path.join(ws,notesName),notes);
  assert.equal(verifyLocalTokenDemoFiles(goal,ws,writes()).ok,false);
  fs.writeFileSync(path.join(ws,solName),sol);
  fs.writeFileSync(path.join(ws,notesName),'production deployment with real cash');
  assert.equal(verifyLocalTokenDemoFiles(goal,ws,writes()).ok,false);
});

test('production loop returns after TWO real guarded fs.write tools; never needs extra empty inference',async()=>{
  fs.rmSync(path.join(ws,solName),{force:true});
  fs.rmSync(path.join(ws,notesName),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:8}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  let calls=0;const events=[];
  try{
    const out=await loop({
      cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:8,
      messages:[{role:'system',content:'Save two testnet-only files, do not deploy'},{role:'user',content:goal}],
      ctx:{session:'qa-token-demo',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
      onEvent:e=>events.push(e),
      modelCall:async({step})=>{
        calls++;
        assert.equal(step,1,'no second Ollama/model call after independently verified files');
        return {text:'',usage:{input:1,output:1},toolCalls:[
          {id:'sol',name:'fs.write',argsJson:JSON.stringify({path:solName,content:sol})},
          {id:'notes',name:'fs.write',argsJson:JSON.stringify({path:notesName,content:notes})},
        ]};
      }
    });
    assert.equal(calls,1);
    assert.equal(out.stopReason,'verified_local_token_demo_files');
    assert.notEqual(out.incomplete,true);
    assert.equal(out.toolLog.filter(t=>t.tool==='fs.write' && t.ok).length,2);
    assert.ok(events.some(e=>e.type==='local_token_demo_verified'));
    assert.match(out.text,/NO deployment performed/);
    assert.equal(verifyLocalTokenDemoFiles(goal,ws,writes()).ok,true);
  }finally{await rt.shutdown();}
});
