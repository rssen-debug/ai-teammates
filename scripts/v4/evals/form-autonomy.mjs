// Real provider + actual browser + independent server receipts. No canned model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {evaluationClient} from './live-client.mjs';
import {startFormAutonomyFixture} from './form-autonomy-fixtures.mjs';
import {startControlledForm} from './controlled-form.mjs';
export async function evaluateFormAutonomy({base,cookie,workspace,output,sourceDirectory,kind,onEvent=()=>{}}){
 if(fs.existsSync(output))throw Error('Use a fresh receipt path; failed evidence must remain');
 const client=evaluationClient({base,cookie});const before=(await client.get('/api/state')).model;
 if(before.demo!==false||before.provider!=='opencode-go')throw Error('Existing genuine OpenCode Go route required');
 const nonce=crypto.randomBytes(6).toString('hex'),fileName=`form-${kind}-${nonce}.txt`,receiptName=`receipt-${kind}-${nonce}.txt`;
 const bytes=Buffer.from('Controlled exact upload '+crypto.randomUUID()+'\n');const uploadPath=path.join(workspace,fileName);fs.writeFileSync(uploadPath,bytes,{flag:'wx'});
 const fixture=kind==='regression'?await startControlledForm({uploadText:bytes.toString()}):await startFormAutonomyFixture({kind,uploadText:bytes.toString()});
 const task=kind==='regression'?`Register a Team at ${fixture.base}/. Group name ${fixture.expected.group}, contact email ${fixture.expected.email}, attendees 3, country Sweden; choose Late if a session is requested; agree to this isolated demo registration.`:fixture.task;
 const events=[],approved=[],denied=[];let result,failure=null,conversationId;
 const attempts=new Map();let stagnationStop=false;const start=Date.now();
 try{
  result=await client.run({task:task+` Attach the supporting file ${uploadPath}. Inspect the live UI and correct server validation errors. After server acceptance save the actual displayed receipt to workspace file ${receiptName}, then read it back. Browser interaction only, no direct HTTP submissions or scripts. Only this controlled loopback site is authorized. Do not access unrelated files, memory, credentials or configuration. Stop after confirmed success.`,maxApprovals:16,
   onEvent:e=>{events.push(e);conversationId=e.data?.conversationId||conversationId;if(e.event==='error')failure=String(e.data?.message||'Host error');onEvent(e);
    if(e.event==='tool_result'&&!e.data.ok){const start=events.findLast(x=>x.event==='tool_start'&&x.data.id===e.data.id);const key=JSON.stringify([e.data.name,start?.data.input,e.data.error]);const n=(attempts.get(key)||0)+1;attempts.set(key,n);if(n>=3&&!stagnationStop){stagnationStop=true;void client.stop(conversationId).catch(()=>{});}}
   },
   approve:async pending=>{conversationId=pending.conversationId;let safe=['browser_form_fill','browser_form_submit','browser_click','browser_fill','browser_upload','browser_close'].includes(pending.tool);
    if(pending.tool==='browser_open'){try{safe=new URL(pending.input.url).origin===fixture.base&&pending.input.headless!==false}catch{safe=false}}
    if(pending.tool==='browser_upload')safe=path.resolve(workspace,String(pending.input.path||'')).toLowerCase()===uploadPath.toLowerCase();
    if(safe)approved.push(pending.tool);else denied.push(pending.tool);return safe;},
  });
 }catch(e){failure=e.message}
 finally{if(conversationId&&result?.status!=='completed'){await client.stop(conversationId).catch(()=>{});await client.stop(conversationId,{rejectPending:true}).catch(()=>{})}await fixture.close()}
 const proof=fixture.proof(),accepted=proof.accepted;let saved='';try{saved=fs.readFileSync(path.join(workspace,receiptName),'utf8')}catch{}
 const after=(await client.get('/api/state')).model;
 const wanted=kind==='regression'?fixture.expected:Object.fromEntries(Object.entries(fixture.expected).filter(([k])=>kind==='A'||(kind==='B'?['name','email','consent']:['name','email','quantity','consent']).includes(k)));
 const actual=kind==='regression'?accepted:accepted?.values;
 const checks={realModelCompleted:result?.status==='completed',sameGenuineProvider:after.demo===false&&after.provider===before.provider&&after.model===before.model,
  exactlyOneAccepted:proof.submissions.filter(x=>x.accepted).length===1,allRequestedValues:Object.entries(wanted).every(([k,v])=>actual?.[k]===v),
  exactFileBytes:accepted?.uploadSha256===crypto.createHash('sha256').update(bytes).digest('hex'),savedVerifiedReceipt:Boolean(accepted)&&saved.includes(fixture.receipt),
  noDeniedAction:denied.length===0,validationRecovery:kind==='C'||kind==='regression'?proof.submissions.some(x=>!x.accepted)&&Boolean(accepted):true};
 const sourcePaths=['src/core/browser-form.js','src/core/tools/web.js','src/v4/agent.js','src/v4/tools/host.js','scripts/v4/evals/form-autonomy.mjs','scripts/v4/evals/form-autonomy-fixtures.mjs'];
 const evidence={at:new Date().toISOString(),kind,passed:Object.values(checks).every(Boolean),checks,failure,status:result?.status||'failed',elapsedMs:Date.now()-start,model:before,modelAfter:after,
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceDirectory,encoding:'utf8'}).trim(),dirtyCheckout:execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:sourceDirectory,encoding:'utf8'}).trim().length>0,
  sourceHashes:Object.fromEntries(sourcePaths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceDirectory,p))).digest('hex')])),
  modelRounds:Math.max(0,...events.filter(e=>e.event==='state'&&e.data.state==='thinking').map(e=>e.data.round||0)),
  toolCalls:events.filter(e=>e.event==='tool_result').length,uniqueToolRequests:new Set(events.filter(e=>e.event==='tool_start').map(e=>e.data.id)).size,
  approved,denied,stagnationStop,toolFailures:events.filter(e=>e.event==='tool_result'&&!e.data.ok),
  trace:events.filter(e=>['state','tool_start','tool_result','recovery','error'].includes(e.event)),proof,artifacts:{fileName,receiptName},
  recoveryActions:events.filter(e=>e.event==='tool_result'&&e.data.formProgress?.recoveries>0).map(e=>e.data.formProgress),
  ordinaryGhostActivationProven:false,isolatedTestHost:true,physicalAcceptance:false,cost:{currencyAmount:null,reason:'Provider billing not independently supplied; token telemetry must not be converted to an invented price'}};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});return evidence;
}
