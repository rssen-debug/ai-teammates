import test from 'node:test';
import assert from 'node:assert/strict';
import { cdpRpc, waitForNavigation } from '../src/core/browser.js';

function wire() {
  const sent=[];
  const ws={send:message=>sent.push(JSON.parse(message))};
  return {ws,sent,send:cdpRpc(ws),answer:(id,result)=>ws.onmessage({data:JSON.stringify({id,result})})};
}
test('a timed-out CDP request never deletes a newer pending request',async()=>{
  const w=wire();
  const expired=assert.rejects(w.send('First',{}, {timeoutMs:10}),/CDP timeout/);
  const newer=w.send('Second',{}, {timeoutMs:1000});
  await expired; w.answer(w.sent[1].id,{actual:'second'});
  assert.deepEqual(await newer,{actual:'second'});
});
test('CDP abort and socket close settle pending work and do not affect other requests',async()=>{
  const w=wire(), ctl=new AbortController();
  const cancelled=assert.rejects(w.send('Cancelled',{}, {signal:ctl.signal,timeoutMs:30000}),/controlled cancel/);
  const other=w.send('Other',{}, {timeoutMs:30000});
  ctl.abort(new Error('controlled cancel')); await cancelled;
  w.answer(w.sent[1].id,{observed:true}); assert.deepEqual(await other,{observed:true});
  const closed=assert.rejects(w.send('Pending',{}, {timeoutMs:30000}),/connection closed/);
  w.ws.onclose(); await closed;
  const before=w.sent.length;
  await assert.rejects(w.send('Never sent',{}, {signal:ctl.signal}),/controlled cancel/);
  assert.equal(w.sent.length,before);
});
test('CDP registers a request before sending and cleans up synchronous transport failure',async()=>{
  const ws={send:message=>ws.onmessage({data:JSON.stringify({id:JSON.parse(message).id,result:{immediate:true}})})};
  assert.deepEqual(await cdpRpc(ws)('Immediate'),{immediate:true});
  await assert.rejects(cdpRpc({send:()=>{throw Error('socket unavailable');}})('Broken'),/socket unavailable/);
});
test('navigation cancellation is never swallowed as a transient execution-context error',async()=>{
  const ctl=new AbortController();let reads=0;
  await assert.rejects(waitForNavigation({loaderId:'expected'},async()=>{reads++;ctl.abort(new Error('stop navigation'));throw Error('context gone');},{signal:ctl.signal}),/stop navigation/);
  assert.equal(reads,1);
});
