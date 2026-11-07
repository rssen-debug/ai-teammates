import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { closeQaFixture } from '../scripts/qa/fixture-teardown.mjs';

test('fixture cleanup closes every browser before HTTP server and runtime', async () => {
  const ordered = [];
  const server = {
    close(cb) { ordered.push('server.close'); setImmediate(() => cb()); },
    closeIdleConnections() { ordered.push('server.closeIdleConnections'); },
    closeAllConnections() { throw new Error('must not force when browsers are closed'); },
  };
  const result = await closeQaFixture({
    browserSessions: ['shot','form','shot'],
    closeBrowser: async (session, opts) => {
      assert.equal(opts.wait,true);
      ordered.push('browser.'+session);
    },
    server,
    runtime: { async shutdown() { ordered.push('runtime.shutdown'); } },
    serverDeadlineMs: 300,
  });
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.browsers,2,'duplicate session closed exactly once');
  assert.equal(result.server,'closed');
  assert.deepEqual(ordered,['browser.shot','browser.form','server.close','server.closeIdleConnections','runtime.shutdown']);
});

test('hung server connection is force-closed but NEVER silently recorded as clean', async () => {
  let closeCallback;
  let forced = 0;
  const result = await closeQaFixture({
    browserSessions:[],
    closeBrowser:async()=>{},
    server:{
      close(cb){closeCallback=cb;},
      closeIdleConnections(){},
      closeAllConnections(){forced++;setImmediate(()=>closeCallback());},
    },
    runtime:{async shutdown(){}},
    serverDeadlineMs:45,
  });
  assert.equal(forced,1,'dead server connections must be reaped');
  assert.equal(result.ok,false,'forced teardown needs an explicit QA failure');
  assert.equal(result.server,'forced');
  assert.match(result.problems.join(' '),/forced close/);
});

test('hung runtime shutdown is bounded and produces honest blocked QA status', async () => {
  const t=Date.now();
  const result = await closeQaFixture({
    browserSessions:[],
    closeBrowser:async()=>{},
    server:null,
    runtime:{shutdown:()=>new Promise(()=>{})},
    runtimeDeadlineMs:45,
  });
  assert.equal(result.ok,false);
  assert.match(result.problems.join(' '),/runtime shutdown.*deadline exceeded/);
  assert.ok(Date.now()-t<1500);
});

test('real HTTP keep-alive fixture is closed with a live network client attached',async()=>{
  const server=http.createServer((_req,res)=>res.end('fixture'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agent = new http.Agent({keepAlive:true});
  const url='http://127.0.0.1:'+server.address().port+'/';
  await new Promise((resolve,reject)=>{
    http.get(url,{agent},res=>{
      let body='';
      res.on('data',buf=>body+=buf.toString());
      res.on('end',()=>{assert.equal(body,'fixture');resolve();});
    }).on('error',reject);
  });
  try{
    const out=await closeQaFixture({
      browserSessions:['real-browser'],
      closeBrowser:async()=>{agent.destroy();},
      server,
      runtime:{async shutdown(){}},
      serverDeadlineMs:450,
    });
    assert.equal(out.ok,true,JSON.stringify(out));
    assert.equal(out.server,'closed');
  }finally{
    agent.destroy();
    server.closeAllConnections();
  }
});
