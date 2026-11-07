// Local controlled-browser UI test; not physical iPhone notification acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestServer} from './helpers.mjs';

test('unpaired mobile never requests private heartbeat settings; pairing loads controls without a reload',async t=>{
  const {chromium}=await import('playwright');let browser;
  try{browser=await chromium.launch(process.env.MAJIN_E2E_CHROMIUM?{executablePath:process.env.MAJIN_E2E_CHROMIUM}:{});}catch(error){if(process.env.MAJIN_E2E_CHROMIUM)throw error;t.skip('Chromium unavailable');return;}
  const s=await startTestServer();t.after(async()=>{await browser.close();await s.close();});
  await s.context.heartbeat.manage({action:'pause'});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage(),requests=[],errors=[];
  page.on('request',req=>{if(new URL(req.url()).pathname==='/api/heartbeat')requests.push(req.url());});
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(s.base,{waitUntil:'networkidle'});await page.locator('#gate').waitFor({state:'visible'});
  assert.deepEqual(requests,[],'no private heartbeat GET while pairing is required');assert.deepEqual(errors,[]);
  await page.locator('#gate-code').fill(s.context.pairingFresh);await page.locator('#gate-submit').tap();
  await page.locator('#gate').waitFor({state:'hidden'});await page.locator('#menu-btn').tap();
  await page.locator('#heartbeat-resume').waitFor({state:'visible'});assert.ok(requests.length>=1);
  await page.locator('#heartbeat-resume').tap();await page.waitForFunction(()=>document.querySelector('#heartbeat-status').textContent==='Background updates resumed.');
  assert.equal(s.context.heartbeat.view().running,true);assert.deepEqual(errors,[]);
});

test('heartbeat controls resume paused collection and persist explicit push choice in the existing menu',async t=>{
  const {chromium}=await import('playwright');let browser;
  try{browser=await chromium.launch(process.env.MAJIN_E2E_CHROMIUM?{executablePath:process.env.MAJIN_E2E_CHROMIUM}:{});}catch(error){if(process.env.MAJIN_E2E_CHROMIUM)throw error;t.skip('Chromium unavailable');return;}
  const s=await startTestServer();
  t.after(async()=>{await browser.close();await s.close();});
  await s.context.heartbeat.manage({action:'pause'});
  const cookie=s.existingSession(),eq=cookie.indexOf('='),context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addCookies([{name:cookie.slice(0,eq),value:cookie.slice(eq+1),url:s.base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(s.base);await page.locator('#menu-btn').click();
  await page.locator('#heartbeat-resume').waitFor({state:'visible'});
  await page.locator('#heartbeat-resume').tap();
  await page.waitForFunction(()=>document.querySelector('#heartbeat-status').textContent==='Background updates resumed.');
  assert.equal(s.context.heartbeat.view().running,true);
  await page.locator('#heartbeat-notify').check();
  await page.waitForFunction(()=>document.querySelector('#heartbeat-status').textContent.startsWith('Notifications enabled'));
  assert.equal(s.context.heartbeat.view().notify,true);
  assert.equal(await page.locator('#hero-title').textContent(),'Majin lets run it.');assert.deepEqual(errors,[]);
});
