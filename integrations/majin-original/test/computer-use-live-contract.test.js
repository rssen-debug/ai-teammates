import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDesktopPlan } from '../src/core/tools/computer.js';
import { computerUse, normalizeAction } from '../src/core/computer-use.js';

test('computer planner parses strict JSON and refuses non-JSON or forged command actions',()=>{
  assert.deepEqual(parseDesktopPlan('{"action":"list_windows"}'),{action:'list_windows'});
  assert.deepEqual(parseDesktopPlan('```json\n{"action":"read","window":"QA"}\n```'),
    {action:'read',window:'QA'});
  assert.equal(parseDesktopPlan('clicked and done').action,'invalid');
  assert.equal(normalizeAction(parseDesktopPlan('{"action":"shell.run","command":"format C:"}')).kind,'invalid');
});

test('computer.use cannot complete on model saying done without proof (even if registry succeeds)',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'majin-computer-done-proof-'));
  try{
    let actions=0;
    const registry={exec:async(name)=>{
      actions++;
      if(name==='control.list_windows')return {ok:true,meta:{windows:[{title:'QA window'}]}};
      if(name==='screen.capture')return {ok:false,error:{code:'none'}};
      return {ok:true};
    }};
    const r=await computerUse('finish without evidence',{
      workspaceDir:workspace,registry,maxSteps:2,
      modelCall:async()=>({action:'done'}),
    });
    assert.equal(r.ok,false);
    assert.equal(r.status,'blocked');
    assert.equal(r.errorCategory,'budget');
    const trace=fs.readFileSync(path.join(r.dir,'steps.jsonl'),'utf8');
    assert.match(trace,/unverified_done_claim/);
    assert.ok(actions>=2);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
