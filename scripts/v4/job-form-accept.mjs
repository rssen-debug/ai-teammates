#!/usr/bin/env node
/**
 * Real-browser job-form acceptance, not a synthetic source-code assertion.
 * Runs a local Teamtailor-shaped application form with native Chrome/Edge
 * CDP and the SAME browser form/upload tools as MAJIN's model.
 * It NEVER visits a real recruitment site and NEVER submits.
 *
 * Windows/Ghost: node scripts/v4/job-form-accept.mjs
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openFor, closeFor } from '../../src/core/browser.js';
import { observeForm, fillForm } from '../../src/core/browser-form.js';
import { webTools } from '../../src/core/tools/web.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'majin-job-form-'));
const cv = path.join(tmp, 'cv-acceptance.txt');
await fs.writeFile(cv, 'ACCEPTANCE CV — not a real applicant\n', 'utf8');
const html = `<!doctype html><html lang="sv"><meta charset="utf-8"><title>MAJIN Local Job Acceptance</title>
<h1>Job application fixture</h1><p id="loading">Läser in ansökningsformuläret</p><div id="mount"></div>
<script>
setTimeout(()=>{
 document.getElementById('loading').remove();
 document.getElementById('mount').innerHTML = \`
 <form id="job-application-form" onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
 <label>Förnamn <input name="first" required></label>
 <label>Efternamn <input name="last" required></label>
 <label>E-post <input name="email" type="email" required></label>
 <label>Varför rollen <textarea name="why" required></textarea></label>
 <label>Helsingborg <input name="city" type="checkbox"></label>
 <label>Ladda upp CV <input name="cv" type="file" required></label>
 <button type="submit">Skicka ansökan</button>
 </form>\`;
},450);
</script></html>`;
const server = http.createServer((_req,res)=>{
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
 res.end(html);
});
let browser=null;
const session='v4-job-accept-'+process.pid;
const results=[];
const mark=(name,ok,info='')=>{results.push({name,ok,info});if(!ok)throw Error(name+': '+info);};
try {
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const url='http://127.0.0.1:'+server.address().port+'/application';
 browser=await openFor({session,url,headless:true});
 mark('browser.cdp_open',Boolean(browser),url);
 let snapshot;
 for(let i=0;i<30;i++){
  snapshot=await observeForm(browser,session);
  if(snapshot.fields.length>=6)break;
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 mark('form.dynamic_load',snapshot.fields.length>=6,'fields='+snapshot.fields.length);
 const ctx={session,cfg:{get:key=>key==='workspace'?tmp:undefined},signal:null};
 const run=async(name,input)=>webTools.find(tool=>tool.name===name).run(input,ctx);
 const values={
  'Förnamn':'Test',
  'Efternamn':'Applicant',
  'E-post':'acceptance@example.test',
  'Varför rollen':'I want to help the team with verified Microsoft IT skills.',
  'Helsingborg':true,
  'Ladda upp CV':cv,
 };
 const result=await fillForm({browser,session,values,run});
 mark('form.fill_and_upload',result.ok,JSON.stringify(result.error||result.meta||{}));
 const observed=await browser.eval(`(()=>{const form=document.querySelector('#job-application-form');
 return {first:form.elements.first.value,last:form.elements.last.value,email:form.elements.email.value,
 why:form.elements.why.value,city:form.elements.city.checked,file:form.elements.cv.files[0]?.name,
 submitted:document.body.dataset.submitted||'no'};})()`);
 mark('form.values_retained',observed.first==='Test'&&observed.last==='Applicant'&&observed.email==='acceptance@example.test'&&observed.why.includes('verified Microsoft')&&observed.city,JSON.stringify(observed));
 mark('form.cv_attached',observed.file===path.basename(cv),observed.file);
 mark('form.not_submitted',observed.submitted==='no','submit must require separate approval');
 console.log(JSON.stringify({ok:true,results},null,2));
} catch(error) {
 console.error(JSON.stringify({ok:false,error:String(error?.message||error),results},null,2));
 process.exitCode=1;
} finally {
 try{await closeFor(session,{wait:true});}catch{}
 await new Promise(resolve=>server.close(resolve));
 await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});
}
