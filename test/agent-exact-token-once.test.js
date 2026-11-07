import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-exact-write-'));
process.env.MAJIN_HOME = home;
const ws = path.join(home, 'workspace');
fs.mkdirSync(ws, { recursive: true });
const { explicitTarget, exactSingleTextCreation, pinSingleExactTextWrite,
  verifySingleExactTextCreation } = await import('../src/core/goal-artifact.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { loop } = await import('../src/core/loop.js');
const filename = 'note-QA-1048.txt';
const marker = 'QA_FILE_1048';
const goal = 'Actually use fs.write to create ' + filename +
  ' containing EXACTLY ' + marker + '. Do not just say done.';

test('replay REAL Qwen regression: period suffix is corrected to exact requested token', () => {
  assert.equal(exactSingleTextCreation(goal, ws)?.expected, marker);
  const call = { path:filename, content: marker + '.' };
  const pin = pinSingleExactTextWrite(goal,ws,'fs.write',call);
  assert.equal(pin.corrected,true);
  assert.deepEqual(pin.args,{path:filename,content:marker});
  assert.deepEqual(call,{path:filename,content:marker+'.'},'never mutate original model arguments');
});

test('once exact bytes exist, require a successful real write and compare raw bytes', () => {
  fs.writeFileSync(path.join(ws,filename),marker+'.');
  assert.equal(verifySingleExactTextCreation(goal,ws,'fs.write',{path:filename},true)?.ok,false);
  fs.writeFileSync(path.join(ws,filename),marker);
  assert.equal(verifySingleExactTextCreation(goal,ws,'fs.write',{path:filename},false),null);
  assert.equal(verifySingleExactTextCreation(goal,ws,'fs.read',{path:filename},true),null);
  const proof=verifySingleExactTextCreation(goal,ws,'fs.write',{path:filename},true);
  assert.equal(proof?.ok,true);
  assert.match(proof.text,/verified on disk/);
  assert.equal(fs.readFileSync(path.join(ws,filename),'utf8'),marker);
});

test('never rewrite content in multi-action, edits, arbitrary text, code, or ambiguous targets', () => {
  const requests = [
    'Read '+filename+', then modify it so content is EXACTLY '+marker,
    'Create '+filename+' containing EXACTLY '+marker+' and send an email',
    'Create '+filename+' containing EXACTLY '+marker+' then delete it',
    'Create one.txt and two.txt containing EXACTLY '+marker,
    'Create a poem in '+filename+' containing the word EXACTLY '+marker,
    'Explain how to create '+filename+' containing EXACTLY '+marker,
    'Create output.js containing EXACTLY '+marker,
  ];
  for (const p of requests) {
    assert.equal(pinSingleExactTextWrite(p,ws,'fs.write',{path:filename,content:'WRONG'}),null,p);
    assert.equal(exactSingleTextCreation(p,ws),null,p);
  }
});

test('full MAJIN loop executes only ONE guarded write, corrects extra punctuation and returns verified success', async () => {
  fs.rmSync(path.join(ws,filename),{force:true});
  const rt = await createRuntime({channels:false,scheduler:false});
  const routes=Object.fromEntries(['chat','tasks','tools','analysis','code','research','final','summarize','router'].map(j=>[j,'demo/demo-fast']));
  const patched=rt.cfg.patch({workspace:ws,models:{provider:'demo',routes},
    moa:{policy:'off'},guard:{mode:'off'},agent:{maxSteps:8}});
  assert.equal(patched.ok,true,JSON.stringify(patched.errors));
  const events=[];
  let calls=0;
  try{
    const out=await loop({
      cfg:rt.cfg,registry:rt.registry,job:'tasks',label:'main',maxSteps:8,
      ctx:{session:'qa-exact-token',enforceActionEvidence:true,toolSubsetNames:['fs.write']},
      messages:[{role:'system',content:'Use permitted real tools'},{role:'user',content:goal}],
      onEvent:e=>events.push(e),
      modelCall:async({step})=>{
        calls++;
        assert.equal(step,1,'no extra model call after successful exact file write');
        return {text:'',toolCalls:[{id:'w1',name:'fs.write',
          argsJson:JSON.stringify({path:filename,content:marker+'.'})}],usage:{input:1,output:1}};
      },
    });
    assert.equal(calls,1);
    assert.equal(out.stopReason,'verified_exact_text_write');
    assert.notEqual(out.incomplete,true);
    assert.equal(fs.readFileSync(path.join(ws,filename),'utf8'),marker);
    assert.equal(out.toolLog?.filter(x=>x.tool==='fs.write' && x.ok).length,1);
    assert.ok(events.some(e=>e.type==='artifact_content_corrected'));
    assert.ok(events.some(e=>e.type==='artifact_exact_text_verified'));
  }finally{
    await rt.shutdown();
  }
});
