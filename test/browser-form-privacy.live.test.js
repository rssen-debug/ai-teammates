import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE=process.env.MAJIN_BROWSER_LIVE==='1' && typeof globalThis.WebSocket==='function';
const HOME=fs.mkdtempSync(path.join(os.tmpdir(),'majin-private-form-'));
process.env.MAJIN_HOME=HOME;
const SECRET='private@example.test';
const SECRET_CHECKBOX_VALUE='hidden-consent-value-never-echo';
const form=()=>'<html><title>Isolated consent QA</title><h1>Test fixture</h1>' +
'<form method="post" action="/receipt">' +
'<label>Email<input id="email" name="email" type="email"></label>' +
'<label><input id="consent" name="consent" type="checkbox" value="'+SECRET_CHECKBOX_VALUE+'">I agree to this synthetic fixture</label>' +
'<button id="submit" type="submit">Submit fixture</button></form></html>';

test('REAL browser: fill redacts personal field value; checkbox reports CHECKED; local server sees POST',
  {skip:!LIVE && 'MAJIN_BROWSER_LIVE=1 + Node22 WebSocket required',timeout:90000},async()=>{
    let receipt=null;
    const server=http.createServer(async(req,res)=>{
      if(req.url==='/receipt' && req.method==='POST'){
        let body='';
        for await (const buf of req)body+=buf.toString();
        receipt=new URLSearchParams(body);
        res.writeHead(200,{'content-type':'text/html'});
        res.end('<title>Fixture receipt</title><h1 id="receipt">TEST-RECEIPT-OK</h1>');
      } else{
        res.writeHead(200,{'content-type':'text/html'});
        res.end(form());
      }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/';
    const workspace=path.join(HOME,'workspace');
    fs.mkdirSync(workspace,{recursive:true});
    const {webTools}=await import('../src/core/tools/web.js');
    const {closeFor}=await import('../src/core/browser.js');
    const T=Object.fromEntries(webTools.filter(x=>x.name.startsWith('browser.')).map(x=>[x.name,x]));
    const ctx={session:'qa-private-form',cfg:{get:key=>
      key==='workspace'?workspace:key==='browser.maxInstances'?2:0}};
    try{
      const opened=await T['browser.open'].run({url,headless:true},ctx);
      assert.equal(opened.ok,true,JSON.stringify(opened));
      assert.match(opened.result,/#email/);
      assert.match(opened.result,/#consent/);
      assert.match(opened.result,/#submit/);
      assert.doesNotMatch(JSON.stringify(opened),/hidden-consent-value-never-echo/);
      // Replay real Qwen3B case10 errors: guessed selectors and trying to
      // FILL a checkbox rather than CLICK it. Error hints must be actionable.
      const wrongFill=await T['browser.fill'].run({selector:'#consent-checkbox',value:'private-token-not-for-logs'},ctx);
      assert.equal(wrongFill.ok,false);
      assert.equal(wrongFill.error.code,'no_such_element');
      assert.match(wrongFill.error.hint,/#consent \(input, checkbox, unchecked\)/);
      assert.match(wrongFill.error.hint,/#submit \(button/);
      assert.doesNotMatch(JSON.stringify(wrongFill),/private-token-not-for-logs|hidden-consent-value-never-echo/);
      const wrongClick=await T['browser.click'].run({selector:'#apply-button'},ctx);
      assert.equal(wrongClick.ok,false);
      assert.equal(wrongClick.error.code,'no_such_element');
      assert.match(wrongClick.error.hint,/#submit \(button/);
      assert.doesNotMatch(JSON.stringify(wrongClick),/private@example\\.test|hidden-consent-value-never-echo/);
      const cannotFillCheckbox=await T['browser.fill'].run({selector:'#consent',value:'overwritten'},ctx);
      assert.equal(cannotFillCheckbox.ok,false);
      assert.equal(cannotFillCheckbox.error.code,'wrong_control_type');
      assert.match(cannotFillCheckbox.error.hint,/browser.click/);
      const stillUnchecked=await T['browser.read'].run({},ctx);
      assert.match(stillUnchecked.result,/#consent \(input, checkbox, unchecked\)/);
      assert.doesNotMatch(JSON.stringify(stillUnchecked),/hidden-consent-value-never-echo/);
      const filled=await T['browser.fill'].run({selector:'#email',value:SECRET},ctx);
      assert.equal(filled.ok,true,JSON.stringify(filled));
      assert.doesNotMatch(JSON.stringify(filled),/private@example\.test/);
      assert.equal(filled.meta.valueHidden,true);
      assert.equal(filled.meta.retained,true);
      const checked=await T['browser.click'].run({selector:'#consent'},ctx);
      assert.equal(checked.ok,true,JSON.stringify(checked));
      assert.equal(checked.meta.checked,true,'native input checked confirmed after click');
      assert.equal(checked.meta.checkboxChanged,true,'must genuinely toggle');
      assert.match(checked.result,/checkbox CHECKED/);
      assert.doesNotMatch(JSON.stringify(checked),/hidden-consent-value-never-echo/);
      const submit=await T['browser.click'].run({selector:'#submit'},ctx);
      assert.equal(submit.ok,true,JSON.stringify(submit));
      for(let i=0;i<35&&!receipt;i++)await new Promise(r=>setTimeout(r,80));
      assert.ok(receipt,'localhost received a REAL POST rather than agent text');
      assert.equal(receipt.get('email'),SECRET,'real payload still reaches the site');
      assert.equal(receipt.get('consent'),SECRET_CHECKBOX_VALUE,'actual native checkbox really selected');
      assert.doesNotMatch(JSON.stringify(submit),/hidden-consent-value-never-echo|private@example\.test/);
    }finally{
      try{await closeFor(ctx.session);}catch{}
      await new Promise(resolve=>server.close(resolve));
    }
  });
