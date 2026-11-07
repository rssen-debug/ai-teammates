// V4 binding to the existing scheduler and the same foreground agent/store.
import path from 'node:path';
import crypto from 'node:crypto';
import {z} from 'zod';
import {Scheduler,parseWhen} from '../core/schedule.js';

const conditionSchema=z.object({url:z.string().url().max(4096),pointer:z.string().max(500),operator:z.enum(['eq','lt','lte','gt','gte']),value:z.union([z.number().finite(),z.string().max(500),z.boolean()])});
export function evaluateCondition(document,condition){
  let actual=document;
  if(condition.pointer!==''){
    if(!condition.pointer.startsWith('/'))throw Error('Use a JSON Pointer beginning with /');
    for(const segment of condition.pointer.slice(1).split('/')){
      const key=segment.replace(/~1/g,'/').replace(/~0/g,'~');
      if(actual===null||typeof actual!=='object'||!Object.hasOwn(actual,key))throw Error('Condition field missing in actual source');
      actual=actual[key];
    }
  }
  if(typeof actual!==typeof condition.value||!['string','number','boolean'].includes(typeof actual))throw Error('Condition source type differs from configured threshold');
  if(typeof actual==='number'&&!Number.isFinite(actual))throw Error('Condition source is not finite');
  if(condition.operator!=='eq'&&typeof actual!=='number')throw Error('Ordered conditions require numeric source and threshold');
  const matched={eq:()=>actual===condition.value,lt:()=>actual<condition.value,lte:()=>actual<=condition.value,gt:()=>actual>condition.value,gte:()=>actual>=condition.value}[condition.operator]();
  return {actual,matched};
}

const definition=z.object({
  name:z.string().trim().min(1).max(100),
  when:z.string().trim().min(1).max(500),
  task:z.string().trim().min(1).max(12000),
  maxRuns:z.number().int().min(1).max(1000),
  notify:z.boolean(),
  condition:conditionSchema.nullable().describe('Required for deterministic monitoring: actual JSON source URL, pointer, operator and typed threshold. Without condition, the task invokes the model each run.'),
});
export const taskAction=z.discriminatedUnion('action',[
  definition.extend({action:z.literal('create'),maxRuns:definition.shape.maxRuns.default(20),notify:z.boolean().default(false),condition:conditionSchema.nullable().default(null)}),
  definition.partial().extend({action:z.literal('edit'),id:z.string().min(1)}),
  ...['pause','resume','cancel','run'].map(action=>z.object({action:z.literal(action),id:z.string().min(1)})),
]);

export function createBackgroundTasks({root,conversations,startTurn,readSource=null,notifications=null,audit=null,ready=Promise.resolve(),now=()=>Date.now()}){
  const active=new Map();let closed=false;
  const scheduler=new Scheduler({get:()=>undefined},{file:path.join(root,'background-tasks.json'),now,
    runTask:async({jobId,runId,input})=>{
      if(closed)throw Error('background service stopped');
      await ready;
      const job=scheduler.jobs.find(j=>j.id===jobId);
      if(closed||job?.paused)return {status:'cancelled',text:''};
      if(!job?.metadata?.conversationId)throw Error('Task has no durable conversation');
      audit?.assertHealthy();audit?.recordEvent('background.start',{jobId,runId});
      if(job.metadata.condition){
        if(!readSource)throw Error('Read-only source tool unavailable');
        try{
          const condition=job.metadata.condition;
          const document=await readSource(condition.url);
          if(closed||job.paused)return {status:'cancelled',text:''};
          const observed=evaluateCondition(document,condition);
          audit?.recordEvent('background.observed',{jobId,runId,matched:observed.matched,observationHash:crypto.createHash('sha256').update(JSON.stringify({condition,actual:observed.actual})).digest('hex')});
          const previous=job.metadata.observation;
          const sequence=(previous?.sequence||0)+(observed.matched&&!previous?.matched?1:0);
          if(observed.matched&&!previous?.matched){
            const id=`condition:${job.id}:${sequence}`;
            // Enqueue before checkpoint: a retry uses the same durable ID.
            if(job.metadata.notify){if(!notifications)throw Error('Notification delivery unavailable');notifications.enqueue({id,conversationId:job.metadata.conversationId,title:job.name});}
            if(!conversations.get(job.metadata.conversationId)?.messages.some(m=>m.meta?.notificationId===id))conversations.appendMessage(job.metadata.conversationId,{role:'assistant',content:`Condition observed at ${new Date(now()).toISOString()}: ${condition.url} ${condition.pointer} = ${JSON.stringify(observed.actual)} (${condition.operator} ${JSON.stringify(condition.value)}).`,meta:{notificationId:id,source:condition.url}});
          }
          job.metadata.observation={...observed,sequence,at:new Date(now()).toISOString()};job.metadata.consecutiveFailures=0;scheduler.save();
          if(job.metadata.notify)await notifications?.flush();
          return {status:'completed',text:`Source checked; condition ${observed.matched?'matched':'not matched'}.`};
        }catch(error){job.metadata.consecutiveFailures=(job.metadata.consecutiveFailures||0)+1;if(job.metadata.consecutiveFailures>=3)job.paused=true;throw error;}
      }
      const run=startTurn({conversationId:job.metadata.conversationId,text:input,requestId:`scheduled-${runId}`,owner:`schedule:${jobId}`});
      active.set(jobId,run);
      try{
        const result=await run.finished;
        // Pause failed/held work: never blindly retry an unverified side effect.
        if(!['completed','replayed'].includes(result.status))job.paused=true;
        const conv=conversations.get(job.metadata.conversationId);
        const text=conv?.messages.filter(m=>m.role==='assistant').at(-1)?.content||'';
        if(job.metadata.notify&&result.status==='completed'){notifications?.enqueue({id:`task:${runId}`,conversationId:job.metadata.conversationId,title:job.name});await notifications?.flush();}
        return {...result,text};
      }finally{active.delete(jobId);}
    },
  });
  const validateSchedule=when=>{const spec=parseWhen(when);if(spec.kind==='every'&&spec.everyMs<30000)throw Error('Background interval must be at least 30 seconds');};
  function list(){return scheduler.list().map(j=>({...j,conversationId:j.metadata?.conversationId||null}));}
  async function manage(raw){
    const input=taskAction.parse(raw);
    audit?.assertHealthy();audit?.recordEvent('background.management_requested',{action:input.action,jobId:input.id||null});
    if(input.condition){const url=new URL(input.condition.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw Error('Condition source must be an HTTP(S) URL without embedded credentials or fragment');}
    if(closed)throw Error('background service stopped');
    if(input.action==='create'){
      validateSchedule(input.when);
      if(scheduler.jobs.length>=100)throw Error('Background task limit reached (100)');
      const conv=conversations.create({title:input.name,titlePolicy:'manual'});
      return scheduler.add({...input,readOnly:false,metadata:{conversationId:conv.id,schema:'majin.v4.background/v1',notify:input.notify,condition:input.condition}});
    }
    const job=scheduler.jobs.find(j=>j.id===input.id);
    if(!job)throw Error('Unknown background task');
    if(input.action==='edit'){
      if(input.when)validateSchedule(input.when);
      const {action,id,notify,condition,...changes}=input;
      if(notify!==undefined||condition!==undefined)changes.metadata={...job.metadata,...(notify!==undefined?{notify}:{}),...(condition!==undefined?{condition,observation:null}:{})};
      return scheduler.update(id,changes);
    }
    if(input.action==='run'){
      if(job.paused)throw Error('Resume the task before running it');
      // Return a handle immediately; long-running work belongs to the journal.
      void scheduler.runNow(job.id).catch(()=>scheduler.stop());
      return {id:job.id,status:'dispatched',conversationId:job.metadata.conversationId};
    }
    if(input.action==='cancel'){
      scheduler.setPaused(job.id,true);active.get(job.id)?.cancel();
      // Retain history and authorization records instead of deleting evidence.
      job.metadata={...job.metadata,cancelledAt:new Date(now()).toISOString()};scheduler.save();
    }else{
      if(input.action==='resume'&&job.metadata?.cancelledAt)throw Error('Cancelled tasks cannot resume; create a new task');
      scheduler.setPaused(job.id,input.action==='pause');
      if(input.action==='pause')active.get(job.id)?.cancel();
    }
    return list().find(j=>j.id===job.id);
  }
  return {scheduler,list,manage,
    start(){if(!closed)scheduler.start();},
    stop(){closed=true;scheduler.stop();for(const run of active.values())run.cancel();},
    tools:[
      {name:'task_list',description:'List durable background tasks with schedule, history, budgets and conversation links.',tier:'read',inputSchema:z.object({}),outputSchema:z.object({tasks:z.array(z.any())}),execute:async()=>({tasks:list()})},
      {name:'task_manage',description:'Manage owner-approved durable tasks. create requires name, when, task; edit/pause/resume/cancel/run require id. Minimum interval30s; maxRuns bounds dispatches. Optional condition: JSON source URL, pointer, operator eq/lt/lte/gt/gte, value. notify enables registered-device push.',tier:'external',inputSchema:definition.partial().extend({action:z.enum(['create','edit','pause','resume','cancel','run']),id:z.string().optional()}),outputSchema:z.any(),execute:manage},
    ],
  };
}
