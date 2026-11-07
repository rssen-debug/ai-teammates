import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startTestServer,postChat,readSse} from './helpers.mjs';
import {AuditChain} from '../../src/v2/audit/chain.js';
import {verifyBundle,findPrivateMaterial} from '../../src/v2/audit/export.js';
import {createV4Server} from '../../src/v4/server.js';

test('actual V4 tool receipts and explicit consent enter V2 chain; local anchors and public bundles independently verify',async()=>{
  const s=await startTestServer({env:{MAJIN_V4_WRITE_POLICY:'strict'}}),cookie=s.existingSession();
  const post=body=>fetch(s.base+'/api/audit',{method:'POST',headers:{cookie,origin:s.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(s.base+'/api/audit')).status,401);
    assert.equal((await fetch(s.base+'/api/audit',{method:'POST',headers:{cookie,origin:s.base,'content-type':'application/json'},body:'{}'})).status,403);
    let events=await readSse(await postChat(s.base,cookie,{text:'Skriv filen audit-proof.txt med innehåll: private audit phrase',requestId:'audit-e2e-1'}));
    const held=events.find(e=>e.type==='done').data;assert.equal(held.status,'awaiting_approval');
    const approval=await fetch(s.base+'/api/approve',{method:'POST',headers:{cookie,origin:s.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify({conversationId:held.conversationId,approve:true})});
    events=await readSse(approval);const done=events.find(e=>e.type==='done').data;assert.equal(done.status,'completed');
    assert.equal(fs.readFileSync(path.join(s.config.workspaceDir,'audit-proof.txt'),'utf8'),'private audit phrase');
    const dir=s.context.audit.dir,rows=fs.readFileSync(path.join(dir,'chain.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const goal=s.context.goals.get(done.goalId);
    for(const receipt of goal.receipts)assert.ok(rows.some(r=>r.kind==='receipt'&&r.payload.id===receipt.id&&r.payload.hash===receipt.hash));
    assert.ok(rows.some(r=>r.kind==='consent'&&r.payload.approved===true));
    assert.equal(JSON.stringify(rows).includes('private audit phrase'),false);
    assert.equal(new AuditChain(dir).verify().ok,true);
    assert.equal(s.context.audit.status().anchor.cls,'NO_ANCHOR');
    const initialized=await (await post({action:'initialize'})).json();assert.equal(initialized.ok,true);
    assert.equal(s.context.audit.status().anchor.cls,'OK');
    await readSse(await postChat(s.base,cookie,{text:'Hej',requestId:'audit-after-initialize'}));
    assert.equal(s.context.audit.status().anchor.cls,'OK','configured local identity checkpoints completed turns automatically');
    const exported=await (await post({action:'export'})).json();assert.equal(exported.ok,true);assert.equal(exported.verification.cls,'BUNDLE_OK');
    assert.equal(verifyBundle(exported.out).ok,true);assert.deepEqual(findPrivateMaterial(exported.out),[]);
  }finally{await s.close();}
});

test('tampered audit blocks the next V4 turn before a tool effect and refuses extension at boot',async()=>{
  const s=await startTestServer(),cookie=s.existingSession();
  try{
    await readSse(await postChat(s.base,cookie,{text:'Hej',requestId:'audit-tamper-1'}));
    const file=path.join(s.context.audit.dir,'chain.jsonl'),original=fs.readFileSync(file,'utf8');
    const lines=original.trim().split('\n'),entry=JSON.parse(lines[0]);entry.payload.changed='controlled tampering';lines[0]=JSON.stringify(entry);fs.writeFileSync(file,lines.join('\n')+'\n');
    assert.equal(s.context.audit.status().ok,false);
    const attempted=await postChat(s.base,cookie,{text:'Skriv filen must-not-exist.txt med innehåll: refused',requestId:'audit-tamper-2'});
    assert.equal(attempted.status,500);assert.equal(fs.existsSync(path.join(s.config.workspaceDir,'must-not-exist.txt')),false);
    assert.throws(()=>createV4Server({config:s.config}),e=>e.code==='AUDIT_INTEGRITY');
    assert.equal(fs.readFileSync(file,'utf8'),lines.join('\n')+'\n','corrupt bytes are retained, not silently reset');
  }finally{await s.close();}
});
