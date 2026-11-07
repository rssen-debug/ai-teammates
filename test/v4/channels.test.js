// Controlled real HTTP delivery through the existing V1 adapter and V2 runner.
// No third-party account or physical-device acceptance is implied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {channelConfigFromV1} from '../../src/v4/config.js';
import {runTool} from '../../src/v2/tools/runner.js';
import {startTestServer,tempHome} from './helpers.mjs';

test('channel credentials use only permitted existing config keys, refresh on each call and never serialize secrets',()=>{
  const home=tempHome(),file=path.join(home,'custom.json'),env={MAJIN_CONFIG:file,TEST_CHANNEL_TOKEN:'private-controlled-token'};
  const cfg=channelConfigFromV1({home,env});
  try{
    fs.writeFileSync(file,JSON.stringify({channels:{discord:{token:'{env:TEST_CHANNEL_TOKEN}'}},providers:{secret:'do-not-expose'}}));
    assert.equal(cfg.get('channels.discord.token'),'private-controlled-token');
    assert.equal(cfg.get('providers.secret'),undefined);assert.equal(cfg.get('channels.__proto__'),undefined);
    assert.equal(JSON.stringify(cfg),'{}');
    env.TEST_CHANNEL_TOKEN='rotated';assert.equal(cfg.get('channels.discord.token'),'rotated');
    fs.writeFileSync(file,'{}');assert.equal(cfg.get('channels.discord.token'),undefined);
    fs.writeFileSync(file,'invalid');assert.equal(cfg.get('channels.discord.token'),undefined);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

const owner=(s,cookie,body)=>fetch(s.base+'/api/owner-mode',{method:'POST',headers:{cookie,origin:s.base,'x-majin-csrf':'1','content-type':'application/json'},body:JSON.stringify(body)});

test('existing channel lane is opt-in, approval-held, signs actual loopback delivery and is revoked immediately',async()=>{
  const received=[];
  const receiver=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({body,signature:req.headers['x-majin-signature']});res.writeHead(200);res.end('{}');});
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  const s=await startTestServer(),cookie=s.existingSession();
  const file=path.join(s.home,'config.json');
  const registry=s.context.tools.registry;
  const input={channel:'webhook',text:'Controlled local channel acceptance'};
  const execute=approvals=>runTool({tool:'channel_send',input},{registry,approvals});
  try{
    fs.writeFileSync(file,JSON.stringify({channels:{webhook:{url:`http://127.0.0.1:${receiver.address().port}/`,secret:'controlled-channel-secret'}}}));
    assert.equal(registry.get('channel_send'),null);
    assert.equal((await owner(s,cookie,{action:'grant',lanes:['channels']})).status,200);
    assert.equal(registry.get('channel_send').tier,'process');
    const held=await execute({check:()=>({decision:'waiting'})});assert.equal(held.decision,'waiting');assert.equal(received.length,0);
    const result=await execute({check:()=>({decision:'allow'})});assert.equal(result.ok,true);assert.equal(received.length,1);
    assert.deepEqual(JSON.parse(received[0].body),{text:input.text,source:'majin'});
    assert.equal(received[0].signature,'sha256='+crypto.createHmac('sha256','controlled-channel-secret').update(received[0].body).digest('hex'));
    assert.equal(JSON.stringify(result).includes('controlled-channel-secret'),false);
    const capabilities=await(await fetch(s.base+'/api/capabilities',{headers:{cookie}})).json();
    assert.equal(JSON.stringify(capabilities).includes('controlled-channel-secret'),false);
    assert.equal((await owner(s,cookie,{action:'revoke',lanes:['channels']})).status,200);
    assert.equal(registry.get('channel_send'),null);
    await assert.rejects(execute({check:()=>({decision:'allow'})}),/unknown tool/);assert.equal(received.length,1);
  }finally{await s.close();await new Promise(resolve=>receiver.close(resolve));}
});

test('unconfigured channel reports failure instead of delivery through V4',async()=>{
  const s=await startTestServer(),cookie=s.existingSession();
  try{
    await owner(s,cookie,{action:'grant',lanes:['channels']});
    await assert.rejects(runTool({tool:'channel_send',input:{channel:'discord',text:'controlled'}},{registry:s.context.tools.registry,approvals:{check:()=>({decision:'allow'})}}),/token missing/);
  }finally{await s.close();}
});
