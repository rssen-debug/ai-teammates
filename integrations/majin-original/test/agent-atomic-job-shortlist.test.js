import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-atomic-shortlist-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const {shouldMission}=await import('../src/core/mission.js');
const {loop}=await import('../src/core/loop.js');
const {createRuntime}=await import('../src/core/runtime.js');
const {verifyJobIdLineage}=await import('../src/core/mission-data-evidence.js');

const src='qa-test-jobs.json';
const dst='qa-shortlist.md';
const jobs=[
  {id:'QA-IT-777',title:'Local IT Technician'},
  {id:'QA-SOC-777',title:'Junior SOC Analyst'},
  {id:'QA-CLOUD-777',title:'Cloud Technician'},
];
const goal='Read qa-test-jobs.json with fs.read. Create qa-shortlist.md with all THREE job IDs, job titles and one reason for each. These are synthetic test jobs. Do not invent real vacancies.';
const good=jobs.map((j,i)=>'- '+j.id+' — '+j.title+' — reason '+(i+1)).join('\n');
function reset(){fs.writeFileSync(path.join(workspace,src),JSON.stringify(jobs));fs.rmSync(path.join(workspace,dst),{force:true});}

test('single-source shortlist is ONE atomic agent turn, not four hallucinated DAG workers',()=>{
  assert.deepEqual(shouldMission(goal, { atomicFileTransform: true }),{mission:false,reason:'atomic JSON to job shortlist transformation'});
  assert.equal(shouldMission(goal).mission,true,'explicit mission API remains unchanged');
});
test('other multi-goal missions still route to DAG as before',()=>{
  assert.equal(shouldMission('1. Research cloud services\n2. Read networking notes\n3. Build separate system').mission,true);
});
test('real original job JSON is the only authority for expected IDs/titles',()=>{
  reset();fs.writeFileSync(path.join(workspace,dst),'Job1, Job2, Job3');
  assert.equal(verifyJobIdLineage(goal,workspace).ok,false);
  fs.writeFileSync(path.join(workspace,dst),good);
  assert.equal(verifyJobIdLineage(goal,workspace).ok,true);
});

async function runScenario(correct){
  reset();
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(k=>[k,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:8}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  let reads=0,writes=0;
  const events=[];
  const res=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:8,
    ctx:{session:'atomic-'+correct,enforceActionEvidence:true,toolSubsetNames:['fs.read','fs.write']},
    onEvent:e=>events.push(e),
    messages:[{role:'system',content:'Read the source with tools and write the exact requested file.'},{role:'user',content:goal}],
    modelCall:async({step})=>{
      if(step===1){ reads++;return {text:'',usage:{input:1,output:1},
        toolCalls:[{id:'r1',name:'fs.read',argsJson:JSON.stringify({path:src})}]};}
      if(step===2||(correct&&step===4)){writes++;return {text:'',usage:{input:1,output:1},
        toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:dst,content:step===4?good:'Job1\nJob2\nJob3'})}]};}
      return {text:'All jobs saved',toolCalls:[],usage:{input:1,output:1}};
    },
  });
  const content=fs.existsSync(path.join(workspace,dst))?fs.readFileSync(path.join(workspace,dst),'utf8'):'';
  await rt.shutdown();
  return {res,events,reads,writes,content};
}
test('failed source-ID integrity causes a bounded correction, then real PASS',async()=>{
  const v=await runScenario(true);
  assert.equal(v.reads,1);
  assert.equal(v.writes,2);
  assert.equal(v.res.incomplete,undefined,JSON.stringify(v.res));
  assert.equal(v.content,good);
  assert.ok(v.events.some(e=>e.type==='artifact_verify'&&e.ok===false));
  assert.ok(v.events.some(e=>e.type==='artifact_verify'&&e.ok===true));
});
test('after unsuccessful correction a placeholder shortlist is INCOMPLETE, never PASS',async()=>{
  const v=await runScenario(false);
  assert.equal(v.reads,1);
  assert.equal(v.writes,1);
  assert.equal(v.res.incomplete,true);
  assert.equal(v.res.stopReason,'artifact_contract_failed');
  assert.ok(v.res.contract?.reason.includes('source-identifier integrity'));
  assert.ok(v.res.steps<=6);
});
