import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-artifact-contract-'));
process.env.MAJIN_HOME = home;
const { inspectRequestedArtifact, explicitTarget, repairSimpleFileWritingEchoCliWrite } = await import('../src/core/goal-artifact.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { loop, requiresRealAction } = await import('../src/core/loop.js');
const workspace = path.join(home, 'workspace');
fs.mkdirSync(workspace, {recursive:true});

test('contract verifies exact requested workspace basename, does not follow a model-chosen /tmp path',()=>{
  const goal = 'Create report-example.html with a heading, styled CTA button, responsive viewport meta tag and CSS style element';
  assert.equal(explicitTarget(goal,workspace).name,'report-example.html');
  let outcome=inspectRequestedArtifact(goal,workspace);
  assert.equal(outcome.ok,false);
  assert.match(outcome.reason,/named file is absent/);
  const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>button{color:red}</style></head><body><h1>Hi</h1><button>CTA</button></body></html>';
  fs.writeFileSync(path.join(workspace,'report-example.html'),html);
  outcome=inspectRequestedArtifact(goal,workspace);
  assert.equal(outcome.ok,true);
  fs.writeFileSync(path.join(workspace,'report-example.html'),'<html><body>Missing tags</body></html>');
  outcome=inspectRequestedArtifact(goal,workspace);
  assert.equal(outcome.ok,false);
  assert.ok(outcome.missing.some(x=>x.includes('button')));
  assert.ok(outcome.missing.some(x=>x.includes('viewport')));
});

test('contract does not invent proof for ambiguous filename or absolute paths',()=>{
  assert.equal(explicitTarget('Make first.html and second.html',workspace),null);
  assert.equal(explicitTarget('Make /tmp/somefile.html',workspace),null);
});

test('a real fs.write to wrong path gets corrected by a bounded actual tool loop',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize'].map(x=>[x,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:7}}).ok,true);
  const goal='Create qa-page.html with a heading, CTA button, responsive viewport meta tag, and CSS style element';
  const html='<html><head><meta name="viewport" content="width=device-width"><style>h1{color:red}</style></head><body><h1>Hello</h1><button>Go</button></body></html>';
  const events=[];
  const res=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    messages:[{role:'system',content:'Use real tools.'},{role:'user',content:goal}],
    ctx:{session:'qa-artifact',enforceActionEvidence:true,toolSubsetNames:['fs.write','fs.read']},
    onEvent:e=>events.push(e),
    modelCall:async({step})=>{
      if(step===1) return {text:'',usage:{input:1,output:1},toolCalls:[{id:'p1',name:'fs.write',argsJson:JSON.stringify({path:'wrong.html',content:'<html>wrong</html>'})}]};
      if(step===2) return {text:'Finished',toolCalls:[],usage:{input:1,output:1}};
      if(step===3) return {text:'',usage:{input:1,output:1},toolCalls:[{id:'p3',name:'fs.write',argsJson:JSON.stringify({path:'qa-page.html',content:html})}]};
      return {text:'Finished',toolCalls:[],usage:{input:1,output:1}};
    }
  });
  assert.equal(res.incomplete,undefined,JSON.stringify(res));
  assert.equal(fs.readFileSync(path.join(workspace,'qa-page.html'),'utf8'),html);
  assert.equal(res.toolLog.filter(t=>t.tool==='fs.write'&&t.ok).length,2);
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===false));
  assert.ok(events.some(e=>e.type==='artifact_verify'&&e.ok===true));
  await rt.shutdown();
});

test('a model lying after bounded retries returns INCOMPLETE (never "done")',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize'].map(x=>[x,'demo/demo-fast']));
  rt.cfg.patch({workspace,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'}});
  const res=await loop({
    cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:7,
    messages:[{role:'system',content:'Use tools.'},{role:'user',content:'Create actual-contract.txt containing EXACTLY MISSION_OK'}],
    ctx:{session:'qa-contract-fail',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
    modelCall:async({step})=>step===1?{text:'',usage:{input:1,output:1},toolCalls:[{id:'w1',name:'fs.write',argsJson:JSON.stringify({path:'wrong.txt',content:'some data'})}]}:
      {text:'Definitely done!',usage:{input:1,output:1},toolCalls:[]}
  });
  assert.equal(res.incomplete,true);
  assert.equal(res.stopReason,'artifact_contract_failed');
  assert.ok(res.steps<=5);
  await rt.shutdown();
});

test('explicit tool usage in real model prompts still activates artifact verification',()=>{
  assert.equal(requiresRealAction('Actually use fs.write to create note-abc.txt containing EXACTLY QA_VALUE.'),true);
  assert.equal(requiresRealAction('Create site-demo.html with heading and CSS'),true);
  assert.equal(requiresRealAction('How do I create a file named example.txt?'),false);
});


function wrongQwenFileEchoSource() {
  const tick = String.fromCharCode(96);
  const dollar = String.fromCharCode(36);
  return [
    '#!/usr/bin/env node', '',
    "import fs from 'node:fs';",
    "import path from 'node:path';", '',
    'export function respond(message) { return ' + tick + 'Received: ' + dollar + '{message}' + tick + '; }',
    '', 'process.argv.slice(2).forEach(arg => {',
    "  fs.writeFileSync(path.join(__dirname, 'response.txt'), respond(arg));",
    '});',
  ].join('\n');
}

test('real Qwen 3B evidence: tightly scoped ESM __dirname file-echo is converted to safe CLI stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-qwen-echo-'));
  const goal = 'Actually create a working Node.js CLI agent module in my-agent-probe.mjs. Export function respond(message) ' +
    'with a helpful reply containing the message. Use process.argv and handle different arguments at runtime. No external dependencies.';
  const source = wrongQwenFileEchoSource();
  const params = { path: 'my-agent-probe.mjs', content: source };
  const repaired = repairSimpleFileWritingEchoCliWrite(goal, dir, 'fs.write', params);
  assert.equal(repaired?.corrected, true, 'observed full source shape should match the repair');
  assert.ok(!repaired.args.content.includes('__dirname'));
  assert.ok(!repaired.args.content.includes('writeFileSync'));
  assert.match(repaired.args.content, /console\.log\(respond\(process\.argv\.slice\(2\)\.join/);
  fs.writeFileSync(path.join(dir, 'my-agent-probe.mjs'), repaired.args.content);
  const contract = inspectRequestedArtifact(goal, dir);
  assert.equal(contract?.ok, true, JSON.stringify(contract));
  const parse = spawnSync(process.execPath, ['--check', path.join(dir, 'my-agent-probe.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(parse.status, 0, String(parse.stderr || parse.error));
  assert.equal(repairSimpleFileWritingEchoCliWrite(goal, dir, 'fs.write',
    { path: '../outside.mjs', content: source }), null, 'never repair a different/escaped target');
  assert.equal(repairSimpleFileWritingEchoCliWrite(goal, dir, 'fs.write',
    { path: 'my-agent-probe.mjs', content: source + '\nprocess.exit(1);' }), null,
    'reject unallowlisted extra source statements');
  assert.equal(repairSimpleFileWritingEchoCliWrite(goal, dir, 'fs.write',
    { path: 'my-agent-probe.mjs', content: source.replace('response.txt', 'victim.txt') }), null,
    'reject arbitrary file side-effect destinations');
  assert.equal(repairSimpleFileWritingEchoCliWrite('Just explain a CLI in my-agent-probe.mjs', dir, 'fs.write', params), null,
    'never rewrite without the explicit respond and process.argv contract');
});
