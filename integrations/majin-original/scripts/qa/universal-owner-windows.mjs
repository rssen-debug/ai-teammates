#!/usr/bin/env node
/**
 * Bounded Windows acceptance: real OpenCode Go creates a scene specification
 * with MAJIN fs.write, then trusted Python builds it in local Blender if installed.
 * A separate real browser test submits to a localhost FAKE employer only.
 * No private desktop screenshots, arbitrary model code or user files are used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
if(process.platform!=='win32'||process.env.CI!=='true'||process.env.MAJIN_OWNER_QA!=='1')
  throw new Error('This smoke test requires explicit owner Windows QA environment');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-universal-qa-'));
process.env.MAJIN_HOME=home;
const workspace=path.join(home,'workspace');
fs.mkdirSync(workspace,{recursive:true});
const nonce=Math.random().toString(36).slice(2,10).toUpperCase();
const file='scene-'+nonce+'.json', objName='MAJIN_QA_CUBE_'+nonce;
const report={schema:'majin-owner-universal-qa/1',model:'NOT_TESTED',blender:'NOT_TESTED',jobs:'NOT_TESTED',
  realApplicationsSent:0,arbitraryModelCodeExecuted:false,userFilesTouched:false,notes:[]};
function note(item,status,detail='') {
  report.notes.push({item,status,detail:String(detail).slice(0,180)});
  console.log('OWNER_QA '+item+' '+status+' '+String(detail).slice(0,180));
}
function call(exe,args,{cwd=workspace,timeout=150000,env={}}={}) {
  return spawnSync(exe,args,{cwd,timeout,encoding:'utf8',windowsHide:true,
    maxBuffer:1000000,env:{...process.env,...env}});
}
function findBlender() {
  const out=call('where.exe',['blender.exe'],{timeout:5000});
  const first=String(out.stdout||'').split(/\r?\n/).find(x=>x.trim().toLowerCase().endsWith('blender.exe'));
  if(first&&fs.existsSync(first.trim())) return first.trim();
  const dir=path.join(process.env.ProgramFiles||'C:\\Program Files','Blender Foundation');
  if(fs.existsSync(dir)) for(const d of fs.readdirSync(dir).sort().reverse()) {
    const f=path.join(dir,d,'blender.exe');if(fs.existsSync(f))return f;
  }
  return null;
}
async function realGo() {
  const key=String(process.env.OPENCODE_API_KEY||'').trim();
  if(!key){note('opencode-go','NOT_TESTED','missing OPENCODE_API_KEY on QA runner');return false;}
  const {createRuntime}=await import('../../src/core/runtime.js');
  const runtime=await createRuntime({channels:false,scheduler:false});
  try {
    const names=['chat','tasks','tools','code','research','analysis','plan','router','summarize','final','aggregator'];
    const routes=Object.fromEntries(names.map(n=>[n,'opencode/glm-5.3-flash']));
    const config=runtime.cfg.patch({workspace,providers:{opencode:{apiKey:key}},
      models:{provider:'opencode',routes},moa:{policy:'off',enabled:false},
      agent:{maxSteps:9,maxTurnSec:150,temperature:0.1,toolSubset:false},
      guard:{mode:'confirm'},tools:{allow:['fs.write','fs.read','fs.list']},
      updates:{check:false}},{persist:false});
    if(!config.ok)throw new Error('OpenCode Go QA configuration refused');
    const prompt='Actually use fs.write to create '+file+' in the MAJIN QA workspace. '+
      'Write exactly one VALID JSON object with object_name="'+objName+'", primitive="CUBE", size=2. '+
      'Do not browse, use shell commands, or merely say done.';
    const result=await runtime.agent.turn({input:prompt,session:'universal-'+nonce,
      source:'safe-owner-qa',model:'opencode/glm-5.3-flash'});
    if(result?.blocked||result?.error||result?.incomplete||!fs.existsSync(path.join(workspace,file)))
      throw new Error('Go agent did not finish the on-disk JSON fixture');
    const spec=JSON.parse(fs.readFileSync(path.join(workspace,file),'utf8'));
    if(spec.object_name!==objName||spec.primitive!=='CUBE'||spec.size!==2||
       Object.keys(spec).sort().join(',')!=='object_name,primitive,size')
      throw new Error('Go scene spec failed strict independent verification');
    report.model='PASS';note('opencode-go','PASS','real MAJIN Agent.turn wrote verified Blender scene JSON');
    return true;
  } finally {await runtime.shutdown();}
}
function blenderScenario() {
  const blender=findBlender();
  if(!blender){note('blender','NOT_TESTED','Blender not installed or discoverable');return;}
  // Trusted fixed code, NOT model-authored Python.
  const py=[
    'import bpy,json,sys',
    'spec_path,out_path=sys.argv[-2:]',
    'with open(spec_path,encoding="utf-8") as f: s=json.load(f)',
    'assert s["primitive"]=="CUBE" and s["size"]==2',
    'assert s["object_name"].startswith("MAJIN_QA_CUBE_")',
    'bpy.ops.wm.read_factory_settings(use_empty=True)',
    'bpy.ops.mesh.primitive_cube_add(size=2,location=(0,0,0))',
    'bpy.context.object.name=s["object_name"]',
    'bpy.ops.wm.save_as_mainfile(filepath=out_path)',
    'print("MAJIN_QA_SAVED")'
  ].join('\n');
  const pyFile=path.join(workspace,'trusted-scene.py');
  const blend=path.join(workspace,'proof.blend');
  fs.writeFileSync(pyFile,py);
  const built=call(blender,['--background','--factory-startup','--python',pyFile,'--',
      path.join(workspace,file),blend],{timeout:180000});
  if(built.status!==0||!fs.existsSync(blend))
    throw new Error('Blender render failed: '+String(built.stderr||built.stdout).slice(-170));
  const b=fs.readFileSync(blend);
  if(b.length<1000||b.subarray(0,7).toString()!=='BLENDER')
    throw new Error('Blender output was missing or not a valid .blend file');
  const verify=call(blender,['--background',blend,'--python-expr',
    'import bpy; assert bpy.data.objects.get("'+objName+'") is not None; print("MAJIN_QA_OBJECT_VERIFIED")'],{timeout:90000});
  if(verify.status!==0||!String(verify.stdout).includes('MAJIN_QA_OBJECT_VERIFIED'))
    throw new Error('Blender could not reopen verified cube scene');
  report.blender='PASS';note('blender','PASS','real Blender created and reopened .blend with named cube');
}
function fakeJobs() {
  const test=call(process.execPath,['--test','test/jobs.live.test.js'],
    {cwd:process.cwd(),timeout:150000,env:{MAJIN_BROWSER_LIVE:'1'}});
  const txt=String(test.stdout||'');
  if(test.status!==0){report.jobs='FAIL';note('jobs','FAIL',String(test.stderr||txt).slice(-160));return false;}
  if(/# skipped [1-9]/.test(txt)){note('jobs','NOT_TESTED','browser unavailable, test skipped');return false;}
  report.jobs='PASS';note('jobs','PASS','fake employer received a browser submission and proof');
  return true;
}
let failed=false;
try{
  const go=await realGo();
  if(!go)failed=true;
  else blenderScenario();
  if(!fakeJobs())failed=true;
}catch(e){failed=true;note('acceptance','FAIL',String(e.message||e));}
finally{
  const proof=path.join(process.cwd(),'qa-evidence','universal-owner.json');
  fs.mkdirSync(path.dirname(proof),{recursive:true});
  fs.writeFileSync(proof,JSON.stringify(report,null,2)+'\n');
  try{fs.rmSync(home,{recursive:true,force:true});}catch{}
  console.log('OWNER_UNIVERSAL_QA '+JSON.stringify(report));
}
if(failed)process.exitCode=1;
