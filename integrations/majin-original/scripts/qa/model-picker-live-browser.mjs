#!/usr/bin/env node
/**
 * Actual Chromium + production MAJIN HTTP server + real config.json.
 * Verifies users can select OpenCode Go instead of Zen and retain the
 * exact provider/model across tab reload and a FULL server restart.
 * Never calls provider inference; model catalog is served offline.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-model-ui-restart-'));
const port=21440+Math.floor(Math.random()*1800);
const env={...process.env,MAJIN_HOME:home,MAJIN_PORT:String(port),MAJIN_NO_UPDATE_CHECK:'1'};
let child=null,browser=null,page=null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function server() {
  child=spawn(process.execPath,['src/cli/majin.js','_serve','--no-window','--no-channels'],{
    env,stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.on('data',d=>output+=String(d));
  child.stderr.on('data',d=>output+=String(d));
  for(let i=0;i<110 && !output.includes('listening on');i++){
    if(child.exitCode!==null)throw Error('MAJIN server quit: '+output.slice(-1000));
    await delay(100);
  }
  assert.ok(output.includes('listening on'),'MAJIN server did not start: '+output.slice(-900));
}
async function stopServer(){
  if(!child)return;
  const proc=child;
  child=null;
  if(proc.exitCode===null){
    try{proc.kill('SIGTERM')}catch{}
    await Promise.race([
      new Promise(resolve=>proc.once('exit',resolve)),
      delay(1800),
    ]);
    if(proc.exitCode===null)try{proc.kill('SIGKILL')}catch{}
  }
}
async function pageOpen(){
  const data=JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8'));
  await page.goto('http://127.0.0.1:'+port+'/?t='+encodeURIComponent(data.server.token));
  await page.waitForFunction(()=>Boolean(window.MAJIN_ONBOARD && document.querySelector('#home')));
  const skip=page.locator('#ob-skip');
  if(await skip.isVisible())await skip.click();
}
const dest=(model)=>'opencode/'+model;
try{
  await server();
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/api/models?**',req=>req.fulfill({json:{ok:true,catalog:[],models:[]}}));
  await pageOpen();
  await page.locator('#c-model').click();
  await page.waitForFunction(()=>document.querySelector('#modeldrop')?.hidden===false);
  await page.getByRole('combobox',{name:'Provider'}).selectOption('opencode');
  // The exact-ID input intentionally lives in a collapsed disclosure; open
  // the real user-facing control instead of trying to fill a hidden field.
  await page.getByText('Use an exact model ID',{exact:true}).click();
  await page.getByRole('textbox',{name:'Exact model ID'}).fill('glm-5.3-flash');
  await page.getByRole('button',{name:'Use this ID'}).click();
  await page.waitForFunction(()=>document.querySelector('#modeldrop')?.hidden===true,{timeout:10000});
  assert.match(await page.locator('#c-model').innerText(),/OpenCode Go/);
  assert.match(await page.locator('#c-model').innerText(),/glm-5\.3-flash/);
  assert.doesNotMatch(await page.locator('#c-model').innerText(),/Zen/);

  const first=JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8'));
  assert.equal(first.models.provider,'opencode');
  assert.ok(Object.values(first.models.routes).every(ref=>ref===dest('glm-5.3-flash')));
  assert.equal(first.moa.policy,'off');
  console.log('PROOF first selection: OpenCode Go and all routes written to disk');

  await page.reload();
  await page.waitForFunction(()=>Boolean(window.MAJIN_ONBOARD && window.S?.st?.routes?.length));
  assert.match(await page.locator('#c-model').innerText(),/OpenCode Go/);
  assert.match(await page.locator('#c-model').innerText(),/glm-5\.3-flash/);
  console.log('PROOF browser reload: selection stays visible');

  // A fresh MAJIN process must reload the same disk config, not fall back
  // silently to DeepSeek or OpenCode Zen.
  await stopServer();
  await server();
  await pageOpen();
  await page.waitForFunction(()=>window.S?.st?.routes?.find(r=>r.job==='chat')?.ref==='opencode/glm-5.3-flash');
  assert.match(await page.locator('#c-model').innerText(),/OpenCode Go/);
  assert.match(await page.locator('#c-model').innerText(),/glm-5\.3-flash/);
  const after=JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8'));
  assert.equal(after.models.provider,'opencode');
  assert.ok(Object.values(after.models.routes).every(ref=>ref==='opencode/glm-5.3-flash'));
  console.log('PROOF full server restart: exact Go model and routes retained; 0 paid inference calls');
}finally{
  try{await page?.close()}catch{}
  try{await browser?.close()}catch{}
  await stopServer();
  fs.rmSync(home,{recursive:true,force:true});
}
