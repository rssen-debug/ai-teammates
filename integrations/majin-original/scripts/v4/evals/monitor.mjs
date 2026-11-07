// Opt-in real Go task creation + actual scheduled public-source observation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseWhen} from '../../../src/core/schedule.js';
import {evaluationClient} from './live-client.mjs';
import {existingLocalOwnerCookie} from './local-owner.mjs';

export async function runMonitorEvaluation({base,cookie,output,sourceDirectory,resumeFrom=null,onEvent=()=>{}}){
  if(fs.existsSync(output))throw Error('Use a new evidence path');
  const client=evaluationClient({base,cookie}),before=(await client.get('/api/state')).model;
  const catalogue=await client.get('/api/models');
  if(before.demo!==false||catalogue.models.find(m=>m.id===catalogue.current)?.offering!=='opencode-go')throw Error('Existing real Go provider required');
  const prior=resumeFrom?JSON.parse(fs.readFileSync(resumeFrom,'utf8')):null;
  const name=prior?.taskName||`Genesis node metadata ${crypto.randomBytes(4).toString('hex')}`;
  const source='https://api.github.com/repos/nodejs/node';
  const approvals=[],denied=[];let result,failure=null,conversationId;
  const started=Date.now();
  if(!prior){
    try{result=await client.run({
      task:`Create a persistent monitoring task named "${name}". Check the public Node.js GitHub repository metadata at ${source} once per minute. Alert when its open issue count is greater than zero; do not repeat alerts while that condition stays true. Use deterministic source checks without asking the language model on every poll. Authorize at most THREE checks total, then stop. Enable notification delivery to devices I have explicitly subscribed. This is a real authorized public-source acceptance test; do not subscribe a device, change settings or contact other destinations. Create the task using the discovered durable task capability, then list it and report the actual task id.`,
      onEvent:e=>{conversationId=e.data?.conversationId||conversationId;onEvent(e);},
      approve:async pending=>{
        const p=pending.input||{};let safe=false;
        if(pending.tool==='task_manage'&&p.action==='create'){
          try{const spec=parseWhen(p.when),minute=(spec.kind==='every'&&spec.everyMs===60000)||(spec.kind==='cron'&&['* * * * *','*/1 * * * *'].includes(spec.spec));safe=p.name===name&&minute&&Number.isInteger(p.maxRuns)&&p.maxRuns>0&&p.maxRuns<=3&&p.notify===true&&p.condition?.url===source&&p.condition.pointer==='/open_issues_count'&&p.condition.operator==='gt'&&p.condition.value===0;}catch{}
          if(!safe)process.stderr.write(JSON.stringify({scopeRejected:{name:p.name,when:p.when,maxRuns:p.maxRuns,notify:p.notify,condition:p.condition}})+'\n');
        }
        (safe?approvals:denied).push(pending.tool);return safe;
      }
    });}catch(error){failure=error.message;}
  }
  let task=(await client.get('/api/tasks')).tasks.find(t=>t.name===name);
  const originalRuns=prior?.runCount||0,deadline=Date.now()+100000;
  while(task && (task.runCount||0)<=originalRuns && Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));task=(await client.get('/api/tasks')).tasks.find(t=>t.id===task.id);}
  while(task?.running && Date.now()<deadline){await new Promise(r=>setTimeout(r,250));task=(await client.get('/api/tasks')).tasks.find(t=>t.id===task.id);}
  const push=await client.get('/api/push'),observed=task?.metadata?.observation;
  const notices=push.history.filter(h=>h.id.startsWith(`condition:${task?.id}:`));
  const after=(await client.get('/api/state')).model;
  const checks={realGoUnchanged:before.provider===after.provider&&before.model===after.model&&after.demo===false,naturalLanguageCreation:prior?prior.checks.naturalLanguageCreation:result?.status==='completed'&&Boolean(task),scheduledDispatch:Boolean(task)&&(task.runCount||0)>originalRuns,verifiedExternalJson:typeof observed?.actual==='number'&&observed.actual>0&&observed.matched===true&&task?.metadata.condition.url===source,durableAlert:notices.length===1,runBudget:task?.maxRuns===3,reloadPreserved:prior?task?.id===prior.taskId&&task.metadata?.conversationId===prior.conversationId:true};
  const evidence={at:new Date().toISOString(),kind:prior?'real-monitor-after-host-restart':'real-Go-natural-language-monitor',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceDirectory,encoding:'utf8'}).trim(),passed:Object.values(checks).every(Boolean),checks,taskName:name,taskId:task?.id||null,conversationId:task?.metadata?.conversationId||null,creationConversationId:conversationId||null,runCount:task?.runCount||0,lastStatus:task?.lastStatus||null,observation:observed||null,history:task?.history||[],notificationHistory:notices,subscribedDeviceCount:push.devices,physicalPhoneReceipt:false,model:before,modelAfter:after,approvals,denied,failure,elapsedMs:Date.now()-started,note:'Real public GitHub repository metadata, not a synthetic price or physical iPhone acceptance. Host restart must also be evidenced by the operator process receipt.'};
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});return evidence;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Missing ${name}`);return args[i+1];};
  const base=get('--host'),cookie=existingLocalOwnerCookie({base,home:get('--local-owner-home')});
  const e=await runMonitorEvaluation({base,cookie,output:get('--out'),sourceDirectory:get('--source-dir'),resumeFrom:args.includes('--resume-from')?get('--resume-from'):null,onEvent:e=>{if(e.event==='tool_start')process.stderr.write(`tool ${e.data.name}\n`);}});
  console.log(JSON.stringify(e));if(!e.passed)process.exitCode=1;
}
