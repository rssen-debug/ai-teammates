import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-job-target-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const { pinJobShortlistWrite, verifyJobIdLineage } = await import('../src/core/mission-data-evidence.js');
const {loop}=await import('../src/core/loop.js');
const {createRuntime}=await import('../src/core/runtime.js');

const jobs=[
{id:'QA-IT-300',title:'Local IT Technician'},
{id:'QA-SOC-300',title:'Junior SOC Analyst'},
{id:'QA-CLOUD-300',title:'Cloud Technician'}
];
const source='fixture-job-data.json', output='requested-shortlist.md';
const goal='Read fixture-job-data.json with fs.read. Create requested-shortlist.md with all THREE job IDs, job titles and one reason for each. These are synthetic test jobs.';
const valid=jobs.map((job,i)=>job.id+' | '+job.title+' | reason '+(i+1)).join('\n');

test('source JSON and one Markdown target pin a hallucinated outside fs.write path',()=>{
  fs.writeFileSync(path.join(ws,source),JSON.stringify(jobs));
  const wrong=path.join(home,'wrong-output',output);
  const result=pinJobShortlistWrite(goal,ws,'fs.write',{path:wrong,content:valid});
  assert.equal(result?.corrected,true);
  assert.equal(result?.originalPath,wrong);
  assert.equal(result?.requestedPath,output);
  assert.equal(result?.args.path,output);
  assert.equal(result?.args.content,valid);
  assert.equal(pinJobShortlistWrite(goal,ws,'fs.read',{path:wrong}),null);
  assert.equal(pinJobShortlistWrite(goal,ws,'fs.write',{path:output,content:valid}),null);
  assert.equal(pinJobShortlistWrite('Create first.md and second.md with all job IDs from one.json',ws,'fs.write',{path:wrong}),null);
});

test('production agent loop physically writes correct source-linked result, never model invented path',async()=>{
  fs.writeFileSync(path.join(ws,source),JSON.stringify(jobs));
  fs.rmSync(path.join(ws,output),{force:true});
  const wrong=path.join(home,'wrong-output',output);
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize'].map(k=>[k,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'}}).ok,true);
  const events=[];
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:5,
    ctx:{session:'qa-job-target',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    messages:[{role:'system',content:'Use tools.'},{role:'user',content:goal}],
    onEvent:e=>events.push(e),
    modelCall:async({step})=>step===1?
      {text:'',usage:{input:1,output:1},toolCalls:[{id:'w1',name:'fs.write',argsJson:JSON.stringify({path:wrong,content:valid})}]}:
      {text:'Done',toolCalls:[],usage:{input:1,output:1}},
  });
  assert.equal(result.incomplete,undefined,JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(ws,output),'utf8'),valid);
  assert.equal(fs.existsSync(wrong),false,'wrong path must not receive user data');
  assert.equal(verifyJobIdLineage(goal,ws).ok,true);
  assert.ok(events.some(e=>e.type==='artifact_path_corrected'&&e.requestedPath===output));
  await rt.shutdown();
});
