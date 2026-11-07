// Live acceptance: real Go creates and tests a previously unspecified CLI.
// The harness supplies requirements and independently checks resulting bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {evaluationClient} from './live-client.mjs';
import {existingLocalOwnerCookie} from './local-owner.mjs';

export async function runSoftwareEvaluation({base,cookie,workspace,output,sourceDirectory,repairFrom=null,onEvent=()=>{}}){
  if(fs.existsSync(output))throw Error('Use a new evidence path; previous outcomes are immutable');
  workspace=fs.realpathSync(workspace);
  const client=evaluationClient({base,cookie});
  const before=(await client.get('/api/state')).model;
  const catalogue=await client.get('/api/models');
  if(before.demo!==false || catalogue.models.find(m=>m.id===catalogue.current)?.offering!=='opencode-go')throw Error('Requires existing real Go route');
  const suffix=crypto.randomBytes(5).toString('hex');
  const prior=repairFrom?JSON.parse(fs.readFileSync(repairFrom,'utf8')):null;
  if(prior && (!/^genesis-expenses-[a-f0-9]{10}\.mjs$/.test(prior.artifacts?.app)||!/^genesis-expenses-[a-f0-9]{10}\.test\.mjs$/.test(prior.artifacts?.tests)))throw Error('Invalid prior evaluation artifact names');
  const app=prior?.artifacts.app||`genesis-expenses-${suffix}.mjs`,tests=prior?.artifacts.tests||`genesis-expenses-${suffix}.test.mjs`;
  const allowedFiles=new Set([app,tests]);
  const approvals=[],denied=[],failures=[];let result,failure,conversationId;const started=Date.now();
  try{
    result=await client.run({
      ...(prior?{conversationId:prior.conversationId}:{}),
      // Feed back measured failures, never a prewritten implementation.
      task:(prior?`Continue repairing your expense CLI ${app} and tests ${tests}. Read both actual files and run the existing tests first. Independent checks observed: ${JSON.stringify(prior.observations.filter(o=>!o.pass))}. Your last generated-test run output was: ${String(prior.modelTestOutput||'').slice(-4500)}. Original contract remains: summarize(rows) returns {totalCents, byCategory}, with category totals nested under byCategory, including for empty input. The CLI reads a JSON array from stdin and prints exactly that summary. All valid string category names must work, including __proto__ and constructor. Reject missing categories and invalid/non-finite or over-precision amounts; sum integer cents exactly. Diagnose from the actual source and failures, preserve correct behavior, repair and add regression coverage. `:`Build a small functional dependency-free Node.js expense report CLI in workspace file ${app}, with tests in ${tests}. Export summarize(rows), where each row has category and amount. Return {totalCents, byCategory}, where byCategory maps category names to integer cent totals. Accept signed decimal amounts with at most two decimal places, reject missing categories and invalid/non-finite amounts, and avoid binary floating-point summation errors. Empty rows return zero and {}. The CLI must read a JSON array from stdin and write exactly the JSON summary to stdout; invalid input must exit nonzero. Use only Node built-ins. `)+`Create meaningful tests, run them with node --test ${tests}, inspect output, repair defects and rerun. Then read back the source and report how to run it. Discover and use the real file/process tools. All work must stay in these two workspace files and execution logs. No package installation, browser, networking, configuration changes or unrelated files. Commands authorized for this isolated task are exactly node --test ${tests} and node --check ${app}; use the workspace as cwd. Local exec_start and exec_wait or shell_run are authorized for those commands.`,
      onEvent:e=>{conversationId=e.data?.conversationId||conversationId;if(e.event==='tool_result'&&!e.data.ok)failures.push({name:e.data.name,error:e.data.error,summary:e.data.summary});onEvent(e);},
      approve:async pending=>{
        let safe=false;const input=pending.input||{};
        if(['fs_write','fs_patch'].includes(pending.tool))safe=allowedFiles.has(path.basename(String(input.path||'')))&&path.dirname(path.resolve(workspace,String(input.path)))===workspace;
        const commands=[`node --test ${tests}`,`node --check ${app}`];
        if(pending.tool==='shell_run'||pending.tool==='exec_start')safe=commands.includes(input.command)&&!input.env&&(!input.cwd||path.resolve(input.cwd)===workspace)&&(pending.tool!=='exec_start'||input.backend==='local');
        if(pending.tool==='exec_wait'&&/^ex-[a-zA-Z0-9-]+$/.test(input.id||'')){
          try{const meta=JSON.parse(fs.readFileSync(path.join(workspace,'exec',input.id,'meta.json'),'utf8'));safe=commands.includes(meta.command)&&meta.backend==='local'&&Date.parse(meta.startedAt)>=started;}catch{}
        }
        (safe?approvals:denied).push(pending.tool);return safe;
      }
    });
  }catch(error){failure=error.message;}
  finally{if(conversationId&&result?.status!=='completed'){await client.stop(conversationId).catch(()=>{});await client.stop(conversationId,{rejectPending:true}).catch(()=>{});}}
  const run=input=>spawnSync(process.execPath,[path.join(workspace,app)],{cwd:workspace,input:JSON.stringify(input),encoding:'utf8',timeout:5000,maxBuffer:100000,windowsHide:true});
  const observations=[];
  for(const [input,expected] of [
    [[{category:'food',amount:'0.10'},{category:'food',amount:'0.20'},{category:'travel',amount:'-1.25'}],{totalCents:-95,byCategory:{food:30,travel:-125}}],
    [[],{totalCents:0,byCategory:{}}],
    [[{category:'__proto__',amount:'1.01'},{category:'constructor',amount:'2.99'}],{totalCents:400,byCategory:{['__proto__']:101,constructor:299}}]
  ]){const r=run(input);let actual;try{actual=JSON.parse(r.stdout);}catch{}observations.push({exitCode:r.status,actual,expected,pass:r.status===0&&isDeepStrictEqual(actual,expected)});}
  for(const input of [[{category:'food',amount:'NaN'}],[{category:'',amount:'2'}],[{category:'food',amount:'1.001'}]]){const r=run(input);observations.push({invalidInput:true,exitCode:r.status,pass:r.status!==null&&r.status!==0});}
  const ownTests=spawnSync(process.execPath,['--test',path.join(workspace,tests)],{cwd:workspace,encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
  const after=await client.get('/api/state').then(s=>s.model).catch(()=>null);
  const actions=(result?.events||[]).filter(e=>e.event==='tool_result'&&e.data.ok).map(e=>e.data.name);
  const checks={modelCompleted:result?.status==='completed',realGoUnchanged:before.provider===after?.provider&&before.model===after?.model&&after?.demo===false,sourceExists:fs.existsSync(path.join(workspace,app)),modelExecutedTests:actions.includes('shell_run')||(actions.includes('exec_start')&&actions.includes('exec_wait')),modelReadBack:['fs_read','file_read','workspace_read'].some(name=>actions.includes(name)),independentCliCases:observations.every(o=>o.pass),independentModelTests:ownTests.status===0};
  const evidence={at:new Date().toISOString(),kind:'real-Go-software-creation',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceDirectory,encoding:'utf8'}).trim(),passed:Object.values(checks).every(Boolean),checks,model:before,modelAfter:after,elapsedMs:Date.now()-started,status:result?.status||'failed',failure:failure||null,conversationId,actions,failures,approvals,denied,artifacts:{app,tests},observations,modelTestExitCode:ownTests.status,modelTestOutput:(ownTests.stdout||'').slice(0,12000),physicalDevicePass:false};
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});return evidence;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Missing ${name}`);return args[i+1];};
  const base=get('--host'),cookie=existingLocalOwnerCookie({base,home:get('--local-owner-home')});
  const evidence=await runSoftwareEvaluation({base,cookie,workspace:get('--workspace'),output:get('--out'),sourceDirectory:get('--source-dir'),repairFrom:args.includes('--repair-from')?get('--repair-from'):null,onEvent:e=>{if(e.event==='tool_start')process.stderr.write(`tool ${e.data.name}\n`);}});
  console.log(JSON.stringify(evidence));if(!evidence.passed)process.exitCode=1;
}
