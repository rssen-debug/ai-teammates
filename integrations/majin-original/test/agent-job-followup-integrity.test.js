import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-job-followup-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const { verifyFollowupJobSelection }=await import('../src/core/mission-data-evidence.js');
const { createRuntime }=await import('../src/core/runtime.js');
const { loop }=await import('../src/core/loop.js');
const jobs=[{id:'QA-IT-ABC',title:'Local IT Technician'},{id:'QA-SOC-ABC',title:'Junior SOC Analyst'},{id:'QA-CLOUD-ABC',title:'Cloud Technician'}];
const sourceName='jobs-case-abc.json';
const outputName='selected-case-abc.txt';
const previous='Read '+sourceName+' with fs.read and save the three real job IDs to shortlist-case-abc.md.';
const goal='Continue the SAME job shortlist from earlier in this conversation. Take the SECOND job and create '+outputName+' containing its exact job ID. Do not ask which jobs.';
function fixture() {
  fs.writeFileSync(path.join(workspace,sourceName),JSON.stringify(jobs));
  fs.rmSync(path.join(workspace,outputName),{force:true});
}
const conversation=()=>[{role:'system',content:'Use actual tools.'},{role:'user',content:previous},{role:'assistant',content:'Found three jobs.'},{role:'user',content:goal}];

test('literal job2 is NOT the actual second job ID',()=>{
  fixture();
  fs.writeFileSync(path.join(workspace,outputName),'job2');
  const verdict=verifyFollowupJobSelection(goal,conversation(),workspace);
  assert.equal(verdict.ok,false);
  assert.match(verdict.missing.join(' '),/QA-SOC-ABC/);
});

test('true second job ID survives a follow-up',()=>{
  fixture();
  fs.writeFileSync(path.join(workspace,outputName),'QA-SOC-ABC');
  assert.equal(verifyFollowupJobSelection(goal,conversation(),workspace).ok,true);
});

test('unknown previous source and unrelated goals do not invent evidence',()=>{
  assert.equal(verifyFollowupJobSelection(goal,[{role:'user',content:goal}],workspace),null);
  assert.equal(verifyFollowupJobSelection('How do I find a job?',conversation(),workspace),null);
});

async function scenario(repair) {
  fixture();
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize'].map(x=>[x,'demo/demo-fast']));
  const patched=rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:8}});
  assert.equal(patched.ok,true,JSON.stringify(patched.errors));
  let writes=0;
  const events=[];
  const out=await loop({
    cfg:rt.cfg,registry:rt.registry,label:'main',job:'tasks',maxSteps:8,
    ctx:{session:'qa-job-followup-'+repair,enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    messages:conversation(),onEvent:e=>events.push(e),
    modelCall:async({step})=>{
      if(step===1||(repair&&step===3)){
        writes++;
        const content=step===3?'QA-SOC-ABC':'job2';
        return {text:'',toolCalls:[{id:'w'+step,name:'fs.write',argsJson:JSON.stringify({path:outputName,content})}],usage:{input:1,output:1}};
      }
      return {text:'Done, saved the second job ID',toolCalls:[],usage:{input:1,output:1}};
    }
  });
  await rt.shutdown();
  return {out,writes,events};
}

test('top-level agent corrects job2 and refuses to say done before independent confirmation',async()=>{
  const {out,events,writes}=await scenario(true);
  assert.equal(writes,2);
  assert.equal(out.incomplete,undefined,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(workspace,outputName),'utf8'),'QA-SOC-ABC');
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===true));
});

test('after bounded retries, wrong job2 produces honest INCOMPLETE not PASS',async()=>{
  const {out,events,writes}=await scenario(false);
  assert.equal(writes,1);
  assert.equal(out.incomplete,true);
  assert.equal(out.stopReason,'artifact_contract_failed');
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===false));
});
