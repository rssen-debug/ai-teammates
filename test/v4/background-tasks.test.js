import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createBackgroundTasks} from '../../src/v4/background-tasks.js';
import {ConversationStore} from '../../src/v4/store.js';
import {runTool} from '../../src/v2/tools/runner.js';
import {ToolRegistry} from '../../src/v2/tools/registry.js';
import {startTestServer} from './helpers.mjs';

test('background tasks use the existing scheduler and survive restart with bounded dispatch and edit/pause/cancel',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'majin-background-'));
  const conversations=new ConversationStore({dir:path.join(root,'conversations')});let calls=0,time=Date.now();
  const options={root,conversations,now:()=>time,startTurn:({conversationId,requestId})=>{calls++;assert.ok(requestId.startsWith('scheduled-'));conversations.appendMessage(conversationId,{role:'assistant',content:'observed controlled result'});return {finished:Promise.resolve({status:'completed',conversationId}),cancel:()=>{}};}};
  let service=createBackgroundTasks(options);
  try{
    const job=await service.manage({action:'create',name:'controlled',when:'every 1m',task:'Observe controlled source',maxRuns:2});
    const conv=job.metadata.conversationId;
    assert.ok(conversations.get(conv));
    await service.manage({action:'edit',id:job.id,name:'renamed'});
    assert.equal(service.list()[0].maxRuns,2);
    service.stop();service=createBackgroundTasks(options);
    assert.equal(service.list()[0].name,'renamed');assert.equal(service.list()[0].metadata.conversationId,conv);
    time+=61000;await service.scheduler.tick();assert.equal(calls,1);
    await service.manage({action:'pause',id:job.id});time+=61000;await service.scheduler.tick();assert.equal(calls,1);
    await service.manage({action:'resume',id:job.id});time+=61000;await service.scheduler.tick();assert.equal(calls,2);
    assert.equal(service.list()[0].paused,true);assert.equal(service.list()[0].history.length,2);
    assert.equal((await service.scheduler.runNow(job.id)).code,'run_budget');assert.equal(calls,2);
    await service.manage({action:'cancel',id:job.id});
    await assert.rejects(service.manage({action:'resume',id:job.id}),/Cancelled/);
    assert.equal(service.list()[0].history.length,2);
  }finally{service.stop();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-background-'));fs.rmSync(root,{recursive:true,force:true});}
});

test('background creation through model tool requires approval and held work pauses without duplicate execution',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'majin-background-'));let calls=0;
  const service=createBackgroundTasks({root,conversations:new ConversationStore({dir:path.join(root,'conversations')}),startTurn:()=>{calls++;return {finished:Promise.resolve({status:'awaiting_approval'}),cancel:()=>{}};}});
  const registry=new ToolRegistry();for(const tool of service.tools)registry.define(tool);
  const call={tool:'task_manage',input:{action:'create',name:'held',when:'every 1m',task:'Controlled external action'}};
  try{
    const held=await runTool(call,{registry,approvals:{check:()=>({decision:'waiting'})}});assert.equal(held.decision,'waiting');assert.equal(service.list().length,0);
    const created=await runTool(call,{registry,approvals:{check:()=>({decision:'allow'})}});
    await service.scheduler.runNow(created.data.id);assert.equal(calls,1);assert.equal(service.list()[0].paused,true);
    await service.scheduler.tick();assert.equal(calls,1);assert.equal(service.list()[0].lastStatus,'awaiting_approval');
  }finally{service.stop();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-background-'));fs.rmSync(root,{recursive:true,force:true});}
});

test('tasks API authenticates and uses the same agent to write a real file after HTTP dispatch returns',async()=>{
  const server=await startTestServer();const cookie=server.existingSession();
  const post=body=>fetch(server.base+'/api/tasks',{method:'POST',headers:{cookie,origin:server.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(server.base+'/api/tasks')).status,401);
    assert.equal((await fetch(server.base+'/api/tasks',{method:'POST',headers:{cookie,origin:server.base,'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await post({action:'create',name:'bad',when:'every 1s',task:'bad'})).status,400);
    const created=await (await post({action:'create',name:'file task',when:'every 1m',task:'Skriv filen scheduled-proof.txt med innehåll: background works',maxRuns:1})).json();
    assert.equal(created.ok,true);const id=created.task.id;
    assert.equal((await post({action:'run',id})).status,200);
    const deadline=Date.now()+6000;
    while(server.context.backgroundTasks.list()[0].running&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
    const current=server.context.backgroundTasks.list()[0];
    assert.equal(current.lastStatus,'completed');assert.equal(current.paused,true);
    assert.equal(fs.readFileSync(path.join(server.config.workspaceDir,'scheduled-proof.txt'),'utf8'),'background works');
    assert.ok(server.context.conversations.get(current.metadata.conversationId).messages.some(m=>m.role==='assistant'));
  }finally{await server.close();}
});
