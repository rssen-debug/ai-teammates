/**
 * Real, low-token multi-dialect OpenCode Go smoke.
 * Runs only in secret-backed GitHub CI, never on the owner's CPU.
 * No tools are executed: a synthetic qa_echo schema tests the provider's
 * ability to return valid tool-call arguments for MAJIN's agent loop.
 */
import { clone, DEFAULTS, Config } from '../../src/core/config.js';
import { routeFor } from '../../src/core/router.js';
import { complete } from '../../src/core/provider/chat.js';

const secret = String(process.env.OPENCODE_API_KEY || '');
if (!secret) throw new Error('Go live smoke requires OPENCODE_API_KEY GitHub secret');
const root='https://opencode.ai/zen/go/v1';
const cases=[
  {id:'glm-5.3-flash',kind:'openai'},
  {id:'qwen3.8-flash',kind:'anthropic'},
  {id:'grok-4.6',kind:'responses'},
];
const report={kind:'real_cloud_go', cases:[], summary:{PASS:0,BLOCKED:0,FAIL:0}};
const clean=e=>String(e?.message||e||'').replaceAll(secret,'[REDACTED]').slice(0,240);
let catalog=[];
try {
  const resp=await fetch(root+'/models',{headers:{authorization:'Bearer '+secret,'user-agent':'MAJIN-coding-agent/1.0'},signal:AbortSignal.timeout(15000)});
  if(!resp.ok) throw new Error('Go catalog HTTP '+resp.status);
  const json=await resp.json();
  catalog=(Array.isArray(json.data)?json.data:Array.isArray(json.models)?json.models:[])
    .map(x=>typeof x==='string'?x:String(x?.id||x?.name||''));
} catch(e){
  console.error('Live Go catalog unavailable: '+clean(e));
  process.exit(1);
}
for(const item of cases) {
  const row={model:item.id,protocol:item.kind,status:'FAIL',reason:''};
  if(!catalog.includes(item.id)) {
    row.status='BLOCKED';
    row.reason='model not listed for this Go account; no inference attempted';
  } else {
    try {
      const data=clone(DEFAULTS);
      data.providers.opencode.apiKey=secret;
      data.models.routes.chat='opencode/'+item.id;
      const route=routeFor(new Config(data),'chat',{session:'majin-live-go-'+process.env.GITHUB_RUN_ID+'-'+item.id});
      if(route.kind!==item.kind)throw new Error('MAJIN chose incorrect dialect: '+route.kind);
      if(!route.extraHeaders?.['x-opencode-session'])throw new Error('session header absent');
      const result=await complete({route,
        messages:[{role:'system',content:'You are a concise coding assistant.'},{role:'user',content:'Reply with exactly the word READY.'}],
        tools:[],stream:false,maxTokens:180,temperature:0,retries:0});
      if(!String(result.text||'').trim())throw new Error('No text returned by native '+item.kind+' adapter');
      row.status='PASS';
      row.reason='native '+item.kind+' returned nonempty assistant text';
      // Only GLM and Qwen are used for an extra cheap real tool-call probe.
      if(item.id==='qwen3.8-flash') {
        const proof=await complete({route,
          messages:[{role:'user',content:'Use the qa_echo tool with the exact text HELLO_MAJIN_GO. Do not respond in plain text.'}],
          tools:[{name:'qa_echo',description:'Echo exactly the supplied text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],
          stream:false,maxTokens:220,temperature:0,retries:0});
        if(!proof.toolCalls?.some(t=>t.name==='qa_echo')) throw new Error('native Qwen Messages call did not return qa_echo tool call');
        row.reason+='; real qa_echo tool call parsed';
      }
    } catch(e){
      const msg=clean(e);
      row.reason=msg;
      row.status=/FreeTierError|HTTP 402|HTTP 403|HTTP 429|401:|403:|402:|429:|model not available/i.test(msg)?'BLOCKED':'FAIL';
    }
  }
  report.cases.push(row);
  report.summary[row.status]++;
  console.log(row.model+' '+row.protocol+': '+row.status+' ('+row.reason+')');
}
console.log('MAJIN_GO_LIVE '+JSON.stringify(report));
if(report.summary.FAIL>0 || report.summary.BLOCKED>0) process.exitCode=1;
