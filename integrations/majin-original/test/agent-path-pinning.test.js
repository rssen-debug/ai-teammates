import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-path-pin-'));
process.env.MAJIN_HOME=home;
const ws=path.join(home,'workspace');
fs.mkdirSync(ws,{recursive:true});
const { pinSingleFileWrite }=await import('../src/core/goal-artifact.js');
const { loop }=await import('../src/core/loop.js');
const { createRuntime }=await import('../src/core/runtime.js');

test('single-file user goal pins a mistaken absolute model path to requested basename',()=>{
  const r=pinSingleFileWrite('Actually use fs.write to create note-abcd.txt containing EXACTLY QA_MARKER',ws,
    'fs.write',{path:'/tmp/notes/wrong.txt',content:'QA_MARKER'});
  assert.equal(r.corrected,true);
  assert.equal(r.requestedPath,'note-abcd.txt');
  assert.equal(r.args.path,'note-abcd.txt');
  assert.equal(r.args.content,'QA_MARKER');
});

test('do not rewrite explicit absolute path, multi-file, subdir or nonwrite requests',()=>{
  assert.equal(pinSingleFileWrite('Create /tmp/target.txt',ws,'fs.write',{path:'/tmp/target.txt',content:'a'}),null);
  assert.equal(pinSingleFileWrite('Create alpha.txt and beta.txt',ws,'fs.write',{path:'/tmp/alpha.txt',content:'a'}),null);
  assert.equal(pinSingleFileWrite('Create nested/target.txt',ws,'fs.write',{path:'/tmp/nested/target.txt',content:'a'}),null);
  assert.equal(pinSingleFileWrite('Create target.txt',ws,'fs.read',{path:'/tmp/target.txt'}),null);
  assert.equal(pinSingleFileWrite('Create target.txt',ws,'fs.write',{path:'target.txt',content:'a'}),null);
});

test('production loop writes only the requested file when small LLM invents a /tmp path',async()=>{
  const rt=await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize'].map(x=>[x,'demo/demo-fast']));
  assert.equal(rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:5}}).ok,true);
  const goal='Actually use fs.write to create note-realcpt.txt containing EXACTLY REAL_OK';
  const wrong=path.join(home,'not-workspace','wrong.txt');
  const events=[];
  const res=await loop({cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:5,
    messages:[{role:'system',content:'Act.'},{role:'user',content:goal}],
    ctx:{session:'pin-e2e',enforceActionEvidence:true,toolSubsetNames:['fs.write']},onEvent:e=>events.push(e),
    modelCall:async({step})=>step===1?
      {text:'',usage:{input:1,output:1},toolCalls:[{id:'a',name:'fs.write',argsJson:JSON.stringify({path:wrong,content:'REAL_OK'})}]}:
      {text:'done',usage:{input:1,output:1},toolCalls:[]}
  });
  assert.equal(res.incomplete,undefined,JSON.stringify(res));
  assert.equal(fs.readFileSync(path.join(ws,'note-realcpt.txt'),'utf8'),'REAL_OK');
  assert.equal(fs.existsSync(wrong),false,'wrong model-chosen path must never be written');
  assert.ok(events.some(x=>x.type==='artifact_path_corrected' && x.requestedPath==='note-realcpt.txt'));
  await rt.shutdown();
});
