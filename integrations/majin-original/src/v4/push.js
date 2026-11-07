// Encrypted standards-based Web Push; provider acceptance is not device receipt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import {writePrivate} from './auth.js';
import {protectAuditFile} from '../v2/audit/permissions.js';

export function validateSubscription(raw){
  const url=new URL(raw?.endpoint);
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href.length>4096||!(host==='fcm.googleapis.com'||host.endsWith('.push.apple.com')||host==='web.push.apple.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.notify.windows.com')))throw Error('Unsupported push service endpoint');
  if(!/^[A-Za-z0-9_-]{87}$/.test(raw.keys?.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(raw.keys?.auth||''))throw Error('Invalid push encryption keys');
  return {endpoint:url.href,keys:{p256dh:raw.keys.p256dh,auth:raw.keys.auth}};
}

export function createPushService({root,subject,send=(...args)=>webpush.sendNotification(...args),now=()=>Date.now(),audit=null}){
  const directory=path.join(root,'push');fs.mkdirSync(directory,{recursive:true,mode:0o700});protectAuditFile(directory);
  const file=path.join(directory,'private.json');let busy=false,timer,lastError=null;
  let state,fresh=false;
  try{state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.v!==1||!state.keys?.privateKey||!Array.isArray(state.subscriptions)||!Array.isArray(state.outbox)||!Array.isArray(state.history))throw Error('invalid push store');}
  catch(error){if(error.code!=='ENOENT')throw error;state={v:1,keys:webpush.generateVAPIDKeys(),subscriptions:[],outbox:[],history:[]};fresh=true;}
  const enabled=(()=>{try{return new URL(subject).protocol==='https:';}catch{return false;}})();
  // New temporary files inherit the protected directory's actual Windows ACL.
  const save=()=>writePrivate(file,JSON.stringify(state));
  if(fresh)save();
  const idOf=endpoint=>crypto.createHash('sha256').update(endpoint).digest('hex');
  function subscribe(raw,owner){
    if(!enabled)throw Error('Configure an HTTPS public origin before enabling push');
    const subscription=validateSubscription(raw),id=idOf(subscription.endpoint);
    const before=structuredClone(state);
    const existing=state.subscriptions.find(s=>s.id===id);
    if(existing)Object.assign(existing,{subscription,owner});else{if(state.subscriptions.length>=10)throw Error('Device limit reached');state.subscriptions.push({id,owner,subscription,createdAt:new Date(now()).toISOString()});}
    try{save();}catch(error){state=before;throw error;}return {id};
  }
  function unsubscribe(endpoint,owner){const before=structuredClone(state);state.subscriptions=state.subscriptions.filter(s=>s.id!==idOf(endpoint)||s.owner!==owner);try{save();}catch(error){state=before;throw error;}}
  function enqueue({id,conversationId,title='MAJIN',body='Your background task has an update.'}){
    if(!/^[a-zA-Z0-9:_-]{1,180}$/.test(id)||!/^conv_[a-z0-9_]+$/.test(conversationId))throw Error('Invalid notification handle');
    if(state.outbox.some(x=>x.id===id)||state.history.some(x=>x.id===id))return {duplicate:true,id};
    if(state.outbox.length>=100)throw Error('Notification queue full');
    const entry={id,conversationId,title:String(title).slice(0,80),body:String(body).slice(0,160),createdAt:new Date(now()).toISOString(),deliveries:state.subscriptions.map(s=>({device:s.id,attempts:0,status:'pending',nextAttempt:now()}))};
    state.outbox.push(entry);try{save();}catch(error){state.outbox.pop();throw error;}return {id,devices:entry.deliveries.length};
  }
  async function flush(){
    if(busy||!enabled)return;busy=true;
    try{
      audit?.assertHealthy();
      for(const item of [...state.outbox]){
        for(const delivery of item.deliveries){
          if(delivery.status!=='pending'||delivery.nextAttempt>now())continue;
          const device=state.subscriptions.find(s=>s.id===delivery.device);
          if(!device){delivery.status='unsubscribed';continue;}
          delivery.attempts++;delivery.nextAttempt=now()+30000*2**delivery.attempts;save();
          try{
            await send(device.subscription,JSON.stringify({id:item.id,title:item.title,body:item.body,url:`/?conversation=${encodeURIComponent(item.conversationId)}`}),{vapidDetails:{subject,publicKey:state.keys.publicKey,privateKey:state.keys.privateKey},TTL:86400,timeout:10000,urgency:'normal',topic:idOf(item.id).slice(0,32)});
            delivery.status='accepted_by_push_service';delivery.acceptedAt=new Date(now()).toISOString();
          }catch(error){delivery.statusCode=Number(error.statusCode)||null;if([404,410].includes(delivery.statusCode)){delivery.status='expired';state.subscriptions=state.subscriptions.filter(s=>s.id!==device.id);}else if(delivery.attempts>=3)delivery.status='failed';}
          audit?.recordEvent('push.delivery',{notificationId:item.id,deviceId:delivery.device,status:delivery.status,attempts:delivery.attempts,statusCode:delivery.statusCode||null});
          save();
        }
        if(item.deliveries.every(d=>d.status!=='pending')){
          item.status=item.deliveries.length?'finished':'no_subscribed_devices';
          state.history.push(item);state.history=state.history.slice(-200);state.outbox=state.outbox.filter(x=>x.id!==item.id);save();
        }
      }
    }finally{busy=false;}
  }
  return {subscribe,unsubscribe,enqueue,flush,
    view:()=>({enabled,publicKey:state.keys.publicKey,devices:state.subscriptions.length,pending:state.outbox.length,lastError,history:state.history.map(({deliveries,...item})=>({...item,deliveries:deliveries.map(({device,...d})=>d)}))}),
    start(){if(!timer){const tick=()=>void flush().then(()=>{lastError=null;}).catch(()=>{lastError='Notification queue could not be processed; inspect host storage.';});timer=setInterval(tick,30000);timer.unref?.();tick();}},
    stop(){if(timer)clearInterval(timer);timer=null;},
  };
}
