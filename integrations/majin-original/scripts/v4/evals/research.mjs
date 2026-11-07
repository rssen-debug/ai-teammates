// Live Go research: model selects/reads sources; independent checks retain facts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluationClient} from './live-client.mjs';
import {existingLocalOwnerCookie} from './local-owner.mjs';

export async function runResearchEvaluation({base,cookie,workspace,output,sourceDirectory,reviewFeedback='',onEvent=()=>{}}){
  if(fs.existsSync(output))throw Error('Use a new evidence filename');
  const client=evaluationClient({base,cookie}),before=(await client.get('/api/state')).model;
  const catalogue=await client.get('/api/models');
  if(before.demo!==false||catalogue.models.find(m=>m.id===catalogue.current)?.offering!=='opencode-go')throw Error('Existing real Go provider required');
  workspace=fs.realpathSync(workspace);
  const fileName=`genesis-research-${crypto.randomBytes(5).toString('hex')}.md`,calls=new Map(),reads=[];
  let result,failure=null,conversationId;const started=Date.now();
  try{
    result=await client.run({task:`Research the difference between message retention in RFC 8030 and content encryption in RFC 8291. Use the real web tools to locate and read the relevant primary RFC text on rfc-editor.org. Explain what each mechanism guarantees, what it does not guarantee, and how they relate to an offline mobile device. Include the actual source URLs and section numbers. Do not infer that a server's accepted push proves that a physical phone received it. Save a concise source-backed comparison in workspace file ${fileName} and read it back. Do not send notifications, run code, change settings or access unrelated files.${reviewFeedback?'\nIndependent review of a prior attempt follows. Check its claims against the primary documents and address supported corrections in your new report:\n'+String(reviewFeedback).slice(0,6000):''}`,
      onEvent:e=>{conversationId=e.data?.conversationId||conversationId;if(e.event==='tool_start')calls.set(e.data.id,{name:e.data.name,input:e.data.input});if(e.event==='tool_result'&&e.data.ok){const call=calls.get(e.data.id);if(call?.name==='web_fetch'&&typeof call.input?.url==='string')reads.push(call.input.url);}onEvent(e);},
      approve:async pending=>{
        const p=pending.input||{};
        if(pending.tool==='workspace_write')return p.fileName===fileName;
        if(['fs_write','fs_patch'].includes(pending.tool))return path.resolve(workspace,String(p.path||''))===path.join(workspace,fileName);
        return false;
      }
    });
  }catch(error){failure=error.message;}
  finally{if(conversationId&&result?.status!=='completed'){await client.stop(conversationId).catch(()=>{});await client.stop(conversationId,{rejectPending:true}).catch(()=>{});}}
  let artifact='';try{artifact=fs.readFileSync(path.join(workspace,fileName),'utf8');}catch{}
  const sources=[];
  for(const url of [...new Set(reads)]){
    let target;try{target=new URL(url);}catch{continue;}
    if(target.protocol!=='https:'||!['rfc-editor.org','www.rfc-editor.org'].includes(target.hostname)||!/^\/rfc\/rfc(8030|8291)(\.(txt|html))?$/.test(target.pathname))continue;
    try{
      const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(10000)});
      const text=await response.text();if(!response.ok||text.length>2000000)continue;
      sources.push({url,sha256:crypto.createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),rfc:target.pathname.includes('8030')?8030:8291,mentionsRetention:/time.to.live|TTL/i.test(text),mentionsEncryption:/encrypt|confidential/i.test(text)});
    }catch{}
  }
  const after=(await client.get('/api/state')).model;
  const checks={realGoUnchanged:before.provider===after.provider&&before.model===after.model&&after.demo===false,modelCompleted:result?.status==='completed',bothPrimarySourcesRead:[8030,8291].every(rfc=>sources.some(s=>s.rfc===rfc)),citationsInArtifact:sources.length>=2&&sources.every(s=>artifact.includes(s.url)),retentionAndEncryptionDiscussed:/TTL|time.to.live|retention/i.test(artifact)&&/encrypt|confidential/i.test(artifact),physicalDeliveryNotAssumed:/not guarantee|does not|doesn't|no guarantee|cannot prove|not proof|does not prove/i.test(artifact),readBack:result?.events.some(e=>e.event==='tool_result'&&e.data.ok&&['workspace_read','fs_read'].includes(e.data.name))===true};
  const evidence={at:new Date().toISOString(),kind:'real-Go-primary-source-research',passed:Object.values(checks).every(Boolean),checks,evaluationCheckoutCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceDirectory,encoding:'utf8'}).trim(),runtimeCommitVerified:false,model:before,modelAfter:after,conversationId,artifact:{fileName,sha256:crypto.createHash('sha256').update(artifact).digest('hex'),content:artifact},sources,failure,status:result?.status||'failed',elapsedMs:Date.now()-started,physicalDevicePass:false,note:'Scoped standards comparison with actual source reads; factual review and all other real-world gates remain separate.'};
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});return evidence;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Missing ${name}`);return args[i+1];};
  const base=get('--host'),cookie=existingLocalOwnerCookie({base,home:get('--local-owner-home')});
  const e=await runResearchEvaluation({base,cookie,workspace:get('--workspace'),output:get('--out'),sourceDirectory:get('--source-dir'),reviewFeedback:args.includes('--review')?fs.readFileSync(get('--review'),'utf8'):'',onEvent:e=>{if(e.event==='tool_start')process.stderr.write(`tool ${e.data.name}\n`);}});
  console.log(JSON.stringify(e));if(!e.passed)process.exitCode=1;
}
