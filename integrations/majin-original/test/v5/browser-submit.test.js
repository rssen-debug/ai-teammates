import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { CodexDriver } from '../../src/v5/codex-driver.js';
import { createDriverTools } from '../../src/v5/codex-tools.js';
import { FileAndAccessController } from '../../src/v5/files-access.js';
import { browserWriteAllowed } from '../../src/core/tools/browser.js';
import { verifyPixel } from '../../src/v2/runtime/verifiers.js';

test('browser write grants match exact origins and cannot be escalated by a subdomain or URL credentials', () => {
  const ctx = { browserWriteOrigins: ['https://employer.example'] };
  assert(browserWriteAllowed(ctx, 'https://employer.example/apply'));
  assert(!browserWriteAllowed(ctx, 'https://employer.example.attacker.test/apply'));
  assert(!browserWriteAllowed(ctx, 'https://other.example/apply'));
  assert(!browserWriteAllowed(ctx, 'https://user:pass@employer.example/apply'));
  assert(!browserWriteAllowed({}, 'https://employer.example/apply'));
});

test('real browser submits exact file bytes only for owner-granted origin; radio/select and idless controls work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-submit-'));
  const expected = Buffer.from('CV FIXTURE ' + randomUUID());
  fs.writeFileSync(path.join(root, 'cv.pdf'), expected);
  let received = null, foreignWrites = 0;
  const foreign = http.createServer((req,res) => { if(req.method==='POST')foreignWrites++; res.end('foreign'); });
  await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
  const foreignOrigin=`http://127.0.0.1:${foreign.address().port}`;
  const portal = http.createServer(async(req,res)=>{
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const form=await new Request('http://localhost/receive',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
      const file=form.get('cv');received={radio:form.get('answer'),choice:form.get('choice'),name:form.get('name'),bytes:Buffer.from(await file.arrayBuffer())};
      res.end('APPLICATION RECEIVED');return;
    }
    res.setHeader('content-type','text/html');
    res.end(`<h1>Owned test portal</h1><form method="post" enctype="multipart/form-data"><label>Name<input name="name" required></label>
      <label><input type="radio" name="answer" value="yes" required>Yes</label><label><input type="radio" name="answer" value="no">No</label>
      <select name="choice"><option value="one">One</option><option value="two">Two</option></select><input type="file" name="cv" required>
      <div><span>Layout</span><button type="submit">Send</button></div></form>
      <div><button type="button" onclick="fetch('${foreignOrigin}/steal',{method:'POST',body:'no'})">Foreign write</button></div>`);
  });
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${portal.address().port}`;
  let driver;
  t.after(async()=>{await driver?.close();portal.closeAllConnections();foreign.closeAllConnections();await Promise.all([new Promise(r=>portal.close(r)),new Promise(r=>foreign.close(r))]);fs.rmSync(root,{recursive:true,force:true});});
  driver=new CodexDriver({workspace:root,stateDir:path.join(root,'state'),browser:true,browserWriteOrigins:[]});
  await driver.start();
  if(!driver.list().some(row=>row.name==='browser_open')){t.skip('No installed Chromium/Edge on this runner');return;}
  const call=async(name,args={})=>driver.call(name,{...args,operationId:randomUUID()});
  await call('browser_open',{url:origin});
  const blocked=await call('browser_click',{selector:'button[type="submit"]'});
  assert.equal(blocked.isError,true);assert.equal(received,null);
  await driver.close();
  driver=new CodexDriver({workspace:root,stateDir:path.join(root,'state'),browser:true,browserWriteOrigins:[origin]});await driver.start();
  await call('browser_open',{url:origin});
  const inspection=(await call('browser_inspect')).structuredContent.result.result;
  const controls=JSON.parse(inspection.split('max 100):\n')[1].split('\n\nLinks:')[0]);
  const submit=controls.find(control=>control.text==='Send');
  assert(submit.selector.includes('nth-of-type'), 'idless button gets a real unique CSS path');
  const radio=controls.find(control=>control.name==='answer'&&control.value==='yes');
  assert.equal((await call('browser_check',{selector:radio.selector})).isError,false);
  await call('browser_fill',{selector:'input[name="name"]',value:'Fixture User'});
  await call('browser_select',{selector:'select[name="choice"]',value:'two'});
  await call('browser_upload',{selector:'input[name="cv"]',filePath:'cv.pdf'});
  await call('browser_click',{selector:'button:has-text("Foreign write")'});
  assert.equal(foreignWrites,0);
  assert.equal((await call('browser_click',{selector:submit.selector})).isError,false);
  assert(received);assert.equal(received.radio,'yes');assert.equal(received.choice,'two');assert.equal(received.name,'Fixture User');
  assert.equal(createHash('sha256').update(received.bytes).digest('hex'),createHash('sha256').update(expected).digest('hex'));
  assert.match((await call('browser_inspect')).structuredContent.result.result,/APPLICATION RECEIVED/);
});

test('persisted browser origin grants and revocations are reread for the already-open page', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-dynamic-origin-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const access = new FileAndAccessController({ dataDir, workspaceDir: workspace });
  access.enableOwnerMode({ lanes: ['browser'], folders: [workspace] });

  const submissions = [];
  const portal = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      submissions.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      res.setHeader('content-type', 'text/html');
      res.end('<h1>DYNAMIC RECEIVED</h1><a href="/">Again</a>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Dynamic portal</h1><form method="post" action="/submit"><label>Name <input name="name" required></label><button type="submit">Send</button></form>');
  });
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${portal.address().port}`;

  const tools = await createDriverTools({
    workspace,
    allowedFolders: [workspace],
    grantedLanes: ['browser'],
    browser: true,
    browserWriteOrigins: [],
    browserWriteOriginsFile: access.ownerMode.file,
    browserVisible: false,
  });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    portal.closeAllConnections();
    await new Promise(resolve => portal.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }

  const succeeded = (result) => result.ok !== false && !result.error;
  assert.equal(succeeded(await run('browser_open', { url: origin })), true);
  assert.equal(succeeded(await run('browser_fill', { selector: 'input[name="name"]', value: 'Dynamic User' })), true);
  const captureError = async (promise) => {
    try { await promise; assert.fail('expected the browser action to be blocked'); }
    catch (error) { return error; }
  };
  const blocked = await captureError(run('browser_click', { selector: 'button[type="submit"]' }));
  assert.equal(blocked.code, 'BROWSER_ORIGIN_GRANT_REQUIRED');
  assert.equal(blocked.meta.ownerHandoff.origin, origin);
  assert.deepEqual(submissions, []);

  access.grantBrowserOrigins([`${origin}/submit`]);
  const statusAfterGrant = (await run('driver_status')).result;
  assert.deepEqual(statusAfterGrant.browserWriteOrigins, [origin]);
  assert.equal(succeeded(await run('browser_click', { selector: 'button[type="submit"]' })), true);
  assert.match((await run('browser_inspect')).result, /DYNAMIC RECEIVED/);
  assert.deepEqual(submissions, [{ name: 'Dynamic User' }], 'granting the origin did not require reopening or refilling the page');

  access.revokeBrowserOrigins([origin]);
  assert.equal(succeeded(await run('browser_open', { url: origin })), true);
  assert.equal(succeeded(await run('browser_fill', { selector: 'input[name="name"]', value: 'Should Not Submit' })), true);
  const blockedAfterRevoke = await captureError(run('browser_click', { selector: 'button[type="submit"]' }));
  assert.equal(blockedAfterRevoke.code, 'BROWSER_ORIGIN_GRANT_REQUIRED');
  assert.deepEqual(submissions, [{ name: 'Dynamic User' }], 'revocation is also effective without recreating the tool context');
});

test('browser_shot captures real PNG evidence that the pixel verifier can independently prove', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-browser-shot-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const page = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><body style="margin:0"><div style="width:100vw;height:100vh;background:rgb(12,34,56)"></div></body>');
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${page.address().port}`;
  const tools = await createDriverTools({ workspace, grantedLanes: ['browser'], browser: true, browserVisible: false });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    page.closeAllConnections();
    await new Promise(resolve => page.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }
  assert.equal(tools.has('browser_shot'), true, 'the Playwright surface must include screenshots');

  await run('browser_open', { url: origin });
  const shot = await run('browser_shot', { path: 'page-shot.png' });
  const pngPath = path.join(workspace, 'page-shot.png');
  assert.equal(shot.meta.path, pngPath);
  const bytes = fs.readFileSync(pngPath);
  assert.equal(bytes.length, shot.meta.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.meta.sha256);
  assert.equal(shot.image?.mimeType, 'image/png', 'the driver must attach the PNG for provider vision');
  assert.equal(Buffer.from(shot.image.data, 'base64').length, shot.meta.bytes);
  const proof = verifyPixel({ pngPath, rgba: [12, 34, 56, 255], tolerance: 2, minHits: 1000 });
  assert.equal(proof.verified, true, JSON.stringify(proof.error || proof.evidence));

  const again = await run('browser_shot', { ifChanged: 'true' });
  assert.equal(again.meta.unchanged, true);
  assert.equal(again.meta.path, pngPath);
});

test('Set-of-Marks refs click deterministically, stale refs are refused, and clear_marks forgets refs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-browser-marks-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const page = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><h1>Marks fixture</h1>
      <button id="advance" type="button" onclick="this.textContent='Done';document.querySelector('#state').textContent='REF CLICKED'">Advance</button>
      <div id="state">WAITING</div>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${page.address().port}`;
  const tools = await createDriverTools({ workspace, grantedLanes: ['browser'], browser: true, browserVisible: false });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    page.closeAllConnections();
    await new Promise(resolve => page.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }
  assert.equal(tools.has('browser_clear_marks'), true);

  await run('browser_open', { url: origin });
  const grounded = await run('browser_inspect', { marks: true });
  const ref = /\[(e[0-9]+)\] button "Advance"/.exec(grounded.result)?.[1];
  assert.ok(ref, `inspect must return a grounded Advance ref:\n${grounded.result}`);
  assert.ok(grounded.meta.marks >= 1);
  assert.deepEqual(grounded.meta.refs.includes(ref), true);

  const clicked = await run('browser_click', { ref });
  assert.equal(clicked.meta.ref, ref);
  assert.match((await run('browser_inspect')).result, /REF CLICKED/);

  await assert.rejects(
    run('browser_click', { ref }),
    (error) => error.code === 'ref_stale' && /ref_stale/.test(error.message),
    'the same ref must not silently click after the element label changed',
  );

  const regrounded = await run('browser_inspect', { marks: true });
  const freshRef = /\[(e[0-9]+)\] button "Done"/.exec(regrounded.result)?.[1];
  assert.ok(freshRef, `re-inspection must ground the changed button:\n${regrounded.result}`);
  const cleared = await run('browser_clear_marks');
  assert.ok(cleared.meta.marks >= 1, JSON.stringify(cleared.meta));
  assert.ok(cleared.meta.refs >= 1, JSON.stringify(cleared.meta));
  await assert.rejects(
    run('browser_click', { ref: freshRef }),
    (error) => error.code === 'ref_unknown' && /ref_unknown/.test(error.message),
    'cleared refs must be forgotten instead of remaining clickable',
  );
});

test('browser_verify asserts real post-action page outcomes and fails honestly before the effect', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-browser-verify-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const page = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Verify fixture</title><h1>Verify fixture</h1>
      <button id="go" type="button" onclick="setTimeout(()=>{document.querySelector('#state').textContent='READY';document.querySelector('#consent').checked=true;this.disabled=true;},250)">Go</button>
      <label>Consent <input type="checkbox" id="consent"></label>
      <div id="state">WAITING</div>
      <ul><li>one</li><li>two</li></ul>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${page.address().port}`;
  const tools = await createDriverTools({ workspace, grantedLanes: ['browser'], browser: true, browserVisible: false });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    page.closeAllConnections();
    await new Promise(resolve => page.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }
  assert.equal(tools.has('browser_verify'), true);

  await run('browser_open', { url: origin });
  const premature = await run('browser_verify', { selector: '#state', text: 'READY', waitMs: 0 });
  assert.equal(premature.ok, false, 'verify must not invent the outcome before the click');
  assert.equal(premature.error.code, 'assertion_failed');
  assert.ok(premature.error.failures.some((failure) => failure.name === 'element_text_contains'));
  assert.ok(premature.meta.recovery.action, 'a failed assertion must carry a grounded recovery action');

  const badExpectation = await run('browser_verify', {});
  assert.equal(badExpectation.ok, false);
  assert.equal(badExpectation.error.code, 'bad_expectation');

  await run('browser_click', { selector: '#go' });
  const ready = await run('browser_verify', { selector: '#state', text: 'READY', urlPath: '/', title: 'Verify fixture', stableMs: 200 });
  assert.notEqual(ready.ok, false, JSON.stringify(ready.error || ready.meta));
  assert.ok(ready.meta.assertions.some((assertion) => assertion.name === 'element_text_contains' && assertion.actual === true));
  assert.ok(ready.meta.assertions.some((assertion) => assertion.name === 'url_path_exact' && assertion.actual === true));
  assert.notEqual((await run('browser_verify', { selector: '#consent', checked: true })).ok, false);
  assert.notEqual((await run('browser_verify', { selector: '#go', enabled: false })).ok, false);
  const counted = await run('browser_verify', { selector: 'li', count: 2 });
  assert.notEqual(counted.ok, false, JSON.stringify(counted.error || counted.meta));
  assert.ok(counted.meta.assertions.some((assertion) => assertion.name === 'element_count_exact' && assertion.actual === 2));
  const wrongOrigin = await run('browser_verify', { urlOrigin: 'https://example.invalid', waitMs: 0 });
  assert.equal(wrongOrigin.ok, false, 'an exact-origin assertion must fail on a different origin');
});

test('browser_download saves exact bytes into the workspace and browser_tabs lists, switches and closes real tabs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-browser-download-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const payload = Buffer.from(`DOWNLOAD FIXTURE ${randomUUID()}`);
  const page = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="report.txt"');
      res.end(payload);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/second') {
      res.end('<!doctype html><title>Second</title><h1 id="state">SECOND PAGE</h1>');
      return;
    }
    res.end(`<!doctype html><title>First</title><h1>FIRST PAGE</h1>
      <a id="dl" href="/file">Download report</a>
      <a id="tablink" href="/second" target="_blank" rel="noopener">Open second</a>
      <button id="plain" type="button">Plain</button>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${page.address().port}`;
  const tools = await createDriverTools({ workspace, grantedLanes: ['browser'], browser: true, browserVisible: false });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    page.closeAllConnections();
    await new Promise(resolve => page.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }
  assert.equal(tools.has('browser_download'), true);
  assert.equal(tools.has('browser_tabs'), true);

  await run('browser_open', { url: origin });
  const noDownload = await run('browser_download', { selector: '#plain', timeoutMs: 400 });
  assert.equal(noDownload.ok, false, 'a click that starts no download must not be reported as a saved file');
  assert.equal(noDownload.error.code, 'download_timeout');

  const downloaded = await run('browser_download', { selector: '#dl', path: 'downloads/report.txt' });
  assert.notEqual(downloaded.ok, false, JSON.stringify(downloaded.error || downloaded.meta));
  const savedPath = path.join(workspace, 'downloads', 'report.txt');
  assert.equal(downloaded.meta.path, savedPath);
  assert.equal(downloaded.meta.suggestedFilename, 'report.txt');
  assert.deepEqual(fs.readFileSync(savedPath), payload);
  assert.equal(downloaded.meta.bytes, payload.length);
  assert.equal(downloaded.meta.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.equal(downloaded.meta.source, `${origin}/file`);

  await run('browser_click', { selector: '#tablink' });
  let tabs = (await run('browser_tabs', {})).meta.tabs;
  for (let attempt = 0; attempt < 20 && tabs.length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    tabs = (await run('browser_tabs', {})).meta.tabs;
  }
  assert.equal(tabs.length, 2, `expected the target=_blank click to open a second tab: ${JSON.stringify(tabs)}`);
  const second = tabs.find(tab => tab.url.endsWith('/second'));
  assert.ok(second, JSON.stringify(tabs));
  assert.equal(tabs.find(tab => tab.active).url, `${origin}/`, 'opening a tab must not silently move the active page');

  const switched = await run('browser_tabs', { action: 'switch', index: second.index });
  assert.equal(switched.meta.activeIndex, second.index);
  assert.notEqual((await run('browser_verify', { selector: '#state', text: 'SECOND PAGE' })).ok, false);

  const closed = await run('browser_tabs', { action: 'close', index: second.index });
  assert.equal(closed.meta.tabs.length, 1);
  assert.match((await run('browser_inspect')).result, /FIRST PAGE/, 'closing the active tab must fall back to the remaining page');
});

test('frame-scoped inspect, fill, click, check, verify and download work inside a real cross-origin iframe', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-browser-frame-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const framePayload = Buffer.from(`FRAME DOWNLOAD ${randomUUID()}`);
  const frameApp = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="frame.txt"');
      res.end(framePayload);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Frame app</title><h1>FRAME APP</h1>
      <label>Name <input id="name" name="name"></label>
      <button id="go" type="button" onclick="document.getElementById('state').textContent='SAVED '+document.getElementById('name').value">Save name</button>
      <label>Consent <input id="consent" type="checkbox"></label>
      <a id="dl" href="/file">Download frame file</a>
      <output id="state">IDLE</output>`);
  });
  await new Promise(resolve => frameApp.listen(0, '127.0.0.1', resolve));
  const frameOrigin = `http://127.0.0.1:${frameApp.address().port}`;
  const shell = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Shell</title><h1>SHELL PAGE</h1><iframe id="app" src="${frameOrigin}/frame" width="600" height="400"></iframe>`);
  });
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  const shellOrigin = `http://127.0.0.1:${shell.address().port}`;
  assert.notEqual(shellOrigin, frameOrigin, 'fixture must be genuinely cross-origin');
  const tools = await createDriverTools({ workspace, grantedLanes: ['browser'], browser: true, browserVisible: false });
  const run = async (name, args = {}) => tools.get(name).run(args);
  t.after(async () => {
    try { await run('browser_close'); } catch { /* browser may not have opened on a skipped runner */ }
    for (const srv of [shell, frameApp]) { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed Chromium/Edge on this runner'); return; }

  await run('browser_open', { url: shellOrigin });
  const shellInspect = await run('browser_inspect', {});
  assert.equal(shellInspect.meta.frames, 1, shellInspect.result);
  assert.match(shellInspect.result, /"selector":"#app"/);
  assert.ok(!shellInspect.result.includes('FRAME APP'), 'main-document inspect must not pretend to see cross-origin frame content');

  await assert.rejects(
    run('browser_fill', { frame: '#nope', selector: '#name', value: 'Ada' }),
    /no iframe matched frame selector: #nope/,
    'an unknown frame selector must fail honestly, not fall back to the main document');

  const frameInspect = await run('browser_inspect', { frame: '#app', marks: true });
  assert.equal(frameInspect.meta.frameUrl, `${frameOrigin}/frame`);
  assert.match(frameInspect.result, /FRAME APP/);
  assert.ok(frameInspect.meta.marks > 0, 'Set-of-Marks grounding must run inside the iframe document');
  const saveRef = String(frameInspect.result).split('\n').find(line => line.includes('Save name') && /\be\d+\b/.test(line))?.match(/\be\d+\b/)?.[0];
  assert.ok(saveRef, `expected a grounded ref for the in-frame button:\n${frameInspect.result.slice(-1500)}`);

  await run('browser_fill', { frame: '#app', selector: '#name', value: 'Ada' });
  assert.equal((await run('browser_verify', { frame: '#app', selector: '#state', text: 'SAVED', waitMs: 0 })).ok, false);
  await run('browser_click', { frame: '#app', ref: saveRef });
  assert.notEqual((await run('browser_verify', { frame: '#app', selector: '#state', text: 'SAVED Ada' })).ok, false);

  await run('browser_check', { frame: '#app', selector: '#consent', checked: true });
  assert.notEqual((await run('browser_verify', { frame: '#app', selector: '#consent', checked: true })).ok, false);

  const downloaded = await run('browser_download', { frame: '#app', selector: '#dl', path: 'downloads/frame.txt' });
  assert.notEqual(downloaded.ok, false, JSON.stringify(downloaded.error || downloaded.meta));
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'downloads', 'frame.txt')), framePayload);

  const cleared = await run('browser_clear_marks', { frame: '#app' });
  assert.notEqual(cleared.ok, false);
});

test('explicit full browser grant submits to a new origin and live revocation blocks the next submit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-full-browser-'));
  const access = new FileAndAccessController({ dataDir: root });
  access.ownerMode.grant({ lanes: ['browser'], fullAccess: true });
  let submissions = 0;
  const portal = http.createServer((req, res) => {
    if (req.method === 'POST') { submissions++; req.resume(); res.end('<h1>RECEIVED</h1>'); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<form method="post"><input name="name"><button type="submit">Send</button></form>');
  });
  await new Promise(r => portal.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${portal.address().port}`;
  const tools = await createDriverTools({ workspace: access.workspaceDir, grantedLanes: ['browser'], browser: true,
    browserVisible: false, browserWriteOriginsFile: access.ownerMode.file });
  t.after(async () => {
    try { await tools.get('browser_close')?.run({}); } catch {}
    portal.closeAllConnections(); await new Promise(r => portal.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!tools.has('browser_open')) { t.skip('No installed browser on this runner'); return; }
  await tools.get('browser_open').run({ url: origin });
  await tools.get('browser_fill').run({ selector: 'input', value: 'Fixture applicant' });
  await tools.get('browser_click').run({ selector: 'button' });
  assert.equal(submissions, 1);
  access.revokeBrowserOrigins();
  await tools.get('browser_open').run({ url: origin });
  await assert.rejects(tools.get('browser_click').run({ selector: 'button' }), { code: 'BROWSER_ORIGIN_GRANT_REQUIRED' });
  assert.equal(submissions, 1);
});
