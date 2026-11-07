import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-job-id-evidence-'));
process.env.MAJIN_HOME=home;
const { verifyJobIdLineage }=await import('../src/core/mission-data-evidence.js');
const { runMission }=await import('../src/core/mission.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { setScript }=await import('../src/core/provider/mock.js');

const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const jobs=[
  {id:'QA-IT-418',title:'Local IT Technician'},
  {id:'QA-SOC-418',title:'Junior SOC Analyst'},
  {id:'QA-CLOUD-418',title:'Cloud Technician'},
];
const goal='Read qa-job-source.json with fs.read. Create qa-job-shortlist.md with all THREE job IDs, job titles and one reason for each. These are synthetic test jobs.';
const saveSource=()=>fs.writeFileSync(path.join(ws,'qa-job-source.json'),JSON.stringify(jobs));
const bad='job_ids:\njob1: Job1\njob2: Job2\njob3: Job3\nreasons:\njob1: Reason1\n';
const valid=jobs.map((j,i)=>j.id+' — '+j.title+' — reason '+(i+1)).join('\n');

test('the actual misreported Qwen placeholders are NOT accepted as verified job IDs',()=>{
  saveSource();
  fs.writeFileSync(path.join(ws,'qa-job-shortlist.md'),bad);
  const result=verifyJobIdLineage(goal,ws);
  assert.equal(result.ok,false);
  assert.equal(result.missing.length,3);
  assert.equal(result.missingTitles.length,3);
});

test('real source identifiers and original job titles pass independent data validation',()=>{
  saveSource();
  fs.writeFileSync(path.join(ws,'qa-job-shortlist.md'),valid);
  const result=verifyJobIdLineage(goal,ws);
  assert.equal(result.ok,true);
  assert.equal(result.count,3);
});

test('ambiguous sources and other ordinary mission goals do not invent source-ID assertions',()=>{
  assert.equal(verifyJobIdLineage('Write an HTML landing page',ws),null);
  assert.equal(verifyJobIdLineage('Compare one.json and two.json and save all job IDs to list.md',ws),null);
  assert.equal(verifyJobIdLineage('Get all job IDs from /tmp/secret.json into output.md',ws),null);
});

async function missionRepair(shouldFix) {
  saveSource();
  fs.rmSync(path.join(ws,'qa-job-shortlist.md'),{force:true});
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(x=>[x,'demo/demo-fast']));
  const p=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},
    guard:{mode:'off'},mission:{limits:{repairRounds:1,replanRounds:0}}});
  assert.equal(p.ok,true,JSON.stringify(p.errors));
  const dag={nodes:[
    {id:'read_json',input:'Read qa-job-source.json and identify the records',deps:[],estMs:1000},
    {id:'create_md',input:'Create qa-job-shortlist.md with all three job IDs and job titles',deps:['read_json'],estMs:1000}
  ]};
  setScript('mission:compile',[{text:JSON.stringify(dag)}]);
  let writes=0;
  const events=[];
  const result=await runMission({
    cfg:rt.cfg,registry:rt.registry,session:'qa-job-lineage-'+shouldFix,input:goal,checkpoints:false,emit:e=>events.push(e),
    workerOverride:async(node)=>{
      if(node.id==='create_md'){
        writes++;
        const repaired=String(node.input).includes('SOURCE DATA VERIFICATION FAILED');
        fs.writeFileSync(path.join(ws,'qa-job-shortlist.md'),repaired&&shouldFix?valid:bad);
      }
      return {text:node.id+' worker claims completed',usage:{input:1,output:1}};
    }
  });
  await rt.shutdown();
  return {result,events,writes};
}

test('mission repairs placeholders using REAL source JSON and verifies output again',async()=>{
  const {result,events,writes}=await missionRepair(true);
  assert.equal(result.kind,'mission');
  assert.equal(result.failCount,0,JSON.stringify(result.textSummary));
  assert.equal(result.okCount,2);
  assert.equal(result.sourceIntegrity.ok,true);
  assert.equal(writes,2,'boundedly corrected once, not an infinite loop');
  assert.ok(events.some(e=>e.type==='mission_source_integrity_repaired'));
  assert.equal(verifyJobIdLineage(goal,ws).ok,true);
});

test('mission MUST be incomplete after placeholder writes despite nominal file_exists success',async()=>{
  const {result,events,writes}=await missionRepair(false);
  assert.equal(result.kind,'mission');
  assert.ok(result.failCount>0);
  assert.ok(result.okCount<result.nodes);
  assert.equal(result.sourceIntegrity.ok,false);
  assert.ok(writes<=2,'bounded correction');
  assert.ok(events.some(e=>e.type==='mission_source_integrity_failed'));
  assert.match(result.textSummary.join('\n'),/source-data verification failed/);
});
