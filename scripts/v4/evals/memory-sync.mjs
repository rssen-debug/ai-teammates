// Real Go acceptance in a disposable host/data directory on Ghost.
// The ordinary host is read only; this does not prove its prepared code active.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const snapshot=dir=>JSON.stringify(fs.readdirSync(dir).sort().map(n=>[n,hash(fs.readFileSync(path.join(dir,n)))]));

export async function evaluateMemorySync({ownerHome,ownerBase,runRoot,output,onEvent=()=>{}}){
  if(fs.existsSync(runRoot)||fs.existsSync(output))throw Error('Use new evaluation and evidence paths');
  const rel=path.relative(path.resolve(ownerHome),path.resolve(runRoot));
  if(!rel||(!rel.startsWith('..')&&!path.isAbsolute(rel)))throw Error('Evaluation must not run inside the owner data directory');
  // Set isolation before dynamically loading modules that resolve core paths.
  process.env.MAJIN_HOME=path.resolve(runRoot,'home');
  process.env.MAJIN_CONFIG=path.resolve(ownerHome,'config.json');
  process.env.MAJIN_V4_HOST_TOOLS='0';process.env.MAJIN_V4_PUBLIC_ORIGIN='';
  const [{loadConfig,routeFromV1Config},{startV4Server},{resolveRouteForModel},{existingLocalOwnerCookie},{evaluationClient},{MemoryStore}]=await Promise.all([
    import('../../../src/v4/config.js'),import('../../../src/v4/server.js'),import('../../../src/v4/models.js'),
    import('./local-owner.mjs'),import('./live-client.mjs'),import('../../../src/v2/memory/store.js'),
  ]);
  const ownerCookie=existingLocalOwnerCookie({home:ownerHome,base:ownerBase});
  const observed=await fetch(new URL('/api/state',ownerBase),{headers:{cookie:ownerCookie},signal:AbortSignal.timeout(8000)});
  if(!observed.ok)throw Error('Ordinary host model could not be verified');
  const owner=(await observed.json()).model;
  if(owner.demo!==false||owner.provider!=='opencode-go')throw Error('Existing real OpenCode Go selection required');
  const base=routeFromV1Config({home:ownerHome});
  const route=resolveRouteForModel({home:ownerHome,modelId:`${owner.provider}/${owner.model}`,base});
  if(!route||route.providerName!=='opencode-go'||route.baseUrl!=='https://opencode.ai/inference/go/v1')throw Error('Existing Go route required; no fallback or provider change');
  const config=loadConfig({argv:[]});config.port=0;config.host='127.0.0.1';config.model=route;
  config.limits.maxModelRounds=8;config.limits.maxToolCallsPerTurn=12;
  const hosted=await startV4Server({config}),started=Date.now();
  try{
  const peerDir=path.join(config.workspaceDir,'peer-memory'),peer=new MemoryStore(peerDir);
  const local=hosted.context.tools.memory,canary=crypto.randomUUID();
  local.put('preference',{key:'eval-local',text:'Local preference: concise reports.',tags:['local'],importance:0.8,meta:{canary}});
  peer.put('project',{key:'eval-project',text:('Preserve full project metadata '+canary+' ').repeat(20),tags:['project'],importance:0.7,meta:{canary,origin:'synthetic acceptance fixture'}});
  peer.put('preference',{key:'eval-peer',text:'Peer preference: English reports. '+canary,tags:['peer'],importance:0.9});
  const expectedLocal=local.get('preference','eval-local'),expectedProject=peer.get('project','eval-project'),expectedPeer=peer.get('preference','eval-peer');
  const beforeSnapshot=[snapshot(local.dir),snapshot(peer.dir)];
  const {token}=hosted.context.sessions.create({ip:'controlled-evaluation',userAgent:'real-Go-memory-sync'});
  const cookie=`${config.auth.cookieName}=${encodeURIComponent(token)}`;
  const client=evaluationClient({base:hosted.url,cookie}),calls=new Map(),success=[];
  let result,failure=null,previewUnchanged=false,conversationId;
  try{
    result=await client.run({task:`Synchronize this host's canonical memory bidirectionally with the peer memory directory ${peerDir}. Use the available memory synchronization capability, perform a non-writing preview before actual synchronization, and then search canonical memory for the peer preference to verify it is available. Preserve the local preference, all project metadata and full text. Do not recreate facts one by one, change settings, run processes, send messages or notifications, or access unrelated files.`,
      approve:async pending=>pending.tool==='memory_sync'&&path.resolve(pending.input?.target||'')===peerDir&&[true,false,undefined].includes(pending.input?.dryRun),
      maxApprovals:4,
      onEvent:event=>{
        conversationId=event.data?.conversationId||conversationId;
        if(event.event==='tool_start')calls.set(event.data.id,{name:event.data.name,input:event.data.input});
        if(event.event==='tool_result'&&event.data.ok){const call=calls.get(event.data.id);if(call){success.push(call);if(call.name==='memory_sync'&&call.input.dryRun!==false)previewUnchanged=JSON.stringify(beforeSnapshot)===JSON.stringify([snapshot(local.dir),snapshot(peer.dir)]);}}
        onEvent(event);
      },
    });
  }catch(error){failure=String(error.message).replaceAll(route.apiKey,'[redacted]').slice(0,1500);}
  finally{
    if(conversationId&&result?.status!=='completed'){await client.stop(conversationId).catch(()=>{});await client.stop(conversationId,{rejectPending:true}).catch(()=>{});}
  }
  const after=(await client.get('/api/state')).model;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const checks={realGoUnchanged:after.demo===false&&after.provider===owner.provider&&after.model===owner.model,modelCompleted:result?.status==='completed',previewExecuted:success.some(c=>c.name==='memory_sync'&&c.input.dryRun!==false),previewUnchanged,actualSyncExecuted:success.some(c=>c.name==='memory_sync'&&c.input.dryRun===false),peerPreferenceImported:same(local.get('preference','eval-peer'),expectedPeer),projectMetadataAndFullTextPreserved:same(local.get('project','eval-project'),expectedProject),localPreferenceExported:same(peer.get('preference','eval-local'),expectedLocal),searchRetrievedPeer:success.some(c=>c.name==='memory_search'&&local.search('preference',c.input.query).some(e=>e.key==='eval-peer')),noFactRecreationOrOtherTool:success.every(c=>['memory_sync','memory_search','tools_search','tools_activate'].includes(c.name))};
  const files=['src/core/memory-sync.js','src/v2/memory/store.js','src/v4/tools/memory-sync.js','src/v4/tools.js','scripts/v4/evals/memory-sync.mjs'];
  let dirty=false;try{execFileSync('git',['diff','--quiet','--',...files],{cwd:sourceRoot});}catch{dirty=true;}
  const evidence={at:new Date().toISOString(),kind:'real-Go-canonical-memory-sync',passed:Object.values(checks).every(Boolean),checks,model:owner,modelAfter:after,status:result?.status||'failed',failure,conversationId,successfulTools:success.map(c=>c.name),approvals:result?.approvals||0,elapsedMs:Date.now()-started,evaluationCheckoutHead:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim(),evaluationCheckoutDirty:dirty,sourceHashes:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(sourceRoot,f)))])),scope:'Real Go and actual Ghost filesystem; isolated test host/data, not ordinary Ghost activation or physical device acceptance.',ordinaryGhostActivationProven:false,physicalDevicePass:false};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  return evidence;
  }finally{await new Promise(resolve=>{hosted.server.close(resolve);hosted.server.closeAllConnections();});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error('Missing '+name);return path.resolve(args[i+1]);};
  const evidence=await evaluateMemorySync({ownerHome:get('--owner-home'),ownerBase:'http://127.0.0.1:7373',runRoot:get('--run-root'),output:get('--out'),onEvent:e=>{if(e.event==='tool_start')process.stderr.write('tool '+e.data.name+'\n');}});
  console.log(JSON.stringify(evidence));if(!evidence.passed)process.exitCode=1;
}
