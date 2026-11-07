import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent.js';

test('agent plan persistence replaces journal atomically without stray temp files', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-journal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map([['demo',[{id:'first'}]]]);
 agent.bus={emit(){}};
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 assert.equal(agent.persistPlan('demo'),true);
 agent.plans.set('demo',[{id:'second'}]);
 assert.equal(agent.persistPlan('demo'),true);
 assert.equal(JSON.parse(fs.readFileSync(agent.planPath(),'utf8')).plan[0].id,'second');
 assert.deepEqual(fs.readdirSync(dir),['demo.plan.json']);
 assert.equal(agent.lastPlanPersistError,null);
});

test('agent refuses a plan journal belonging to another session', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-owner-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'session.plan.json');
 fs.writeFileSync(agent.planPath(),JSON.stringify({session:'other',plan:[{id:'foreign'}]}));
 assert.equal(agent.loadPlan('current'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses oversized plan journal before parsing', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-large-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'too-large.plan.json');
 fs.writeFileSync(agent.planPath(),'x'.repeat(1100000));
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses symlinked plan journals',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-link-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 const target=path.join(dir,'target.json');
 fs.writeFileSync(target,JSON.stringify({session:'demo',plan:[{id:'unsafe'}]}));
 try {fs.symlinkSync(target,agent.planPath());}
 catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('symlinks unavailable');return;}throw e;}
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses journals with excessive plan steps', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-steps-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 fs.writeFileSync(agent.planPath(),JSON.stringify({session:'demo',plan:Array.from({length:1001},(_,i)=>({id:i}))}));
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses malformed plan entries during restart', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-invalid-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 fs.writeFileSync(agent.planPath(),JSON.stringify({session:'demo',plan:[{id:'ok'},null,'invalid']}));
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses plan steps with excessive metadata keys', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-wide-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 const wide=Object.fromEntries(Array.from({length:101},(_,i)=>['k'+i,i]));
 fs.writeFileSync(agent.planPath(),JSON.stringify({session:'demo',plan:[wide]}));
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent refuses persisted plan steps with prototype pollution keys',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-proto-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 fs.writeFileSync(agent.planPath(),'{"session":"demo","plan":[{"__proto__":{"polluted":true},"id":"bad"}]}');
 assert.equal(agent.loadPlan('demo'),null);
 assert.equal(agent.plans.size,0);
});

test('agent rejects constructor and prototype keys from a saved plan',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-special-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);agent.plans=new Map();
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 for(const key of ['constructor','prototype']){
   fs.writeFileSync(agent.planPath(),JSON.stringify({session:'demo',plan:[{id:'a',[key]:{unsafe:true}}]}));
   assert.equal(agent.loadPlan('demo'),null);
 }
 assert.equal(agent.plans.size,0);
});

test('agent derives a distinct plan journal path from session history',()=>{
 const agent=Object.create(Agent.prototype);
 const file=agent.planPath('journal-path-test');
 assert.ok(file === null || file.endsWith('.plan.json'));
 assert.ok(file === null || !file.endsWith('.jsonl'));
});

test('oversized plan is rejected before overwriting an existing valid journal', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-plan-size-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agent=Object.create(Agent.prototype);
 agent.plans=new Map([['demo',[{id:'ok'}]]]);
 agent.bus={emit(){}};
 agent.planPath=()=>path.join(dir,'demo.plan.json');
 assert.equal(agent.persistPlan('demo'),true);
 const previous=fs.readFileSync(agent.planPath(),'utf8');
 agent.plans.set('demo',[{id:'oversized',note:'x'.repeat(1024*1024)}]);
 assert.equal(agent.persistPlan('demo'),false);
 assert.equal(agent.lastPlanPersistError.code,'EPLAN_TOO_LARGE');
 assert.equal(fs.readFileSync(agent.planPath(),'utf8'),previous);
 assert.equal(fs.readdirSync(dir).length,1);
});
