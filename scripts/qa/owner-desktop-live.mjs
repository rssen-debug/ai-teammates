/**
 * W11/W12 LIVE acceptance on the owner's interactive Windows runner.
 * Everything happens in an isolated synthetic QA window and a private TEMP
 * workspace. NEVER capture/upload a full desktop image or unrelated windows.
 * The pixels are sampled in RAM and only numeric verdicts leave the runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { winControlTools } from '../../src/core/tools/wincontrol.js';
import { netTools } from '../../src/core/tools/net.js';
import { computerTools } from '../../src/core/tools/computer.js';
import { Config, DEFAULTS, clone } from '../../src/core/config.js';
import { cursor, cursorPaths, isWindowsDesktop, overlayStatus } from '../../src/core/pink-cursor.js';

if (process.platform !== 'win32' || !isWindowsDesktop()) {
  throw new Error('BLOCKED: real, interactive Windows session required');
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-real-desktop-qa-'));
const nonce = Math.random().toString(36).slice(2, 9).toUpperCase();
const title = 'MAJIN-QA-' + nonce;
const expected = 'MAJIN_QA_DESKTOP_' + nonce;
const savedFile = path.join(workspace, 'qa-saved.txt');
const fixture = fileURLToPath(new URL('./owner-desktop-fixture.ps1', import.meta.url));
const evidenceFile = path.join(process.cwd(), 'qa-evidence', 'owner-desktop.json');
const verdict = { schema:'majin-owner-desktop-live/1', syntheticWindow:false,
  controlList:false, controlType:false, controlRead:false, controlClick:false, computerUseVerified:false, computerUseCloudVerified:false,
  verifiedSavedBytes:false, mouseMoveVerified:false, screenCaptureVerified:false, desktopPixelCanary:false, pinkVisible:false, pinkMoved:false, pinkHidden:false,
  pinkStateLabel:false, screenshotsUploaded:false, status:'BLOCKED' };

let app;
let pinkStarted = false;
function saveEvidence() {
  fs.mkdirSync(path.dirname(evidenceFile), {recursive:true});
  fs.writeFileSync(evidenceFile, JSON.stringify(verdict,null,2) + '\n');
}
function colorCount(x, y) {
  // CopyFromScreen samples ONLY the 220x56 pixel synthetic cursor region
  // and immediately destroys it. No screenshot is ever saved/uploaded.
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    '$img=New-Object System.Drawing.Bitmap -ArgumentList 220,56',
    '$g=[System.Drawing.Graphics]::FromImage($img)',
    '$pt=New-Object System.Drawing.Point -ArgumentList ' + Number(x) + ',' + Number(y),
    '$g.CopyFromScreen($pt,[System.Drawing.Point]::Empty,$img.Size)',
    '$n=0',
    'for($a=2;$a -lt 29;$a+=2){ for($b=13;$b -lt 42;$b+=2){ $c=$img.GetPixel($a,$b); if($c.R -gt 195 -and $c.G -ge 30 -and $c.G -le 165 -and $c.B -ge 100 -and $c.B -le 240){$n++}}}',
    '$g.Dispose();$img.Dispose();Write-Output $n',
  ].join('; ');
  const run = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',ps],{
    encoding:'utf8',timeout:12000,windowsHide:true,
  });
  if (run.error || run.status !== 0) throw new Error('crop pixel sample failed: ' + String(run.stderr||run.error).slice(0,160));
  const n = Number(String(run.stdout).trim().split(/\s+/).at(-1));
  if (!Number.isFinite(n)) throw new Error('pixel sampler returned no count');
  return n;
}
async function waitUntil(fn, ms=8000) {
  const start=Date.now();
  let last;
  while(Date.now()-start<ms) {
    try { last=await fn(); if(last) return last; } catch(e) { last=null; }
    await sleep(220);
  }
  return null;
}
const byName = name => {
  const tool = winControlTools.find(t => t.name===name);
  assert.ok(tool,'missing MAJIN control tool ' + name);
  return tool;
};
try {
  assert.ok(fs.existsSync(fixture),'QA fixture script missing');
  app=spawn('powershell.exe',[
    '-NoProfile','-STA','-ExecutionPolicy','Bypass',
    '-File',fixture,'-Title',title,'-OutFile',savedFile,
  ],{stdio:'ignore',windowsHide:true});
  const listed = await waitUntil(async()=>{
    if(app.exitCode != null)throw new Error('fixture process exited before window appeared');
    const res=await byName('control.list_windows').run({});
    return res.ok && res.meta?.windows?.some(w=>String(w.title||'').includes(title));
  },18000);
  assert.ok(listed,'MAJIN Win32 control.list_windows could not observe isolated QA form');
  verdict.syntheticWindow=true;verdict.controlList=true;

  const typed=await byName('control.type').run({window:title,text:expected});
  assert.equal(typed.ok,true,typed.error?.message);
  assert.equal(typed.meta?.verified,true);
  verdict.controlType=true;

  const read=await byName('control.read').run({window:title});
  assert.equal(read.ok,true,read.error?.message);
  assert.equal(read.meta?.text,expected);
  verdict.controlRead=true;

  const clicked=await byName('control.click_button').run({window:title,caption:'Save QA'});
  assert.equal(clicked.ok,true,clicked.error?.message);
  verdict.controlClick=true;
  const fileExists=await waitUntil(()=>fs.existsSync(savedFile),4000);
  assert.ok(fileExists,'button click did not save the requested QA file');
  assert.equal(fs.readFileSync(savedFile,'utf8'),expected,'real button did not save verified text');
  verdict.verifiedSavedBytes=true;

  // Move the ACTUAL mouse pointer and take a real small synthetic-frame PNG.
  // The former pointer position is restored immediately; no private desktop
  // region is uploaded and temporary screenshot bytes are destroyed at the end.
  const mouse = byName('mouse.move');
  const originalMouse = spawnSync('powershell.exe',['-NoProfile','-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+","+$p.Y.ToString())'],
    {encoding:'utf8',timeout:9000,windowsHide:true});
  assert.equal(originalMouse.status,0,'cannot read original mouse position');
  const coords = String(originalMouse.stdout).trim().split(/\r?\n/).at(-1).split(',').map(Number);
  assert.equal(coords.length,2);
  const moved = await mouse.run({x:180,y:110});
  try {
    assert.equal(moved.ok,true,'mouse.move must act on the actual system pointer: '+JSON.stringify(moved.error||moved).slice(0,240));
    assert.equal(moved.meta?.verified,true);
    verdict.mouseMoveVerified=true;
  } finally {
    if(coords.every(Number.isSafeInteger)) await mouse.run({x:coords[0],y:coords[1]});
  }
  const capTool=netTools.find(t=>t.name==='screen.capture');
  assert.ok(capTool,'missing screen.capture tool');
  const grab=await capTool.run({path:'qa-frame.png',region:'100,100,120,40',then:'save'},
    {cfg:{get:k=>k==='workspace'?workspace:undefined}});
  assert.equal(grab.ok,true,'real screen.capture failed: '+JSON.stringify(grab.error||grab).slice(0,300));
  assert.equal(grab.meta?.validatedPng,true);
  const signature=fs.readFileSync(path.join(workspace,'qa-frame.png')).subarray(0,8);
  assert.deepEqual([...signature],[137,80,78,71,13,10,26,10]);
  verdict.screenCaptureVerified=true;
  console.log('W11 WINDOWS ACTUAL POINTER + SCREEN CAPTURE PASS: restored cursor, PNG verified in isolated QA');

  console.log('W11 SYNTHETIC GUI PASS: MAJIN real control.list/type/read/click, and saved bytes match');

  // Exercise MAJIN's actual OBSERVE→PLAN→ACT→VERIFY engine against that SAME
  // visible QA window. The trusted deterministic planner is injected only by
  // the harness; production always uses a configured cloud provider.
  const controlledRegistry = { exec: async (name, args) => {
    if (name === 'screen.capture') return {ok:false,error:{code:'qa_privacy',message:'Never capture unrelated desktop screenshots in this test'}};
    const t=winControlTools.find(v=>v.name===name);
    if (!t) return {ok:false,error:{code:'not_allowlisted',message:'QA only allows Win32 control tools'}};
    if (name === 'control.list_windows') {
      // Do not send private window titles to the cloud: only expose the one
      // newly created synthetic QA window, even when the PC has other apps.
      const r=await t.run({});
      if (!r.ok) return r;
      const windows=(r.meta?.windows || []).filter(w=>w.title===title);
      return {ok:true,meta:{windows},result:windows.length+' synthetic QA window'};
    }
    if (args?.window !== title) return {ok:false,error:{code:'qa_out_of_scope',message:'ONLY the synthetic MAJIN QA window may be controlled'}};
    return t.run(args||{});
  }};
  const agentText='MAJIN_AGENT_GUI_'+nonce;
  const plans=[
    {action:'type',window:title,text:agentText,verify:{type:'read_contains',window:title,text:agentText}},
    {action:'click_button',window:title,caption:'Save QA',verify:{type:'read_contains',window:title,text:agentText}},
    {action:'done',verify:{type:'read_contains',window:title,text:agentText}},
  ];
  let planIndex=0;
  const computer = computerTools.find(t=>t.name==='computer.use');
  assert.ok(computer,'computer.use must be an actual registered tool');
  const goal='In the disposable '+title+' QA form, replace text with '+agentText+' and click Save QA. Independently verify text.';
  const completed=await computer.run({goal,maxSteps:'5'},{session:'majin-owner-qa',
    cfg:{get:key=>key==='workspace'?workspace:undefined},
    registry:controlledRegistry,
    desktopModelCall:async()=>plans[planIndex++] || {action:'blocked',reason:'QA plan exhausted'},
    emit:()=>{},
  });
  assert.equal(completed.ok,true,JSON.stringify(completed.error||completed).slice(0,400));
  assert.equal(completed.meta?.verified,true);
  assert.equal(planIndex,3,'all three agent actions must have executed');
  assert.equal(fs.readFileSync(savedFile,'utf8'),agentText,'computer.use agent click must persist verified GUI bytes');
  verdict.computerUseVerified=true;
  console.log('W11 COMPUTER.USE LIVE ENGINE PASS: observe -> Win32 type -> click -> verified completion and saved bytes');

  // Finally: real OpenCode Go inference, but model-visible perception is ONLY
  // this synthetic test form. Neither other window titles nor screenshots
  // reach the cloud; every selected action is again target-restricted.
  const goKey=String(process.env.OPENCODE_API_KEY || '');
  if (goKey) {
    const cfgData=clone(DEFAULTS);
    cfgData.workspace=workspace;
    cfgData.providers.opencode.apiKey=goKey;
    cfgData.models.routes.tools='opencode/glm-5.3-flash';
    const cloudText='MAJIN_REAL_GO_GUI_'+nonce;
    const cloudGoal='In the ONLY available synthetic window "'+title+'", type EXACTLY "'+cloudText+
      '" in its text box, then CLICK the button labeled "Save QA", then verify the text field contains the exact value. '+
      'Do not touch any other application. Do not say done until both typing AND clicking were performed.';
    const timeout=AbortSignal.timeout(110000);
    const cloud=await computer.run({goal:cloudGoal,maxSteps:'7'},{session:'owner-majin-go-'+nonce,
      cfg:new Config(cfgData),registry:controlledRegistry,emit:()=>{},signal:timeout,
    });
    if (!cloud.ok) {
      // Only the synthetic allowlisted window is exposed. Record no private
      // screenshots, raw provider responses or unrelated window titles.
      let trace=[];
      try {
        trace=fs.readFileSync(path.join(cloud.meta?.evidence||'','steps.jsonl'),'utf8')
          .split('\n').filter(Boolean).map(JSON.parse)
          .map(x=>({phase:x.phase,step:x.step,action:x.action,tool:x.tool,ok:x.ok,
            error:x.error,reason:x.reason,note:x.note,rawAction:x.raw?.action||null}));
      } catch {}
      verdict.cloudTrace=trace.slice(-18);
      console.log('GO_DESKTOP_TRACE '+JSON.stringify(verdict.cloudTrace).slice(-3000));
    }
    assert.equal(cloud.ok,true,'Real OpenCode Go desktop planner failed: '+JSON.stringify(cloud.error||cloud).slice(0,350));
    assert.equal(fs.readFileSync(savedFile,'utf8'),cloudText,
      'Go planner did not actually click Save QA after entering the chosen text');
    verdict.computerUseCloudVerified=true;
    console.log('W11 REAL GO COMPUTER.USE PASS: OpenCode Go planned actual Win32 actions, verified typed text AND saved bytes');
  } else {
    verdict.computerUseCloudCoverage='NOT_VERIFIED_NO_GITHUB_SECRET';
    console.log('W11 GO MODEL NOT VERIFIED: OPENCODE_API_KEY not configured on runner');
  }


  // Independent negative control: an unprivileged topmost QA form has a
  // synthetic hot-pink background. If this is invisible to CopyFromScreen,
  // a locked/disconnected virtual desktop cannot prove ANY overlay pixel.
  const pixelCanary=colorCount(180,105);
  assert.ok(pixelCanary>=12, 'Desktop pixel capture is unavailable even for the synthetic QA window ('+pixelCanary+' pink samples); interactive process != visible unlocked display');
  verdict.desktopPixelCanary=true;
  console.log('REAL SCREEN PIXEL CANARY PASS: verified synthetic QA window pixels only');
  // The canary fixture uses a pink background and should not hide or impersonate
  // the actual overlay. Close the synthetic window BEFORE W12 sampling.
  if (app?.pid) { try { app.kill(); } catch {} }
  await sleep(650);



  const dimsScript = 'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ($b.Width.ToString()+","+$b.Height.ToString())';
  const dims=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',dimsScript],{encoding:'utf8',timeout:12000,windowsHide:true});
  assert.equal(dims.status,0,dims.stderr);
  const [width,height]=String(dims.stdout).trim().split(/\s+/).at(-1).split(',').map(Number);
  assert.ok(width>=800 && height>=600,'interactive screen is too small for cropped W12 probe');
  const x1=Math.min(Math.floor(width*0.24),width-230);
  const y1=Math.min(Math.floor(height*0.28),height-80);
  const x2=Math.min(Math.floor(width*0.58),width-230);
  const y2=Math.min(Math.floor(height*0.52),height-80);
  assert.ok(Math.abs(x2-x1)>120&&Math.abs(y2-y1)>80,'screen targets overlap');

  await cursor(workspace,{op:'move',x:x1,y:y1,label:'MAJIN QA ONE'});
  pinkStarted=true;
  await sleep(2400);
  const first=colorCount(x1,y1);
  if (first < 12) {
    const initial=colorCount(100,100);
    // Diagnose a real PowerShell overlay startup failure while retaining NO
    // screenshots. A direct second launch exposes parser/runtime diagnostics
    // that the normal detached, stdio-ignored overlay process cannot report.
    const psFile=cursorPaths(workspace).ps1;
    const stateFile=cursorPaths(workspace).state;
    let output='', err='';
    const diag=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',psFile,'-StateFile',stateFile],
      {windowsHide:true,stdio:['ignore','pipe','pipe']});
    diag.stdout?.on('data',d=>{output+=String(d).slice(0,1500);});
    diag.stderr?.on('data',d=>{err+=String(d).slice(0,1500);});
    await sleep(1100);
    const stopped=diag.exitCode;
    try{diag.kill();}catch{}
    const diagnostic=(err||output).replace(/C:\\\\Users\\\\[^\\\\]+/gi,'C:Users:[redacted]').slice(0,600);
    throw new Error('W12 overlay no screen pixels ('+first+'), initial position pink='+initial+'; process='+JSON.stringify(overlayStatus())+'; direct PS exit='+String(stopped)+'; diagnostic='+diagnostic);
  }
  assert.ok(first>=12,'W12 overlay not visible at first target ('+first+' pink samples)');
  verdict.pinkVisible=true;

  await cursor(workspace,{op:'move',x:x2,y:y2,label:'MAJIN QA TWO'});
  await sleep(2600);
  const second=colorCount(x2,y2);
  const former=colorCount(x1,y1);
  assert.ok(second>=12,'W12 overlay not visible at second target ('+second+')');
  assert.ok(former < Math.max(8,first*0.3),'W12 overlay did not leave first target ('+former+' remaining)');
  verdict.pinkMoved=true;

  const saved = JSON.parse(fs.readFileSync(cursorPaths(workspace).state,'utf8'));
  assert.equal(saved.label,'MAJIN QA TWO');
  verdict.pinkStateLabel=true;

  await cursor(workspace,{op:'hide'});
  await sleep(650);
  const hidden=colorCount(x2,y2);
  assert.ok(hidden<8,'W12 hide did not remove cursor from screen ('+hidden+')');
  verdict.pinkHidden=true;
  await cursor(workspace,{op:'quit'});
  console.log('W12 REAL PIXEL PASS: pink cursor appeared, moved, updated state and disappeared');
  verdict.status='PASS';
} catch(e) {
  verdict.status='FAIL';
  verdict.reason=String(e?.message||e).slice(0,450);
  console.error('OWNER DESKTOP ACCEPTANCE FAIL:',verdict.reason);
  process.exitCode=1;
} finally {
  if (pinkStarted) {
    try { await cursor(workspace,{op:'quit'}); } catch{}
  }
  if (app?.pid) { try { app.kill(); } catch{} }
  try { fs.rmSync(workspace,{recursive:true,force:true}); } catch{}
  saveEvidence();
  console.log('OWNER_DESKTOP_VERDICT '+JSON.stringify(verdict));
}
