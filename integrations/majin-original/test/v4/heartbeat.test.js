// Controlled real HTTP/store integration; no physical mobile delivery implied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startTestServer,postChat,readSse} from './helpers.mjs';

const control=(s,cookie,body)=>fetch(s.base+'/api/heartbeat',{method:'POST',headers:{cookie,origin:s.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify(body)});
async function heldTurn(s,cookie,name){
  const events=await readSse(await postChat(s.base,cookie,{text:`Skriv filen ${name} med innehåll: private background phrase`,requestId:name}));
  const done=events.find(e=>e.type==='done').data;assert.equal(done.status,'awaiting_approval');return done;
}

test('real approval events enter the existing heartbeat; preview is inert, default delivery stays in shared history',async()=>{
  const s=await startTestServer({env:{MAJIN_V4_WRITE_POLICY:'strict'}}),cookie=s.existingSession();
  try{
    assert.equal((await fetch(s.base+'/api/heartbeat')).status,401);
    assert.equal((await fetch(s.base+'/api/heartbeat',{method:'POST',headers:{cookie,origin:s.base,'content-type':'application/json'},body:'{}'})).status,403);
    const held=await heldTurn(s,cookie,'heartbeat-pending.txt');assert.equal(s.context.heartbeat.view().queued,1);
    assert.equal(s.context.heartbeat.view().conversationId,null);
    const preview=await (await control(s,cookie,{action:'preview'})).json();assert.equal(preview.result.sent,false);assert.equal(preview.result.dryRun,true);
    assert.equal(s.context.heartbeat.view().queued,1);assert.equal(s.context.heartbeat.view().conversationId,null);
    const delivered=await (await control(s,cookie,{action:'flush'})).json();assert.equal(delivered.result.delivery.channels,'conversation_only');
    const view=s.context.heartbeat.view(),conv=s.context.conversations.get(view.conversationId);
    assert.equal(conv.messages.length,1);assert.match(conv.messages[0].content,/approval.required/);assert.equal(conv.messages[0].content.includes('private background phrase'),false);
    assert.equal(s.context.heartbeat.view().queued,0);assert.equal('persisted' in view,false);
    const push=await(await fetch(s.base+'/api/push',{headers:{cookie}})).json();assert.equal(push.history.length,0,'default heartbeat does not enqueue a device notification');
    assert.equal(s.context.conversations.get(held.conversationId).pendingApproval.tool,'workspace_write');
    const again=await (await control(s,cookie,{action:'flush'})).json();assert.equal(again.result.sent,false);assert.equal(s.context.conversations.get(view.conversationId).messages.length,1);
  }finally{await s.close();}
});

test('resolved approval is removed before a digest and never sends a stale warning',async()=>{
  const s=await startTestServer({env:{MAJIN_V4_WRITE_POLICY:'strict'}}),cookie=s.existingSession();
  try{
    const held=await heldTurn(s,cookie,'heartbeat-resolved.txt');assert.equal(s.context.heartbeat.view().queued,1);
    await control(s,cookie,{action:'pause'});
    await readSse(await fetch(s.base+'/api/approve',{method:'POST',headers:{cookie,origin:s.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify({conversationId:held.conversationId,approve:false})}));
    assert.equal(s.context.heartbeat.view().queued,0);
    await control(s,cookie,{action:'resume'});
    const result=await (await control(s,cookie,{action:'flush'})).json();assert.equal(result.result.sent,false);assert.equal(s.context.heartbeat.view().conversationId,null);
  }finally{await s.close();}
});

test('heartbeat queue/config survive real host close/reopen, and explicit push links to the actual pending task',async()=>{
  const env={MAJIN_V4_WRITE_POLICY:'strict',MAJIN_V4_PUBLIC_ORIGIN:'https://controlled.test'};
  let s=await startTestServer({env});let cookie=s.existingSession();const home=s.home;
  try{
    const held=await heldTurn(s,cookie,'heartbeat-restart.txt');
    assert.equal((await control(s,cookie,{action:'configure',notify:true})).status,200);
    await s.close({keep:true});s=await startTestServer({home,env});cookie=s.existingSession();
    assert.equal(s.context.heartbeat.view().queued,1);assert.equal(s.context.heartbeat.view().notify,true);
    const delivery=await (await control(s,cookie,{action:'flush'})).json();assert.equal(delivery.result.delivery.channels,'no_subscribed_devices');
    const push=await(await fetch(s.base+'/api/push',{headers:{cookie}})).json();assert.equal(push.history.length,1);assert.equal(push.history[0].conversationId,held.conversationId);assert.equal(push.history[0].status,'no_subscribed_devices');
    await control(s,cookie,{action:'pause'});assert.equal(s.context.heartbeat.view().running,false);
    assert.equal(s.context.audit.status().ok,true);
    const text=fs.readFileSync(path.join(s.config.paths.root,'heartbeats','state.json'),'utf8');assert.equal(text.includes('private background phrase'),false);
  }finally{await s.close();}
});
