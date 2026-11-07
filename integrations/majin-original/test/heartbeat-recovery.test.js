import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {Heartbeat} from '../src/core/heartbeat.js';
import {heartbeatTools} from '../src/core/tools/heartbeat.js';
import {adaptV1Tool} from '../src/v4/tools/host.js';
import {ToolRegistry} from '../src/v2/tools/registry.js';
import {runTool} from '../src/v2/tools/runner.js';
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'majin-hb-recovery-'));
const bus={sub:()=>()=>{},info:()=>{}};
function cleanup(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-hb-recovery-'));fs.rmSync(root,{recursive:true,force:true});}

test('a real child exit retains queued events and dedup including epoch zero; rate-held events are delivered later',async()=>{
  const root=scratch(),module=new URL('../src/core/heartbeat.js',import.meta.url).href;
  try{
    const script=`import {Heartbeat} from ${JSON.stringify(module)};const h=new Heartbeat({workspaceDir:${JSON.stringify(root)},now:()=>0});h.ingest('exec.error',{message:'actual child event'});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(child.status,0,child.stderr);
    let time=1000;const sent=[];const h=new Heartbeat({workspaceDir:root,bus,now:()=>time,minGapMs:10000,deliverFn:async(text)=>{sent.push(text);return {ok:true,channels:'controlled'};}});
    assert.equal(h.queue.length,1);assert.equal(h.ingest('exec.error',{message:'actual child event'}),false);
    await h.tick();h.ingest('exec.error',{message:'second event'});
    assert.equal((await h.tick()).sent,false);assert.equal(h.queue.length,1);
    const restored=new Heartbeat({workspaceDir:root,bus,now:()=>time,minGapMs:10000,deliverFn:h.deliverFn});
    assert.equal(restored.queue.length,1);time+=11000;assert.equal((await restored.tick()).sent,true);assert.equal(sent.length,2);
  }finally{cleanup(root);}
});

test('dry runs preserve state, concurrent ticks send once, and new events survive a delivery in flight',async()=>{
  const root=scratch();let finish,entered,calls=0;
  const started=new Promise(r=>entered=r);
  const h=new Heartbeat({workspaceDir:root,bus,minGapMs:0,deliverFn:async()=>{calls++;entered();return new Promise(r=>finish=r);}});
  try{
    assert.equal(h.matches('research.*.failed','research.job.failed'),true);
    h.ingest('exec.error',{message:'first'});const before=fs.readFileSync(h.statePath(),'utf8');
    assert.equal((await h.tick({dryRun:true})).sent,false);assert.equal(calls,0);assert.equal(fs.readFileSync(h.statePath(),'utf8'),before);
    const pending=h.tick();await started;
    assert.equal((await h.tick()).sent,false);assert.equal(calls,1);
    h.ingest('exec.error',{message:'arrived during delivery'});finish({ok:true,channels:'controlled'});await pending;
    assert.equal(h.queue.length,1);assert.equal(h.queue[0].detail.message,'arrived during delivery');
  }finally{h.stop();cleanup(root);}
});

test('failed delivery is retained and pauses after three attempts across reload; corrupt state is preserved',async()=>{
  const root=scratch();let calls=0;
  const options={workspaceDir:root,bus,minGapMs:0,deliverFn:async()=>{calls++;return {ok:false,channels:'controlled failure'};}};
  let h=new Heartbeat(options);
  try{
    h.ingest('exec.error',{message:'retained'});await h.tick();h=new Heartbeat(options);await h.tick();await h.tick();await h.tick();
    assert.equal(calls,3);assert.equal(h.queue.length,1);assert.equal(h.status().deliveryPaused,true);
    const corrupt='{broken source';fs.writeFileSync(h.statePath(),corrupt);
    assert.throws(()=>new Heartbeat(options));assert.equal(fs.readFileSync(h.statePath(),'utf8'),corrupt);
  }finally{h.stop();cleanup(root);}
});

test('the legacy heartbeat control tool cannot dispatch external digests as a read-only capability',async()=>{
  const registry=new ToolRegistry();registry.define(adaptV1Tool(heartbeatTools[0],{lane:'heartbeat',ctx:{}}));
  assert.equal(registry.get('majin_heartbeat').tier,'write', 'heartbeat changes stored state and must not be exposed as read-only');
  const result=await runTool({tool:'majin_heartbeat',input:{action:'tick'}},{registry,approvals:{check:()=>({decision:'waiting'})}});
  assert.equal(result.decision,'waiting');
});
