import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startToolHeartbeat } from '../src/core/tool-heartbeat.js';

test('slow tool emits truthful elapsed-time heartbeat without parameters or secrets',async()=>{
  const events=[];
  const heartbeat=startToolHeartbeat({tool:'browser.verify',intervalMs:20,emit:e=>events.push(e)});
  await new Promise(resolve=>setTimeout(resolve,72));
  const summary=heartbeat.stop();
  assert.ok(events.length>=1);
  assert.equal(events[0].type,'tool_waiting');
  assert.equal(events[0].tool,'browser.verify');
  assert.ok(events[0].elapsedMs>=0);
  assert.deepEqual(Object.keys(events[0]).sort(),['elapsedMs','ticks','tool','type']);
  assert.equal(summary.tool,'browser.verify');
  assert.ok(summary.elapsedMs>=0);
});
test('heartbeat stops timers and survives a throwing telemetry handler',async()=>{
  let calls=0;
  const heartbeat=startToolHeartbeat({tool:'fs.read',intervalMs:20,emit:()=>{calls++;throw Error('sink offline');}});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(calls>0);
  heartbeat.stop();heartbeat.stop();
  const settled=calls;
  await new Promise(resolve=>setTimeout(resolve,55));
  assert.equal(calls,settled);
});
test('slow tool is wired to the agent loop and compact UI with motion accessibility',()=>{
  const loop=fs.readFileSync('src/core/loop.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(loop,/const heartbeat = startToolHeartbeat/);
  assert.match(loop,/heartbeat\.stop\(\)/);
  assert.match(app,/ev\.type === 'tool_waiting'/);
  assert.match(app,/bar\.dataset\.phase='waiting'/);
  assert.match(html,/#composer:has\(#work-progress\[data-phase="waiting"\]:not\(\[hidden\]\)\)/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});
