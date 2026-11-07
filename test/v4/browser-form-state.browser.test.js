// Real DOM regression; provider acceptance is evaluated separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-form-state-'));
process.env.MAJIN_HOME=home;
const {findBrowser,openFor,closeFor}=await import('../../src/core/browser.js');
const {webTools}=await import('../../src/core/tools/web.js');
const {FORM_STATE_JS}=await import('../../src/core/browser-evidence.js');
test('no-op select preserves dependent fields and native validity is private and read-only',{timeout:60000},async t=>{
 if(!findBrowser()){t.skip('No browser binary; no DOM proof');return;}
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<form><select id="mode" onchange="window.changes=(window.changes||0)+1;document.querySelector('#group').value='' "><option>Solo</option><option>Team</option></select><input id="group" required><input id="email" type="email" value="invalid-email-private" required><input id="seats" type="number" min="1" value="0"><input id="password" type="password" value="private-secret"><input id="consent" type="checkbox" required><button>Register</button></form><script>window.invalidEvents=0;document.addEventListener('invalid',()=>window.invalidEvents++,true)</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const session='form-state-regression',ctx={session,cfg:{get:k=>k==='workspace'?home:undefined}};
 const run=(name,args)=>webTools.find(t=>t.name===name).run(args,ctx);
 try{
  assert.equal((await run('browser.open',{url:`http://127.0.0.1:${server.address().port}`,headless:true})).ok,true);
  const b=await openFor({session,cfgGet:()=>undefined});
  assert.equal((await run('browser.fill',{selector:'#mode',value:'Team'})).ok,true);
  assert.equal((await run('browser.fill',{selector:'#group',value:'private-group'})).ok,true);
  assert.equal((await run('browser.fill',{selector:'#mode',value:'Team'})).ok,true);
  assert.deepEqual(await b.eval('({value:document.querySelector("#group").value,changes:window.changes})'),{value:'private-group',changes:1});
  await b.eval('document.querySelector("#group").value=""');
  const rows=await b.eval(FORM_STATE_JS);
  for(const [id,problem] of [['group','valueMissing'],['email','typeMismatch'],['seats','rangeUnderflow'],['consent','valueMissing']])assert.ok(rows.find(r=>r.id===id).problems.includes(problem));
  assert.equal(await b.eval('window.invalidEvents'),0,'observation must not trigger invalid events');
  const read=await run('browser.read',{});
  assert.match(read.result,/#group: EMPTY.*INVALID valueMissing/);
  assert.doesNotMatch(JSON.stringify({rows,read}),/private-secret|invalid-email-private|private-group/);
  const clicked=await run('browser.click',{selector:'button'});
  assert.equal(clicked.ok,true);assert.match(clicked.result,/OUTCOME NOT VERIFIED/);assert.match(clicked.result,/#group: EMPTY.*INVALID/);
  assert.ok(await b.eval('window.invalidEvents>0'),'native submission validation still runs');
 }finally{
  await closeFor(session,{wait:true});await new Promise(r=>server.close(r));
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-form-state-'));
  await fs.promises.rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
});
