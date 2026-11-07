import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryBudget, recoveryHint, browserRecoveryPlan } from '../src/core/strategy-recovery.js';
import { loop } from '../src/core/loop.js';

test('strategy recovery emits actionable alternatives without claiming work happened',()=>{
  assert.match(recoveryHint('browser.click','selector not found'),/fresh screenshot/);
  assert.match(recoveryHint('fs.write','permission denied'),/Inspect the actual filesystem path/);
  assert.match(recoveryHint('exec.shell','not found'),/stderr/);
  assert.match(recoveryHint('tool.run','oops'),/read-only tool/);
  assert.match(recoveryHint('browser.click','oops'),/NOT executed again/);
});
test('one recovery only for a matching, actually failed action',()=>{
  const b=new RecoveryBudget(1),key='browser.click:{"x":1}';
  assert.equal(b.assess({tool:'browser.click',key,toolLog:[]}).recover,false);
  assert.equal(b.assess({tool:'browser.click',key,toolLog:[{tool:'browser.click',repeatKey:key,ok:true}]}).recover,false);
  assert.equal(b.assess({tool:'browser.click',key,toolLog:[{tool:'browser.click',repeatKey:key,ok:false,error:'blocked'}]}).recover,true);
  assert.equal(b.assess({tool:'browser.click',key,toolLog:[{tool:'browser.click',repeatKey:key,ok:false,error:'blocked'}]}).recover,false);
});
function cfg(){return {get:k=>({
  'models.routes':{tasks:'demo/echo'},
  'agent.maxRepeatCalls':3,
  'routing.escalateAfterErrors':99,
  'agent.maxSteps':10,
})[k],resolveModel:ref=>({ref:ref||'demo/echo',apiKey:'x',kind:'mock',provider:'demo',model:'echo'})};}
function registry(){return {list:()=>[],search:()=>[],schemas:()=>[],exec:async (name)=>{
  if(name==='browser.click')return {ok:false,ms:1,error:{code:'not_found',message:'button not found'}};
  return {ok:true,ms:1,result:'page state captured'};
}};}
test('failed repeat never executes a third time; one recovery chooses a different action',async()=>{
  const actions=[
    {id:'1',name:'browser.click',argsJson:'{"selector":"#missing"}'},
    {id:'2',name:'browser.click',argsJson:'{"selector":"#missing"}'},
    {id:'3',name:'browser.click',argsJson:'{"selector":"#missing"}'},
    {id:'4',name:'browser.read',argsJson:'{}'},
  ];
  let i=0,clicks=0;
  const reg=registry();
  const orig=reg.exec;
  reg.exec=async (...args)=>{if(args[0]==='browser.click')clicks++;return orig(...args);};
  const events=[];
  const out=await loop({cfg:cfg(),registry:reg,messages:[],job:'tasks',onEvent:x=>events.push(x),
    modelCall:async()=>i<actions.length?{text:'',toolCalls:[actions[i++]],usage:{input:1,output:1},elapsedMs:1}:{text:'Done after observation',toolCalls:[],usage:{input:1,output:1},elapsedMs:1}});
  assert.equal(clicks,2,'repeated failed click never executed a third time');
  assert.notEqual(out.stopReason,'repeat_block');
  assert.ok(events.some(x=>x.type==='agent_recovery'));
  assert.ok(out.toolLog.some(x=>x.tool==='browser.read'&&x.ok));
});
test('second identical call after recovery is hard-blocked without execution',async()=>{
  let i=0,clicks=0;
  const calls=Array.from({length:4},(_,idx)=>({id:String(idx+1),name:'browser.click',argsJson:'{"selector":"#missing"}'}));
  const reg=registry();const orig=reg.exec;
  reg.exec=async (...args)=>{if(args[0]==='browser.click')clicks++;return orig(...args);};
  const out=await loop({cfg:cfg(),registry:reg,messages:[],job:'tasks',
    modelCall:async()=>i<calls.length?{text:'',toolCalls:[calls[i++]],usage:{input:1,output:1},elapsedMs:1}:{text:'final',toolCalls:[],usage:{input:1,output:1},elapsedMs:1}});
  assert.equal(clicks,2);
  assert.equal(out.stopReason,'repeat_block');
  assert.equal(out.toolLog.length,4);
});

test('recovery guidance uses observed accessibility state, not repeat clicks',()=>{
  assert.match(browserRecoveryPlan('ref_stale: detached node'),/NEW browser\.elements ref/);
  assert.match(browserRecoveryPlan('selector not found'),/not guessed nth-child/);
  assert.match(browserRecoveryPlan('navigation timeout'),/current URL/);
  assert.match(browserRecoveryPlan('403 forbidden'),/Do not bypass CAPTCHA/);
  assert.match(browserRecoveryPlan('click intercepted by overlay'),/modal, overlay/);
  assert.match(recoveryHint('browser.click','ref_stale'),/discard the old reference/);
  assert.doesNotMatch(browserRecoveryPlan('403 forbidden'),/try another account|disable security/i);
});
