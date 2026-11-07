import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {writeAtomic} from '../src/core/tools/files.js';
import {webTools,httpGet} from '../src/core/tools/web.js';
import {netTools} from '../src/core/tools/net.js';
import {adaptV1Tool,v1Context} from '../src/v4/tools/host.js';
import {ToolRegistry} from '../src/v2/tools/registry.js';
import {runTool} from '../src/v2/tools/runner.js';
test('read-only web fetch cannot dispatch mutating methods, bodies or method overrides',async()=>{
  let requests=0;const methods=[];
  const server=http.createServer((req,res)=>{requests++;methods.push(req.method);res.setHeader('content-type','application/json');res.end('{"observed":true}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/controlled`, ctx={cfg:{get:()=>undefined}};
  const fetchTool=webTools.find(t=>t.name==='web.fetch');
  try{
    for(const input of [{method:'POST'},{method:'PUT'},{method:'DELETE'},{method:'PATCH'},{method:'GET',body:'write'},{headers:{'X-HTTP-Method-Override':'DELETE'}}]){
      assert.equal((await fetchTool.run({url,...input},ctx)).error.code,'external_action_requires_approval');
    }
    assert.equal(requests,0,'rejected reads never contact the destination');
    assert.equal((await fetchTool.run({url},ctx)).ok,true);
    assert.equal((await fetchTool.run({url,method:'HEAD'},ctx)).ok,true);
    assert.deepEqual(methods,['GET','HEAD']);
  }finally{await new Promise(r=>server.close(r));}
});
test('raw HTTP remains available but a real POST waits for scoped approval',async()=>{
  let posts=0;
  const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.end('controlled response');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const registry=new ToolRegistry();
  registry.define(adaptV1Tool(netTools.find(t=>t.name==='net.http'),{lane:'net',ctx:v1Context()}));
  assert.equal(registry.get('net_http').tier,'process', 'raw arbitrary HTTP is held as an operation, stricter than a read capability');
  const call={tool:'net_http',input:{url:`http://127.0.0.1:${server.address().port}/controlled`,method:'POST',body:'synthetic data'}};
  try{
    const held=await runTool(call,{registry,approvals:{check:scope=>{assert.equal(scope,'tool:net_http');return {decision:'waiting'};}}});
    assert.equal(held.decision,'waiting');assert.equal(posts,0);
    const allowed=await runTool(call,{registry,approvals:{check:()=>({decision:'allow'})}});
    assert.equal(allowed.ok,true);assert.equal(posts,1);
  }finally{await new Promise(r=>server.close(r));}
});

test('HTTP reads stop at their byte budget and oversized downloads retain existing file bytes',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-http-budget-'));
  const target=path.join(home,'retained.bin');fs.writeFileSync(target,'retained original bytes');
  const server=http.createServer((req,res)=>res.end(Buffer.alloc(65536,120)));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/large`;
  try{
    const observed=await httpGet(url,{maxBytes:128});
    assert.equal(observed.body.length,128);assert.equal(observed.truncated,true);
    const result=await webTools.find(t=>t.name==='web.download').run({url,path:'retained.bin'}, {cfg:{get:k=>k==='workspace'?home:k==='tools.re.maxFileBytes'?128:undefined}});
    assert.equal(result.error.code,'response_too_large');
    assert.equal(fs.readFileSync(target,'utf8'),'retained original bytes');
  }finally{
    await new Promise(r=>server.close(r));const resolved=path.resolve(home);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'majin-http-budget-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
test('V4 download refuses a destination outside grants before contacting the network',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-http-grants-'));let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.end('controlled');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const registry=new ToolRegistry();registry.define(adaptV1Tool(webTools.find(t=>t.name==='web.download'),{lane:'web',ctx:v1Context({workspaceDir:home})}));
  try{
    await assert.rejects(runTool({tool:'web_download',input:{url:`http://127.0.0.1:${server.address().port}/controlled`,path:path.join(home,'..','outside.bin')}},{registry,approvals:{check:()=>({decision:'allow'})}}),e=>e.cls==='PERMISSION_DENIED');
    assert.equal(requests,0);
  }finally{
    await new Promise(r=>server.close(r));const resolved=path.resolve(home);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'majin-http-grants-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('atomic file failure and pre-cancellation preserve original bytes and leave no partial temporary file',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'majin-http-atomic-')), target=path.join(home,'retained.bin');
  fs.writeFileSync(target,'retained bytes');const originalRename=fsp.rename;
  try{
    fsp.rename=async(from,to)=>{if(to===target)throw Object.assign(new Error('controlled disk full'),{code:'ENOSPC'});return originalRename(from,to);};
    await assert.rejects(writeAtomic(target,'new bytes'),e=>e.code==='ENOSPC');
    assert.equal(fs.readFileSync(target,'utf8'),'retained bytes');assert.deepEqual(fs.readdirSync(home),['retained.bin']);
    const ctl=new AbortController();ctl.abort(new Error('controlled cancelled download'));
    await assert.rejects(writeAtomic(target,'cancelled bytes',{signal:ctl.signal}),/controlled cancelled/);
    assert.equal(fs.readFileSync(target,'utf8'),'retained bytes');
  }finally{
    fsp.rename=originalRename;const resolved=path.resolve(home);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'majin-http-atomic-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
