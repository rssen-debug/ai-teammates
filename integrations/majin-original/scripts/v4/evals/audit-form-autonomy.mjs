// Post-run evidence audit. Reads fixture receipts and actual disposable workspace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function auditFormAutonomy({repo,runRoot,attempt,output}){
 if(fs.existsSync(output))throw Error('Use a new audit output path');
 const root=fs.realpathSync(runRoot),workspace=path.join(root,'home/workspace');
 const telemetryDir=path.join(root,'home/v4/telemetry');
 const rows=fs.readdirSync(telemetryDir).filter(f=>f.endsWith('.jsonl')).flatMap(f=>fs.readFileSync(path.join(telemetryDir,f),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)));
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),results=[];
 for(const kind of ['A','B','C','regression']){
  const file=`docs/v4/evidence/form-autonomy-${kind}-attempt-${attempt}.json`,e=JSON.parse(fs.readFileSync(path.join(repo,file)));
  const receiptPath=path.resolve(workspace,e.artifacts.receiptName),uploadPath=path.resolve(workspace,e.artifacts.fileName);
  if(![receiptPath,uploadPath].every(f=>f.startsWith(workspace+path.sep)))throw Error('Unsafe artifact path');
  const uploaded=fs.readFileSync(uploadPath);let saved=null;try{saved=fs.readFileSync(receiptPath)}catch{}
  const accepted=e.proof.accepted;
  // Calls from the preceding task can be only milliseconds before this one.
  // No fuzzy timestamp margin: select this task's goal.start and ledger segment.
  const startIndex=rows.findIndex(r=>r.event==='goal.start'&&Date.parse(r.at)>=Date.parse(e.at)-e.elapsedMs&&Date.parse(r.at)<=Date.parse(e.at));
  let endIndex=startIndex+1;while(endIndex<rows.length&&rows[endIndex].event!=='goal.start')endIndex++;
  const calls=startIndex<0?[]:rows.slice(startIndex,endIndex).filter(r=>r.event==='model.call');
  const currentSourceMatches=Object.entries(e.sourceHashes).every(([f,h])=>sha(fs.readFileSync(path.join(repo,f)))===h);
  const independent={oneServerAcceptance:e.proof.submissions.filter(s=>s.accepted).length===1,exactReceivedBytes:accepted?.uploadSha256===sha(uploaded),
   actualSavedReceipt:Boolean(accepted&&saved?.includes(Buffer.from(accepted.receipt))),modelRoundAccounting:calls.length===e.modelRounds,
   genuineGo:calls.length>0&&calls.every(c=>c.provider==='opencode-go'),receiptChecks:e.passed&&Object.values(e.checks).every(Boolean)};
  results.push({kind,evidence:file,evidenceSha256:sha(fs.readFileSync(path.join(repo,file))),passed:Object.values(independent).every(Boolean),independent,
   sourceMatchesCurrent:currentSourceMatches,rounds:e.modelRounds,toolCalls:e.toolCalls,recoveryActions:e.recoveryActions||[],failures:e.toolFailures.length,
   tokenUsage:{input:calls.reduce((n,r)=>n+(r.usageInput||0),0),output:calls.reduce((n,r)=>n+(r.usageOutput||0),0),source:'Actual provider response telemetry; not a billing receipt'},
   currencyCost:null,receiptSha256:saved?sha(saved):null,uploadSha256:sha(uploaded)});
 }
 const audit={at:new Date().toISOString(),attempt,kind:'post-run-independent-artifact-and-telemetry-audit',newFormsPassed:results.slice(0,3).filter(r=>r.passed).length,
  originalRegressionPassed:results[3].passed,currentSourceMatches:results.every(r=>r.sourceMatchesCurrent),
  verdict:results.every(r=>r.passed&&r.sourceMatchesCurrent)?'FORM AUTONOMY PASS (three controlled fixtures plus original regression only)':'FORM AUTONOMY NOT READY',results,
  universalAutonomyProven:false,productionReleaseReady:false,ordinaryGhostActivationProven:false};
 fs.writeFileSync(output,JSON.stringify(audit,null,2)+'\n',{flag:'wx'});return audit;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [repo,runRoot,attempt,output]=process.argv.slice(2);console.log(JSON.stringify(auditFormAutonomy({repo:path.resolve(repo),runRoot:path.resolve(runRoot),attempt,output:path.resolve(output)})));
}
