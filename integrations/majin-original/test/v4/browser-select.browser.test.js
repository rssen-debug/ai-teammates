// Actual local DOM actions; this regression does not prove real-model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-select-test-'));
process.env.MAJIN_HOME = home;
const { findBrowser, openFor, closeFor } = await import('../../src/core/browser.js');
const { webTools } = await import('../../src/core/tools/web.js');
test('browser form controls retain values and uploads while rejecting ambiguous or stale targets', {timeout:60000}, async t => {
  if (!findBrowser()) { t.skip('No browser binary; no real DOM verification.'); return; }
  const server = http.createServer((req,res) => { res.setHeader('content-type','text/html'); res.end('<select id="country"><option value="dk">Denmark</option><option value="se">Sweden</option><option value="1">Duplicate</option><option value="2">Duplicate</option><option value="x" disabled>Disabled</option></select><input id="secret" value="private-initial"><button onclick="window.clicked=(window.clicked||0)+1">Register   session</button>'); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const session='select-regression', ctx={session,cfg:{get:k=>k==='workspace'?home:undefined}};
  const run=(name,args)=>webTools.find(t=>t.name===name).run(args,ctx);
  try {
    assert.equal((await run('browser.open',{url:`http://127.0.0.1:${server.address().port}`,headless:true})).ok,true);
    const b=await openFor({session,cfgGet:()=>undefined});
    const filled=await run('browser.fill',{selector:'#country',value:'Sweden'});
    assert.equal(filled.ok,true); assert.equal(await b.eval('document.querySelector("#country").value'),'se');
    assert.doesNotMatch(JSON.stringify(filled),/Sweden|"se"|private-initial/);
    for (const value of ['Duplicate','Disabled','missing']) {
      const rejected=await run('browser.fill',{selector:'#country',value});
      assert.equal(rejected.error.code,'option_not_unique');
      assert.equal(await b.eval('document.querySelector("#country").value'),'se');
      // Reset the journal by observing rather than retrying identical actions indefinitely.
      await run('browser.read',{});
    }
    assert.equal((await run('browser.fill',{selector:'#country',value:'dk'})).ok,true);
    const privateFill=await run('browser.fill',{selector:'#secret',value:'private-after'});
    assert.equal(privateFill.ok,true); assert.doesNotMatch(JSON.stringify(privateFill),/private-/);
    await run('browser.elements',{});
    const { GROUND_JS }=await import('../../src/core/browser-ground.js');
    const snapshot=await b.eval(GROUND_JS);
    const button=snapshot.elements.find(e=>e.tag==='button');
    assert.equal(button.text,'Register session','whitespace is normalized; letter s is preserved');
    assert.equal((await run('browser.click',{ref:button.ref})).ok,true);
    assert.equal(await b.eval('window.clicked'),1);
    await b.eval('document.querySelector("button").textContent="Different action"');
    const stale=await run('browser.click',{ref:button.ref});
    assert.equal(stale.error.code,'click_blocked');
    assert.match(stale.error.message,/ref_identity_changed/);
    assert.equal(await b.eval('window.clicked'),1,'changed anonymous control must never be clicked');
    await b.eval('document.body.insertAdjacentHTML("beforeend", "<input id=consent type=checkbox>")');
    const checked=await run('browser.click',{selector:'#consent',expectChecked:'true'});
    assert.equal(checked.ok,true);
    assert.equal(await b.eval('document.querySelector("#consent").checked'),true);
    await b.eval('document.body.insertAdjacentHTML("beforeend", "<input id=proof type=file>")');
    fs.writeFileSync(path.join(home,'synthetic.txt'),'Controlled upload bytes.');
    await run('browser.elements',{});
    const uploadSnapshot=await b.eval(GROUND_JS);
    const fileRef=uploadSnapshot.elements.find(e=>e.type==='file').ref;
    const malformed=await run('browser.upload',{selector:`[${fileRef}]`,path:'synthetic.txt'});
    assert.equal(malformed.error.code,'bad_input');
    assert.equal(await b.eval('document.querySelector("#proof").files.length'),0);
    const attached=await run('browser.upload',{ref:fileRef,path:'synthetic.txt'});
    assert.equal(attached.ok,true);
    assert.equal(await b.eval('document.querySelector("#proof").files[0].text()'),'Controlled upload bytes.');
    await b.eval('document.body.insertAdjacentHTML("beforeend", "<input id=other type=file>")');
    const ambiguous=await run('browser.upload',{selector:'input[type=file]',path:'synthetic.txt'});
    assert.equal(ambiguous.error.code,'ambiguous_target');
    assert.equal(await b.eval('document.querySelector("#other").files.length'),0);
    await b.eval('document.querySelector("#proof").type="text"');
    const staleFile=await run('browser.upload',{ref:fileRef,path:'synthetic.txt'});
    assert.equal(staleFile.error.code,'ref_stale');
    assert.equal((await run('browser.upload',{ref:'e9999',path:'synthetic.txt'})).error.code,'ref_unknown');
  } finally {
    await closeFor(session,{wait:true}); await new Promise(r=>server.close(r));
    const resolved=path.resolve(home);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'majin-select-test-'));
    await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
