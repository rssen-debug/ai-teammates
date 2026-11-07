import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-qwen-commander-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const name='my-agent-legacy.mjs';
const goal='Actually create and save a working Node.js CLI agent module in '+name+
'. Export function respond(message) that returns a helpful response containing the message. '+
'When run as node '+name+' QA_PING, print QA_PING. Running it with a DIFFERENT argument must print the other argument. No external dependencies.';
const actualQwen="export function respond(message) { return \`Received: \${message}\`; } const cli = require('commander'); cli.parse(process.argv); const args = cli.args; if (args[0] === 'QA_PING') { console.log('QA_PING'); } else { console.log(args[0]); }\n";
const { repairSimpleCommanderCliWrite }=await import('../src/core/goal-artifact.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { loop }=await import('../src/core/loop.js');

test('REAL Qwen3B generated require(commander) in no-dependency .mjs is deterministically replaced',()=>{
  const input={path:name,content:actualQwen};
  const r=repairSimpleCommanderCliWrite(goal,ws,'fs.write',input);
  assert.equal(r?.corrected,true);
  assert.deepEqual(input,{path:name,content:actualQwen});
  assert.ok(r.args.content.includes('const args = process.argv.slice(2);'));
  assert.ok(!r.args.content.includes("require('commander')"));
  fs.writeFileSync(path.join(ws,name),r.args.content);
  const check=spawnSync(process.execPath,['--check',path.join(ws,name)],{encoding:'utf8',timeout:5000});
  assert.equal(check.status,0,check.stderr);
  for(const marker of ['QA_PING','QA_OTHER_D3']){
    const executed=spawnSync(process.execPath,[path.join(ws,name),marker],{encoding:'utf8',timeout:5000});
    assert.equal(executed.status,0,executed.stderr);
    assert.ok(executed.stdout.includes(marker),executed.stdout);
  }
});

test('never rewrite optional parser behavior, other deps, other files or user-authorized dependencies',()=>{
  const requests=[
    goal.replace('No external dependencies.','You may use external dependencies.'),
    'Write a note in report.txt: no external dependencies.',
    'Create one.mjs and two.mjs with respond(message). No external dependencies. CLI.',
  ];
  for(const p of requests){
    assert.equal(repairSimpleCommanderCliWrite(p,ws,'fs.write',{path:name,content:actualQwen}),null,p);
  }
  assert.equal(repairSimpleCommanderCliWrite(goal,ws,'fs.write',{path:'other.mjs',content:actualQwen}),null);
  assert.equal(repairSimpleCommanderCliWrite(goal,ws,'fs.read',{path:name,content:actualQwen}),null);
  const optionCli=actualQwen.replace('cli.parse(process.argv);',"cli.option('-v').parse(process.argv);");
  assert.equal(repairSimpleCommanderCliWrite(goal,ws,'fs.write',{path:name,content:optionCli}),null);
  const twoRequires=actualQwen+"const pkg = require('other-lib');";
  assert.equal(repairSimpleCommanderCliWrite(goal,ws,'fs.write',{path:name,content:twoRequires}),null);
});

test('production MAJIN loop records safe repair and writes runnable no-dependency CLI',async()=>{
  fs.rmSync(path.join(ws,name),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},
    moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:6}}).ok,true);
  const events=[];
  try{
    const res=await loop({
      cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:6,
      ctx:{session:'qwen-commander-repair',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
      messages:[{role:'system',content:'Use approved real tools'},{role:'user',content:goal}],
      onEvent:e=>events.push(e),
      modelCall:async({step})=>step===1?
        {text:'',usage:{input:1,output:1},toolCalls:[{id:'w1',name:'fs.write',
          argsJson:JSON.stringify({path:name,content:actualQwen})}]}:
        {text:'The source was saved and statically checked',usage:{input:1,output:1},toolCalls:[]},
    });
    assert.notEqual(res.incomplete,true,JSON.stringify(res));
    assert.ok(events.some(x=>x.type==='artifact_cli_dependency_repaired'));
    assert.ok(events.some(x=>x.type==='artifact_write_verify'&&x.ok===true));
    const out=spawnSync(process.execPath,[path.join(ws,name),'QA_OTHER'],{encoding:'utf8',timeout:5000});
    assert.equal(out.status,0,out.stderr);
    assert.match(out.stdout,/QA_OTHER/);
    assert.equal(res.toolLog.filter(x=>x.tool==='fs.write' && x.ok).length,1);
  }finally{
    await rt.shutdown();
  }
});
