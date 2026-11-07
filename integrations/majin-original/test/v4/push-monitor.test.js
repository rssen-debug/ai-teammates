import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import webpush from 'web-push';
import {createPushService,validateSubscription} from '../../src/v4/push.js';
import {createBackgroundTasks,evaluateCondition} from '../../src/v4/background-tasks.js';
import {ConversationStore} from '../../src/v4/store.js';
import {startTestServer} from './helpers.mjs';

const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'majin-push-test-'));
function clean(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-push-test-'));fs.rmSync(root,{recursive:true,force:true});}
function subscription(){const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();return {endpoint:'https://web.push.apple.com/controlled-test-not-real',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};}

test('push retains VAPID identity, encrypts payload, deduplicates outbox and labels service acceptance honestly',async()=>{
  const root=scratch(),sub=subscription(),messages=[];
  const send=async(s,payload,options)=>{
    const encrypted=webpush.generateRequestDetails(s,payload,options);
    assert.ok(encrypted.body.length>0);assert.equal(encrypted.body.includes(Buffer.from('controlled notification')),false);
    assert.ok(encrypted.headers.Authorization||encrypted.headers.authorization);messages.push(JSON.parse(payload));
  };
  let push=createPushService({root,subject:'https://majin.test',send});
  try{
    push.subscribe(sub,'paired-owner');const key=push.view().publicKey;
    push.enqueue({id:'controlled:1',conversationId:'conv_test_123',body:'controlled notification'});
    push.stop();push=createPushService({root,subject:'https://majin.test',send});assert.equal(push.view().publicKey,key);
    await push.flush();assert.equal(messages.length,1);
    assert.equal(push.view().history[0].deliveries[0].status,'accepted_by_push_service');
    assert.equal(push.enqueue({id:'controlled:1',conversationId:'conv_test_123'}).duplicate,true);
    await push.flush();assert.equal(messages.length,1);
    const publicView=JSON.stringify(push.view());assert.equal(publicView.includes(sub.endpoint),false);assert.equal(publicView.includes(sub.keys.auth),false);assert.equal(publicView.includes('privateKey'),false);
  }finally{push.stop();clean(root);}
});

test('push retries transient errors within three attempts and expires revoked endpoints',async()=>{
  const root=scratch();let time=1000,calls=0;
  let push=createPushService({root,subject:'https://majin.test',now:()=>time,send:async()=>{calls++;throw Object.assign(Error('controlled push unavailable'),{statusCode:503});}});
  try{
    push.subscribe(subscription(),'owner');push.enqueue({id:'retry:1',conversationId:'conv_test_123'});
    await push.flush();await push.flush();assert.equal(calls,1);
    for(let i=0;i<2;i++){time+=300000;await push.flush();}
    assert.equal(calls,3);assert.equal(push.view().history[0].deliveries[0].status,'failed');
    push=createPushService({root,subject:'https://majin.test',send:async()=>{throw Object.assign(Error('expired'),{statusCode:410});}});
    push.enqueue({id:'expired:1',conversationId:'conv_test_123'});await push.flush();assert.equal(push.view().devices,0);assert.equal(push.view().history.at(-1).deliveries[0].status,'expired');
    for(const endpoint of ['http://127.0.0.1/a','https://web.push.apple.com.evil.test/a','https://user@web.push.apple.com/a','https://web.push.apple.com:444/a'])assert.throws(()=>validateSubscription({...subscription(),endpoint}));
  }finally{push.stop();clean(root);}
});

test('actual controlled HTTP condition crossing creates one alert across reload and preserves source evidence',async()=>{
  const root=scratch();let value=200,requests=0,modelCalls=0;const delivered=[];
  const source=http.createServer((req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({offer:{price:value}}));});
  await new Promise(r=>source.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${source.address().port}/price`,conversations=new ConversationStore({dir:path.join(root,'conversations')});
  const notifications=createPushService({root,subject:'https://majin.test',send:async(s,payload)=>delivered.push(JSON.parse(payload))});notifications.subscribe(subscription(),'owner');
  const options={root,conversations,notifications,readSource:async url=>(await fetch(url)).json(),startTurn:()=>{modelCalls++;throw Error('unchanged monitoring must not invoke model');}};
  let service=createBackgroundTasks(options);
  try{
    const job=await service.manage({action:'create',name:'Controlled price',when:'every 1m',task:'Observe source',notify:true,maxRuns:6,condition:{url,pointer:'/offer/price',operator:'lt',value:150}});
    await service.scheduler.runNow(job.id);assert.equal(delivered.length,0);
    value=120;await service.scheduler.runNow(job.id);await service.scheduler.runNow(job.id);assert.equal(delivered.length,1);
    service.stop();service=createBackgroundTasks(options);await service.scheduler.runNow(job.id);
    assert.equal(delivered.length,1);assert.equal(requests,4);assert.equal(modelCalls,0);
    const conv=conversations.get(job.metadata.conversationId);assert.equal(conv.messages.length,1);assert.ok(conv.messages[0].content.includes('120'));assert.ok(conv.messages[0].content.includes(url));
    value=200;await service.scheduler.runNow(job.id);value=100;await service.scheduler.runNow(job.id);assert.equal(delivered.length,2);
    assert.notEqual(delivered[0].id,delivered[1].id);assert.equal(service.list()[0].paused,true);
    assert.throws(()=>evaluateCondition({offer:{}},{pointer:'/offer/price',operator:'lt',value:100}),/missing/);
    assert.throws(()=>evaluateCondition({price:'99'},{pointer:'/price',operator:'lt',value:100}),/type/);
  }finally{service.stop();notifications.stop();await new Promise(r=>source.close(r));clean(root);}
});

test('push API requires authentication and CSRF and never exposes private push credentials',async()=>{
  const s=await startTestServer();const cookie=s.existingSession();
  try{
    assert.equal((await fetch(s.base+'/api/push')).status,401);
    assert.equal((await fetch(s.base+'/api/push',{method:'POST',headers:{cookie,origin:s.base,'content-type':'application/json'},body:'{}'})).status,403);
    const data=await (await fetch(s.base+'/api/push',{headers:{cookie}})).json();assert.equal(data.enabled,false);assert.equal('privateKey' in data,false);
  }finally{await s.close();}
});

test('failed sources pause after three bounded attempts and pausing an in-flight read prevents a late alert',async()=>{
  const root=scratch(),conversations=new ConversationStore({dir:path.join(root,'conversations')});let calls=0,alerts=0;
  let read=async()=>{calls++;throw Error('controlled source failure');};
  const service=createBackgroundTasks({root,conversations,readSource:(...args)=>read(...args),notifications:{enqueue:()=>alerts++,flush:async()=>{}},startTurn:()=>{throw Error('unexpected inference');}});
  try{
    const job=await service.manage({action:'create',name:'bounded',when:'every 1m',task:'Observe source',notify:true,condition:{url:'https://controlled.test/',pointer:'/price',operator:'lt',value:100}});
    for(let i=0;i<3;i++)await service.scheduler.runNow(job.id);
    assert.equal(calls,3);assert.equal(service.list()[0].paused,true);assert.equal(alerts,0);
    await service.manage({action:'resume',id:job.id});let release,entered;
    const started=new Promise(r=>entered=r);read=()=>{entered();return new Promise(r=>release=r);};
    const running=service.scheduler.runNow(job.id);await started;
    await service.manage({action:'pause',id:job.id});release({price:50});await running;
    assert.equal(alerts,0);assert.equal(conversations.get(job.metadata.conversationId).messages.length,0);
  }finally{service.stop();clean(root);}
});

test('worker displays bounded push content and only opens same-origin conversation links',async()=>{
  const listeners={},shown=[],opened=[];const origin='https://majin.test';
  const self={location:{origin},addEventListener:(type,fn)=>listeners[type]=fn,registration:{showNotification:async(title,options)=>shown.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
  vm.runInNewContext(fs.readFileSync(new URL('../../src/v4/ui/sw.js',import.meta.url),'utf8'),{self,URL});
  async function push(message){let promise;listeners.push({data:{json:()=>message},waitUntil:p=>promise=p});await promise;}
  await push({id:'test:1',title:'MAJIN',body:'controlled',url:'/?conversation=conv_test_123'});assert.equal(shown.length,1);assert.equal(shown[0].tag,'test:1');assert.equal(shown[0].renotify,false);
  await push({id:'evil',url:'https://evil.test'});assert.equal(shown.length,1);
  let promise;listeners.notificationclick({notification:{data:shown[0].data,close:()=>{}},waitUntil:p=>promise=p});await promise;assert.equal(opened[0],origin+'/?conversation=conv_test_123');
});
