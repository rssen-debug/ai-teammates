import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmSelectedModel } from '../src/ui/model-confirm.js';
import { DEFAULTS, Config, JOBS, clone, load } from '../src/core/config.js';

const sample=(provider,id)=>({
  routes:JOBS.map(job=>({job,provider,ref:provider+'/'+id})),
  moa:{policy:'off'},
});

test('OpenCode Go cannot silently be confused with OpenCode Zen or a shared GLM model name',()=>{
  const go=sample('opencode','glm-5.3-flash');
  assert.equal(confirmSelectedModel(go,'opencode','glm-5.3-flash',JOBS).ok,true);
  assert.equal(confirmSelectedModel(go,'opencodezen','glm-5.3-flash',JOBS).ok,false);
  const zen=sample('opencodezen','glm-5.3-flash');
  assert.equal(confirmSelectedModel(zen,'opencode','glm-5.3-flash',JOBS).ok,false);
});

test('partial or stale saved routes are not mistaken for successful whole-agent model selection',()=>{
  const routes=sample('opencode','glm-5.3-flash');
  routes.routes[routes.routes.findIndex(r=>r.job==='re')]={job:'re',provider:'opencodezen',ref:'opencodezen/glm-5.3-flash'};
  const failure=confirmSelectedModel(routes,'opencode','glm-5.3-flash',JOBS);
  assert.equal(failure.ok,false);
  assert.ok(failure.missing.includes('re'));
  assert.match(failure.reason,/does not match/);
});

test('picker refuses to call a selected model confirmed if multi-model routing remained enabled',()=>{
  const s=sample('opencode','glm-5.3-flash');
  s.moa.policy='auto';
  assert.equal(confirmSelectedModel(s,'opencode','glm-5.3-flash',JOBS).ok,false);
  assert.match(confirmSelectedModel(s,'opencode','glm-5.3-flash',JOBS).reason,/Multi-model/);
});

test('null, partial and malformed state response cannot produce false selected-model success',()=>{
  assert.equal(confirmSelectedModel(null,'opencode','glm-5.3-flash',JOBS).ok,false);
  assert.equal(confirmSelectedModel({routes:[]},'opencode','glm-5.3-flash',JOBS).ok,false);
  assert.equal(confirmSelectedModel(sample('opencode','glm-5.3-flash'),'','glm-5.3-flash',JOBS).ok,false);
});

test('actual config route selection survives disk save, restart, and unrelated updates',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-model-restart-'));
  const previous=process.env.MAJIN_CONFIG;
  const file=path.join(dir,'config.json');
  try{
    process.env.MAJIN_CONFIG=file;
    const cfg=new Config(clone(DEFAULTS),file);
    assert.equal(cfg.save(),true);
    const desired='opencode/glm-5.3-flash';
    const routes=Object.fromEntries(JOBS.map(j=>[j,desired]));
    const patched=cfg.patch({models:{provider:'opencode',routes},moa:{policy:'off'}});
    assert.equal(patched.ok,true,JSON.stringify(patched.errors));
    assert.equal(patched.persisted,true);
    const cold=load();
    assert.equal(cold.get('models.provider'),'opencode');
    assert.equal(cold.get('models.routes.chat'),desired);
    assert.equal(confirmSelectedModel({routes:cold.routeTable(),moa:{policy:cold.get('moa.policy')}},
      'opencode','glm-5.3-flash',JOBS).ok,true);
    assert.equal(cold.patch({updates:{lastCheck:'2026-10-21'}}).ok,true);
    const secondStart=load();
    assert.equal(confirmSelectedModel({routes:secondStart.routeTable(),
      moa:{policy:secondStart.get('moa.policy')}},'opencode','glm-5.3-flash',JOBS).ok,true);
  }finally{
    if(previous===undefined)delete process.env.MAJIN_CONFIG;else process.env.MAJIN_CONFIG=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('UI does not close model selector from PATCH-only acknowledgement',()=>{
  const ui=fs.readFileSync(new URL('../src/ui/onboard.js',import.meta.url),'utf8');
  assert.match(ui,/confirmSelectedModel\(fresh, name, id, ROUTE_JOBS\)/);
  assert.match(ui,/if \(!proof\.ok\)/);
  assert.match(ui,/OB\.st = fresh/);
  assert.match(ui,/if \(window\.S\) window\.S\.st = fresh/);
  assert.match(ui,/Connect/);
  assert.ok(!ui.includes("chip.title = PICKER.current || 'no model set'"),'provider name should never be overwritten in chip tooltip');
});
