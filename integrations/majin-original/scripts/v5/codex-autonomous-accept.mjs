import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CodexAppClient } from '../../src/v5/codex-app-client.js';

const output = path.resolve(process.argv[2]);
const cvPath = path.resolve(process.argv[3]);
const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
const cvName = path.basename(cvPath); fs.copyFileSync(cvPath, path.join(workspace, cvName));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHash = hash(fs.readFileSync(cvPath));
let receipt = null; let submissions = 0;
const page = `<!doctype html><html lang="sv"><title>Local CV test portal</title><h1>Local test application - no employer</h1>
<form id="application" action="/receive" method="post" enctype="multipart/form-data">
<label>Namn <input id="name" name="name" required></label><label>E-post (testadress) <input type="email" id="email" name="email" required></label>
<fieldset><legend>Kontaktkanal (test)</legend><label><input type="radio" name="contact" id="contact-email" value="email" required>E-post</label><label><input type="radio" name="contact" id="contact-phone" value="phone">Telefon</label></fieldset>
<label>Land (test) <select name="country" id="country" required><option value="">Välj</option><option value="se">Sverige</option><option value="other">Annat</option></select></label>
<label id="city-label" hidden>Ort (test) <input id="city" name="city" disabled></label>
<fieldset role="radiogroup" aria-label="Arbetsform (test)"><legend>Arbetsform (test)</legend><button type="button" role="radio" aria-checked="false" id="hybrid">Hybrid</button><button type="button" role="radio" aria-checked="false" id="office">Kontor</button><input type="hidden" name="mode" id="mode"></fieldset>
<label><input type="checkbox" name="consent" id="consent" value="yes" required>Jag godkänner att filen skickas till denna lokala testportal</label>
<label>CV PDF <input id="cv" name="cv" type="file" accept="application/pdf" required></label><p id="selected"></p>
<button type="submit" id="submit">Skicka testansökan</button></form><p id="confirmation" role="status"></p>
<script>
country.onchange=()=>{const on=country.value==='se';document.querySelector('#city-label').hidden=!on;city.disabled=!on;city.required=on;};
for(const id of ['hybrid','office'])document.getElementById(id).onclick=()=>{for(const other of ['hybrid','office'])document.getElementById(other).setAttribute('aria-checked',String(id===other));mode.value=id;};
cv.onchange=()=>selected.textContent='Selected file: '+cv.files[0]?.name;
application.onsubmit=async event=>{event.preventDefault();if(!application.reportValidity())return;submit.disabled=true;try{const response=await fetch('/receive',{method:'POST',body:new FormData(application)});const data=await response.json();confirmation.textContent=response.ok?'MOTTAGEN '+data.receiptId+' SHA256 '+data.sha256:'ERROR '+data.error;}finally{submit.disabled=false;}};
</script></html>`;
const fixture = http.createServer(async (req, res) => {
  try {
    if (req.url === '/receive' && req.method === 'POST') {
      submissions++;
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const data = await new Request('http://localhost/receive', { method:'POST', headers:req.headers, body:Buffer.concat(chunks) }).formData();
      const cv = data.get('cv'); const bytes = cv && typeof cv.arrayBuffer === 'function' ? Buffer.from(await cv.arrayBuffer()) : Buffer.alloc(0);
      const checks = { name:data.get('name')==='Kristjan Kristinsson', email:data.get('email')==='test@example.invalid',
        nativeRadio:data.get('contact')==='email', select:data.get('country')==='se', dynamicField:data.get('city')==='Stockholm',
        ariaRadio:data.get('mode')==='hybrid', checkbox:data.get('consent')==='yes',
        fileName:cv?.name===cvName, fileBytes:bytes.length>0 && hash(bytes)===expectedHash };
      if (!Object.values(checks).every(Boolean)) {res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:'Field/file validation failed',checks}));return;}
      receipt={receiptId:randomUUID(),sha256:hash(bytes),bytes:bytes.length,fileName:cv.name,checks,receivedAt:new Date().toISOString()};
      fs.writeFileSync(path.join(output,'received-cv.pdf'),bytes);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(receipt));return;
    }
    res.setHeader('content-type','text/html; charset=utf-8');
    if(req.url==='/created.html')res.end(fs.readFileSync(path.join(workspace,'created.html')));
    else res.end(page);
  } catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`;
const client=new CodexAppClient({workspace,stateDir:path.join(output,'state'),browser:true,processAccess:true,browserWriteOrigins:[origin]});
const report={at:new Date().toISOString(),kind:'actual Codex model turns; no scripted tool calls',results:{},cv:{fileName:cvName,sha256:expectedHash}};
const events=[];
client.on('event',event=>{if(['item/started','item/completed','turn/completed'].includes(event.method))events.push(event);});
client.on('request',request=>{
  const params=request.params; const meta=params?._meta; const input=meta?.tool_params || {};
  const tool=/tool "([^"]+)"/.exec(params?.message || '')?.[1];
  const normal=/^(fs_(read|write|patch|list|stat|mkdir)|documents_extract|jobs_(search|match)|browser_(open|inspect|fill|check|select|upload|click|press|close)|driver_status)$/.test(tool || '');
  const allowed= request.method==='mcpServer/elicitation/request' && params.serverName==='majin' && meta?.codex_approval_kind==='mcp_tool_call' &&
    ((normal && (tool!=='browser_open' || new URL(input.url).origin===origin)) ||
     (tool==='web_fetch' && String(input.url).startsWith('https://jobsearch.api.jobtechdev.se/')) ||
     (tool==='shell_run' && /^node (\.\/)?repair\/calc\.mjs$/.test(input.command || '')));
  client.reply(request.id,{action:allowed?'accept':'decline',content:{}});
  if(!allowed)events.push({method:'acceptance/declined',tool,requestMethod:request.method});
});
async function run(name,prompt,verify){
  const start=events.length;
  try{
    const turn=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.off('event',listener);reject(new Error('Model turn timed out'));},240000);
      const listener=event=>{if(event.method==='turn/completed'){clearTimeout(timer);client.off('event',listener);resolve(event.params.turn);}};
      client.on('event',listener);
    });
    await client.send(`Authorized local acceptance test ${name}. Use only majin MCP tools, never native shell tools or other providers. Assign stable unique operationId per action. ${prompt}`);
    const result=await turn;
    if(result.status!=='completed')throw new Error(`Turn status ${result.status}`);
    await verify();
    report.results[name]={passed:true,turnId:result.id,eventCount:events.length-start};
  }catch(error){report.results[name]={passed:false,error:error.message};}
  fs.writeFileSync(path.join(output,'autonomous-acceptance.json'),JSON.stringify({...report,receipt,submissions},null,2));
  console.log(JSON.stringify({test:name,...report.results[name]}));
}
try{
  await client.start();await client.openConversation();
  fs.writeFileSync(path.join(workspace,'source.txt'),'Project Cedar launches 14 November 2026. Budget SEK 42000. Owner Test User.');
  fs.mkdirSync(path.join(workspace,'repair'),{recursive:true});fs.writeFileSync(path.join(workspace,'repair/calc.mjs'),'if(2+2!==5)process.exit(1);console.log("CALC_OK");');
  await run('A_document', 'Read source.txt, create an accurate short Swedish summary in summary.txt and read it back.',()=>{
    const s=fs.readFileSync(path.join(workspace,'summary.txt'),'utf8');if(!/Cedar/.test(s)||!/42.?000/.test(s)||!/2026/.test(s))throw Error('Summary mismatch');
  });
  await run('B_public_sources','Fetch current public Python job data from https://jobsearch.api.jobtechdev.se/search?q=python&limit=1 using web_fetch. Write sources.json containing the real source URL, timestamp and at least one current job id from the response.',()=>{
    const s=fs.readFileSync(path.join(workspace,'sources.json'),'utf8');JSON.parse(s);if(!s.includes('jobsearch.api.jobtechdev.se'))throw Error('Source missing');
  });
  await run('C_radios_CV_submission',`Open ${origin}/ with a visible browser. This is an owner-authorized LOCAL portal; submit once here. Fill name Kristjan Kristinsson; test email test@example.invalid; contact E-post; country Sverige; dynamically revealed city Stockholm; custom ARIA radio Hybrid; consent to this local test. Attach ${cvName}, then send the test application. Observe the real MOTTAGEN receipt and SHA256 confirmation. Do not claim success from file selection alone. If submission becomes uncertain, inspect confirmation before any retry.`,()=>{
    if(!receipt||submissions!==1||receipt.sha256!==expectedHash||!Object.values(receipt.checks).every(Boolean))throw Error('No exact single verified submission');
  });
  await run('D_created_page',`Create created.html with title Majin verified and heading Cedar demonstration. Open ${origin}/created.html in the browser and inspect its actual rendered heading.`,()=>{
    if(!/Cedar demonstration/.test(fs.readFileSync(path.join(workspace,'created.html'),'utf8')))throw Error('Page missing');
  });
  await run('E_code_repair','Run node repair/calc.mjs using shell_run, observe its intentional failure, inspect and fix the incorrect arithmetic assertion, then rerun until CALC_OK with exit zero. Do not replace the task with a prose explanation.',()=>{
    if(!execFileSync(process.execPath,['repair/calc.mjs'],{cwd:workspace,encoding:'utf8'}).includes('CALC_OK'))throw Error('Code still fails');
  });
  await run('F_five_job_matches',`Read/extract ${cvName}, search five current Python job advertisements with jobs_search and compare them to the CV using jobs_match and your reasoning. Write job-matches.json with exactly five entries in a top-level matches array, each with a real job title, source URL and evidence-based suitability notes. Do not send any actual applications.`,()=>{
    const data=JSON.parse(fs.readFileSync(path.join(workspace,'job-matches.json'),'utf8'));if(!Array.isArray(data.matches)||data.matches.length!==5)throw Error('Five matches missing');
  });
}finally{
  await client.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
  fs.writeFileSync(path.join(output,'model-events-private.json'),JSON.stringify(events,null,2));
  fs.writeFileSync(path.join(output,'autonomous-acceptance.json'),JSON.stringify({...report,receipt,submissions},null,2));
}
