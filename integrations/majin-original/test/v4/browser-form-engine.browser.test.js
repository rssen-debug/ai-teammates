import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-form-engine-'));process.env.MAJIN_HOME=home;
const {findBrowser,openFor,closeFor}=await import('../../src/core/browser.js');
const {webTools}=await import('../../src/core/tools/web.js');
const {adaptV1Tool}=await import('../../src/v4/tools/host.js');
test('semantic form batches reground replaced nodes, use a different native input strategy, verify exact uploads and refuse ambiguous/auth targets',{timeout:60000},async t=>{
 if(!findBrowser()){t.skip('No browser binary; real DOM not proven');return;}
 const html=`<form id=demo><fieldset id=contact></fieldset><label>Trusted entry<input id=trusted name=trusted></label><label>Consent<input type=checkbox name=consent></label><label>Evidence<input type=file></label><button>Continue</button><p role=alert></p></form><script>
 function render(v={}){document.querySelector('#contact').innerHTML='<label>Display name<input name=person></label><label>Contact address<input name=email type=email></label>';for(const k of Object.keys(v))document.querySelector('[name='+k+']').value=v[k];document.querySelector('[name=person]').onchange=()=>render({person:document.querySelector('[name=person]').value})}render();
 document.querySelector('#trusted').addEventListener('input',e=>{if(!e.isTrusted)e.target.value=''});
 </script>`;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const session='form-engine-test',ctx={session,cfg:{get:k=>k==='workspace'?home:undefined}};
 const run=(name,input)=>webTools.find(t=>t.name===name).run(input,ctx);
 try{
  const opened=await run('browser.open',{url:`http://127.0.0.1:${server.address().port}`,headless:true});assert.equal(opened.ok,true);assert.match(opened.result,/Live form:.*Display name/);
  const adapted=adaptV1Tool(webTools.find(t=>t.name==='browser.form'),{lane:'web',ctx});
  const bridged=await adapted.execute({});assert.equal(adapted.outputSchema.safeParse(bridged).success,true,'actual V4 bridge must accept read-only observations without a summary');
  const seen=JSON.parse(bridged.result);assert.ok(seen.fields.find(f=>f.label==='Evidence'&&f.type==='file'));
  const set=await run('browser.form_fill',{values:{'Display name':'PRIVATE-NAME','Contact address':'private@example.invalid','Trusted entry':'PRIVATE-TRUSTED',Consent:true}});
  assert.equal(set.ok,true,JSON.stringify(set));
  const completed=JSON.parse(set.result).completed;
  assert.ok(completed.some(x=>x.strategy==='semantic_reground'));assert.ok(completed.some(x=>x.strategy==='native_type_retry'));
  assert.doesNotMatch(JSON.stringify(set),/PRIVATE-|private@example/);
  const b=await openFor({session,cfgGet:()=>undefined});assert.equal(await b.eval('document.querySelector("[name=person]").value'),'PRIVATE-NAME');
  const bytes=Buffer.from('exact generated evaluation file\n');fs.writeFileSync(path.join(home,'evidence.txt'),bytes);
  const upload=await run('browser.form_fill',{values:{Evidence:'evidence.txt'}});assert.equal(upload.ok,true,JSON.stringify(upload));
  assert.equal(JSON.parse(upload.result).completed[0].uploadSha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  await b.eval('document.body.insertAdjacentHTML("beforeend", "<label>Duplicate<input></label><label>Duplicate<input></label>")');await run('browser.form',{});
  assert.equal((await run('browser.form_fill',{values:{Duplicate:'never'}})).error.code,'field_not_grounded');
  await b.eval('document.body.insertAdjacentHTML("beforeend", "<label>Password<input type=password></label>")');await run('browser.form',{});
  const held=await run('browser.form_fill',{values:{'Trusted entry':'never'}});assert.equal(held.error.code,'owner_handoff');
  assert.equal(await b.eval('document.querySelector("#trusted").value'),'PRIVATE-TRUSTED');
  await b.eval('document.querySelector("input[type=password]").remove();document.body.insertAdjacentHTML("beforeend", "<iframe src=about:blank#hcaptcha></iframe>")');await run('browser.form',{});
  assert.equal((await run('browser.form_fill',{values:{'Trusted entry':'never'}})).error.code,'owner_handoff');
  await b.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await run('browser.form_fill',{values:{'Trusted entry':'never'}})).error.code,'document_changed','old field refs cannot authorize a new document');
 }finally{await closeFor(session,{wait:true});await new Promise(r=>server.close(r));assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep+'majin-form-engine-'));await fs.promises.rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
