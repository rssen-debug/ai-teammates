import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Scheduler,parseWhen,cronMatch,nextRun} from '../src/core/schedule.js';
const cfg={get:()=>false};
test('human English intervals and Monday resolve to the same existing schedule representation',()=>{
  for(const [input,ms] of [['every 1 minute',60000],['every 2 minutes',120000],['every 3 seconds',3000],['every 1 hour',3600000],['every 2 days',172800000]])assert.equal(parseWhen(input).everyMs,ms);
  assert.equal(parseWhen('10:00 mon').spec,'0 10 * * 1');
});
function scratch(){return fs.mkdtempSync(path.join(os.tmpdir(),'majin-core-schedule-'));}
function clean(home){const resolved=path.resolve(home);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'majin-core-schedule-'));fs.rmSync(resolved,{recursive:true,force:true});}

test('invalid cron steps and huge ranges cannot hang the scheduler process',()=>{
  const moduleUrl=new URL('../src/core/schedule.js',import.meta.url).href;
  const source=`import assert from 'node:assert/strict';import {cronMatch,parseWhen} from ${JSON.stringify(moduleUrl)};for(const spec of ['*/0 * * * *','0-59/0 * * * *','0-999999999999 * * * *','60 * * * *','5-2 * * * *']){assert.equal(cronMatch(spec,new Date()),false);assert.throws(()=>parseWhen(spec));}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{timeout:3000,encoding:'utf8'});
  assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,child.stderr);
});
test('cron start/step, calendar dates and intervals have bounded valid meanings',()=>{
  assert.equal(cronMatch('0/15 * * * *',new Date(2026,9,24,10,30)),true);
  assert.equal(cronMatch('0/15 * * * *',new Date(2026,9,24,10,7)),false);
  assert.equal(nextRun(parseWhen('every 2m'),1000),121000);
  assert.throws(()=>parseWhen('every 0m'));assert.throws(()=>parseWhen('every 999999999999999999d'));
  assert.throws(()=>parseWhen('2026-02-30 09:00'));assert.throws(()=>parseWhen('2026-10-24 25:00'));
  assert.equal(parseWhen('2028-02-29 09:00').kind,'at');
  assert.throws(()=>nextRun({kind:'at',at:NaN}));assert.throws(()=>nextRun({kind:'every',everyMs:0}));
});
test('custom scheduler store persists jobs and pause state without replacing another store',()=>{
  const home=scratch(), file=path.join(home,'v4','schedule.json'), other=path.join(home,'legacy.json');
  fs.writeFileSync(other,'retained legacy bytes');
  let scheduler;
  try {
    scheduler=new Scheduler(cfg,{file,now:()=>1000,runTask:async()=>({text:'controlled'})});
    const job=scheduler.add({when:'every 1m',task:'Controlled observation',readOnly:true});
    assert.equal(job.nextRun,61000);scheduler.setPaused(job.id,true);
    const reloaded=new Scheduler(cfg,{file,now:()=>2000,runTask:async()=>({text:'controlled'})});
    assert.equal(reloaded.list()[0].id,job.id);assert.equal(reloaded.list()[0].paused,true);
    assert.equal(fs.readFileSync(other,'utf8'),'retained legacy bytes');
    assert.equal(fs.readdirSync(path.dirname(file)).some(f=>f.includes('.tmp-')),false);
    if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o077,0);
    reloaded.stop();
  }finally{scheduler?.stop();clean(home);}
});
test('failed atomic store update reports failure and does not retain an unpersisted job',()=>{
  const home=scratch(), file=path.join(home,'schedule.json');let scheduler;
  try{
    scheduler=new Scheduler(cfg,{file,runTask:async()=>({text:'never'})});
    fs.mkdirSync(file); // An invalid destination deterministically refuses rename.
    assert.throws(()=>scheduler.add({when:'every 1m',task:'Must not be reported as saved'}));
    assert.equal(scheduler.list().length,0);assert.equal(fs.statSync(file).isDirectory(),true);
    assert.equal(fs.readdirSync(home).some(f=>f.includes('.tmp-')),false);
  }finally{scheduler?.stop();clean(home);}
});
test('a corrupt or unsafe persisted schedule fails closed and retains the source bytes',()=>{
  const home=scratch(), file=path.join(home,'schedule.json');
  try{
    for(const raw of ['{broken','{}',JSON.stringify([{id:'j-1',spec:{kind:'cron',spec:'*/0 * * * *'}}]),JSON.stringify([{id:'j-1',spec:{kind:'every',everyMs:1000},nextRun:'invalid'}])]){
      fs.writeFileSync(file,raw);assert.throws(()=>new Scheduler(cfg,{file,runTask:async()=>({text:'never'})}),/Cannot load schedule store/);
      assert.equal(fs.readFileSync(file,'utf8'),raw);
    }
  }finally{clean(home);}
});
test('manual and timer attempts cannot dispatch the same running job twice',async()=>{
  const home=scratch(),file=path.join(home,'schedule.json');let release,started;
  const began=new Promise(r=>{started=r;});let calls=0;
  const scheduler=new Scheduler(cfg,{file,runTask:async()=>{calls++;started();await new Promise(r=>{release=r;});return {text:'Verified controlled result'};}});
  try{
    const job=scheduler.add({when:'every 1m',task:'Controlled no-op'});
    const first=scheduler.runNow(job.id);await began;
    assert.equal((await scheduler.runNow(job.id)).code,'already_running');assert.equal(calls,1);
    release();await first;
    assert.equal(scheduler.running.size,0);assert.equal(scheduler.list()[0].lastStatus,'ok');
  }finally{scheduler.stop();clean(home);}
});

test('a failed start checkpoint prevents task dispatch',async()=>{
  const home=scratch(),file=path.join(home,'schedule.json');let calls=0;
  const scheduler=new Scheduler(cfg,{file,runTask:async()=>{calls++;return {text:'never'};}});
  try{
    const job=scheduler.add({when:'every 1m',task:'Controlled no-op'});
    fs.unlinkSync(file);fs.mkdirSync(file);
    await assert.rejects(scheduler.runNow(job.id));assert.equal(calls,0);assert.equal(scheduler.running.size,0);
  }finally{scheduler.stop();clean(home);}
});
test('a process crash leaves a durable run checkpoint and does not silently replay mutating work',()=>{
  const home=scratch(), file=path.join(home,'schedule.json');
  const moduleUrl=new URL('../src/core/schedule.js',import.meta.url).href;
  const source=`import {Scheduler} from ${JSON.stringify(moduleUrl)};const scheduler=new Scheduler({get:()=>false},{file:${JSON.stringify(file)},runTask:async()=>process.exit(0)});const job=scheduler.add({when:'every 1m',task:'Controlled crash checkpoint',readOnly:false});await scheduler.runNow(job.id);`;
  try{
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{timeout:3000,encoding:'utf8',env:{...process.env,MAJIN_HOME:home}});
    assert.equal(child.status,0,child.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file))[0].running,true);
    const restored=new Scheduler(cfg,{file,runTask:async()=>({text:'not automatically dispatched'})});
    const job=restored.list()[0];assert.equal(job.running,false);assert.equal(job.paused,true);assert.equal(job.lastStatus,'interrupted');assert.equal(job.history.at(-1).status,'interrupted');
    assert.equal(JSON.parse(fs.readFileSync(file))[0].running,false);restored.stop();
  }finally{clean(home);}
});

test('read-only restart recovery is explicit and its interruption history is saved once',()=>{
  const home=scratch(),file=path.join(home,'schedule.json');
  try{
    fs.writeFileSync(file,JSON.stringify([{id:'j-observation',task:'Controlled read',spec:{kind:'every',everyMs:60000},nextRun:999999,paused:false,running:true,readOnly:true,runId:'interrupted-observation'}]));
    const recovered=new Scheduler(cfg,{file,now:()=>1000,resumeReadOnlyOnBoot:true,runTask:async()=>({text:'not dispatched in this test'})});
    assert.equal(recovered.list()[0].paused,false);assert.equal(recovered.list()[0].nextRun,1000);recovered.stop();
    const second=new Scheduler(cfg,{file,now:()=>2000,runTask:async()=>({text:'not dispatched'})});
    assert.equal(second.list()[0].history.length,1);second.stop();
  }finally{clean(home);}
});
test('a scheduled task waiting for approval pauses future dispatch and preserves that status',async()=>{
  const home=scratch(),file=path.join(home,'schedule.json');let calls=0;
  const scheduler=new Scheduler(cfg,{file,runTask:async()=>{calls++;return {status:'awaiting_approval',text:'Needs owner'};}});
  try{
    const job=scheduler.add({when:'every 1m',task:'Controlled held action'});await scheduler.runNow(job.id);
    assert.equal(scheduler.list()[0].paused,true);assert.equal(scheduler.list()[0].lastStatus,'awaiting_approval');
    await scheduler.tick();assert.equal(calls,1);
    assert.equal(JSON.parse(fs.readFileSync(file))[0].history.at(-1).status,'awaiting_approval');
  }finally{scheduler.stop();clean(home);}
});
