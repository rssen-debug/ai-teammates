// Reuse the original event digest engine with V4 durable conversations/outbox.
import fs from 'node:fs';
import path from 'node:path';
import {Heartbeat} from '../core/heartbeat.js';
import {writePrivate} from './auth.js';

export function createV4Heartbeat({root,conversations,notifications,audit,now=()=>Date.now(),tickMs=900000,minGapMs=300000}){
  let closed=false,observerError=null;
  const file=path.join(root,'heartbeat-config.json');
  let settings={v:1,enabled:true,notify:false,conversationId:null};
  try{
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    if(raw.v!==1||typeof raw.enabled!=='boolean'||typeof raw.notify!=='boolean'||(raw.conversationId!==null&&!/^conv_[a-z0-9_]+$/.test(raw.conversationId)))throw Error('Invalid heartbeat configuration; preserve and restore it');
    settings=raw;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const persist=()=>writePrivate(file,JSON.stringify(settings));
  const heartbeat=new Heartbeat({workspaceDir:root,bus:{sub:()=>()=>{},info:()=>{}},now,tickMs,minGapMs,deliverFn:async(text,{digestId,entries})=>{
    audit?.assertHealthy();
    let conv=settings.conversationId?conversations.get(settings.conversationId):null;
    if(!conv){conv=conversations.create({title:'MAJIN background updates',titlePolicy:'manual',sourceId:'majin:heartbeat'});settings.conversationId=conv.id;persist();}
    const notificationId=`heartbeat:${digestId}`;
    if(!conversations.get(conv.id).messages.some(m=>m.meta?.notificationId===notificationId))conversations.appendMessage(conv.id,{role:'assistant',content:text,meta:{notificationId,source:'heartbeat'}});
    audit?.recordEvent('heartbeat.digest',{digestId,conversationId:conv.id});
    let delivery='conversation_only';
    const target=entries.find(e=>/^conv_[a-z0-9_]+$/.test(e.detail?.conversationId||''))?.detail.conversationId||conv.id;
    if(settings.notify){const queued=notifications.enqueue({id:notificationId,conversationId:target,title:'MAJIN background update'});delivery=queued.duplicate?'push_previously_queued':queued.devices?'push_queued':'no_subscribed_devices';await notifications.flush();}
    return {ok:true,channels:delivery,conversationId:conv.id};
  }});
  function observeEvent(type,data={},conversationId=null){
    if(closed)return;
    const id=data.conversationId||conversationId;
    if(!id||!/^conv_[a-z0-9_]+$/.test(id))return;
    if(type==='approval_resolved'||(type==='done'&&data.status!=='awaiting_approval'))heartbeat.discard(e=>e.event==='approval.required'&&e.detail?.conversationId===id);
    if(!settings.enabled)return;
    if(type==='done'&&data.status==='awaiting_approval'){
      const pending=conversations.get(id)?.pendingApproval;
      heartbeat.ingest('approval.required',{conversationId:id,goalId:pending?.goalId||null,message:'A task is waiting for approval. Open its conversation for details.'});
    }
    if(type==='done'&&data.status==='failed')heartbeat.ingest('task.failed',{conversationId:id,goalId:data.goalId||null,message:'A task failed. Open its conversation for details.'});
  }
  function observe(...args){try{observeEvent(...args);observerError=null;}catch{observerError='A background event could not be checkpointed; inspect host storage.';}}
  function view(){const state=heartbeat.status();const {persisted,...publicState}=state;return {...publicState,enabled:settings.enabled,notify:settings.notify,conversationId:settings.conversationId,observerError};}
  async function manage({action,notify}={}){
    if(closed)throw Error('Heartbeat service stopped');
    audit?.assertHealthy();
    if(action==='flush')return heartbeat.tick();
    if(action==='preview')return heartbeat.tick({dryRun:true});
    if(!['configure','resume','pause'].includes(action))throw Error('Use configure, resume, pause, flush or preview');
    if(notify!==undefined&&typeof notify!=='boolean')throw Error('notify must be boolean');
    const before={...settings};
    if(notify!==undefined)settings.notify=notify;
    if(action==='pause')settings.enabled=false;
    if(action==='resume')settings.enabled=true;
    try{persist();}catch(error){settings=before;throw error;}
    if(settings.enabled){if(action==='resume')heartbeat.resume();else heartbeat.start();}else heartbeat.stop();
    return view();
  }
  return {heartbeat,observe,view,manage,start(){if(!closed&&settings.enabled)heartbeat.start();},stop(){closed=true;heartbeat.stop();}};
}
