/* Regression coverage for real-world agent reliability gates.
 * This suite is deterministic/offline; live-model quality is tested separately
 * by the free-model prompt battery PR #111.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-reliability-'));
process.env.MAJIN_HOME = tmp;
const { RepeatDetector } = await import('../src/core/watchdog.js');
const { expandDiscoveredTools, loop } = await import('../src/core/loop.js');
const { compact } = await import('../src/core/context.js');
const { createRuntime } = await import('../src/core/runtime.js');

test('repeat detector only blocks consecutive identical actions', () => {
  const d = new RepeatDetector(3);
  assert.equal(d.hit('fs.read', {path:'a.txt'}).repeat, false);
  assert.equal(d.hit('fs.read', {path:'a.txt'}).count, 2);
  assert.equal(d.hit('fs.write', {path:'a.txt',content:'changed'}).count, 1);
  assert.equal(d.hit('fs.read', {path:'a.txt'}).count, 1, 're-reading after write is not a loop');
  assert.equal(d.hit('fs.read', {path:'a.txt'}).repeat, false);
  assert.equal(d.hit('fs.read', {path:'a.txt'}).repeat, true);
});

test('tools.search reveals only real, allowlisted tool schemas', () => {
  const registry = { schemas: ({readOnly}) => [{name:'tools.search'},{name:'fs.write'}, ...(readOnly?[]:[{name:'fs.delete'}])] };
  const result = {ok:true,result:JSON.stringify({matches:[{name:'fs.write'}, {name:'fake.tool'}, {name:'fs.delete'}]})};
  assert.deepEqual(expandDiscoveredTools(['tools.search'], result, registry, {readOnly:true}), ['tools.search','fs.write']);
  assert.deepEqual(expandDiscoveredTools(['tools.search'], result, registry), ['tools.search','fs.write','fs.delete']);
  assert.deepEqual(expandDiscoveredTools(['tools.search'], {ok:false,result:result.result}, registry), ['tools.search']);
  assert.deepEqual(expandDiscoveredTools(null, result, registry), null);
});

test('context compaction never drops original system instructions or active user goal even if summarizer fails', async () => {
  const cfg = { get:(name)=>name==='agent.contextTokens'?90:name==='agent.keepRecent'?2:null,
    resolveModel:()=>{ throw new Error('offline summarizer'); } };
  const instructions = {role:'system', content:'RETAIN ORIGINAL TOOL / SAFETY INSTRUCTIONS'};
  const goal = {role:'system', content:'ACTIVE GOAL: submit three sandbox job fixture IDs without duplicates'};
  const messages = [instructions,goal, {role:'user',content:'Find jobs '.repeat(600)}, {role:'tool',content:'tool result '.repeat(900)},
    {role:'assistant',content:'Still working'}, {role:'user',content:'Continue using the original goal'}];
  const compacted = await compact({cfg, messages, brief:''});
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.messages.some(m => m.content===instructions.content), 'original system rules lost');
  assert.ok(compacted.messages.some(m => m.content===goal.content), 'user objective lost');
  assert.ok(compacted.messages.some(m => m.content==='Continue using the original goal'));
});

test('model can find fs.write using tools.search, then use it in the NEXT actual agent loop step', async () => {
  const rt = await createRuntime({channels:false,scheduler:false});
  const root = path.join(tmp,'workspace');
  fs.mkdirSync(root,{recursive:true});
  const routes = Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router','aggregator'].map(x=>[x,'demo/demo-fast']));
  const patched = rt.cfg.patch({ workspace:root,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{parallel:false} });
  assert.equal(patched.ok,true,JSON.stringify(patched.errors));
  let observedSecondStep = false;
  const events=[];
  const trace = await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',maxSteps:5,
    messages:[{role:'system',content:'Original system instructions'},{role:'user',content:'Create qa-tool-discovery.txt containing QA_VERIFIED'}],
    onEvent:e=>events.push(e),usage:rt.usage,
    ctx:{cfg:rt.cfg,session:'qa-discover',toolSubsetNames:['tools.search'],readOnly:false},
    modelCall:async ({step,tools})=>{
      const names=tools.map(t=>t.name);
      if(step===1) {
        assert.deepEqual(names,['tools.search']);
        return {text:'',toolCalls:[{id:'t1',name:'tools.search',argsJson:JSON.stringify({q:'write file',limit:15})}],usage:{input:2,output:2}};
      }
      if(step===2) {
        observedSecondStep=names.includes('fs.write');
        if(!observedSecondStep) throw Error('fs.write not visible after tools.search: '+names.join(','));
        return {text:'',toolCalls:[{id:'t2',name:'fs.write',argsJson:JSON.stringify({path:'qa-tool-discovery.txt',content:'QA_VERIFIED'})}],usage:{input:2,output:2}};
      }
      return {text:'File created',toolCalls:[],usage:{input:2,output:2}};
    },
  });
  assert.equal(observedSecondStep,true);
  assert.equal(fs.readFileSync(path.join(root,'qa-tool-discovery.txt'),'utf8'),'QA_VERIFIED');
  assert.equal(trace.toolLog.some(t=>t.tool==='fs.write' && t.ok),true);
  assert.ok(events.some(e=>e.type==='tool_subset_expand' && e.added.includes('fs.write')));
  await rt.shutdown();
});

test('incomplete and blocked turns cannot become successful reusable auto-skills', () => {
  const source = fs.readFileSync(new URL('../src/core/agent.js',import.meta.url),'utf8');
  const start = source.indexOf("if (cfg.get('skills.auto')");
  const gate = source.slice(start,start+420);
  for(const signal of ['!res.incomplete','!res.blocked','!res.aborted','!res.error','res.toolLog.every']) {
    assert.ok(gate.includes(signal), signal+' absent from auto-skill success gate');
  }
  assert.ok(source.includes("Mission incomplete"), 'partial mission may be falsely reported done');
});


test('an exhausted delegated worker is FAILED, never counted as a success', async () => {
  const { setScript } = await import('../src/core/provider/mock.js');
  const rt = await createRuntime({channels:false,scheduler:false});
  const routes = Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router','aggregator'].map(x=>[x,'demo/demo-fast']));
  const saved = rt.cfg.patch({models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:4}});
  assert.equal(saved.ok,true);
  setScript('sub:tasks', [{text:'I started, but have not completed the task',
    toolCalls:[{name:'fs.list',args:{path:'.'}}]}]);
  const output = await rt.registry.exec('agent.delegate', {
    tasks:[{task:'List and verify two separate files, do not stop after one step',job:'tasks',maxSteps:1}],
    parallel:false
  }, {session:'qa-subagent'});
  assert.equal(output.ok,true, JSON.stringify(output.error));
  assert.equal(output.meta.failed,1,'a subagent that reached the step limit must be reported failed');
  assert.match(String(output.result),/FEL:/);
  await rt.shutdown();
});


test('a model cannot pretend it created a file without performing any tool call', async () => {
  const rt = await createRuntime({channels:false,scheduler:false});
  const routes = Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router','aggregator'].map(x=>[x,'demo/demo-fast']));
  rt.cfg.patch({models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'}});
  const events=[]; let calls=0;
  const result=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:4,
    messages:[{role:'system',content:'Test agent'},{role:'user',content:'Create a file named fake-claim.txt with QA'}],
    ctx:{cfg:rt.cfg,session:'qa-false-claim',toolSubsetNames:['tools.search'],readOnly:false,enforceActionEvidence:true},
    onEvent:e=>events.push(e),
    modelCall:async()=>{calls++;return {text:'Done, I created fake-claim.txt',toolCalls:[],usage:{input:1,output:1}};},
  });
  assert.equal(calls,2,'must try exactly one bounded recovery');
  assert.equal(result.incomplete,true);
  assert.equal(result.stopReason,'missing_tool_evidence');
  assert.ok(events.some(x=>x.type==='missing_action_retry'));
  assert.equal(fs.existsSync(path.join(tmp,'workspace','fake-claim.txt')),false);
  await rt.shutdown();
});
