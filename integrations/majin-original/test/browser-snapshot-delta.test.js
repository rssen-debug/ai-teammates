import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {diffGroundSnapshot,clearGroundSnapshot} from '../src/core/browser-ground.js';
const one={ref:'e1',tag:'button',role:'button',text:'Save',id:'save'};
const two={ref:'e2',tag:'a',role:'link',text:'Home',href:'/home'};
const payload=(url,els)=>({url,title:'Test',count:els.length,elements:els});
test('first page snapshot is full, identical observation uses no extra tokens',()=>{
  clearGroundSnapshot('delta-a');
  const a=diffGroundSnapshot('delta-a',payload('/a',[one,two]));
  assert.equal(a.mode,'full');
  const b=diffGroundSnapshot('delta-a',payload('/a',[one,two]));
  assert.equal(b.mode,'unchanged');
  assert.deepEqual(b.changes,[]);
  clearGroundSnapshot('delta-a');
});
test('changed controls and removed refs surface as a bounded delta',()=>{
  clearGroundSnapshot('delta-b');
  diffGroundSnapshot('delta-b',payload('/a',[one,two]));
  const changed=diffGroundSnapshot('delta-b',payload('/a',[{...one,text:'Saved'}]));
  assert.equal(changed.mode,'delta');
  assert.equal(changed.changes[0].text,'Saved');
  assert.deepEqual(changed.removed,['e2']);
  clearGroundSnapshot('delta-b');
});
test('navigation resets baseline rather than returning misleading delta',()=>{
  clearGroundSnapshot('delta-c');
  diffGroundSnapshot('delta-c',payload('/a',[one]));
  assert.equal(diffGroundSnapshot('delta-c',payload('/b',[one])).mode,'full');
  clearGroundSnapshot('delta-c');
});
test('snapshot scope is per session and query',()=>{
  clearGroundSnapshot('delta-d');
  assert.equal(diffGroundSnapshot('delta-d',payload('/a',[one]),{query:'save'}).mode,'full');
  assert.equal(diffGroundSnapshot('delta-d',payload('/a',[one]),{query:'home'}).mode,'full');
  assert.equal(diffGroundSnapshot('delta-d',payload('/a',[one]),{query:'save'}).mode,'unchanged');
  clearGroundSnapshot('delta-d');
});
test('tool and UI expose optional delta mode and minimal visual response',()=>{
 const web=fs.readFileSync('src/core/tools/web.js','utf8');
 const app=fs.readFileSync('src/ui/app.js','utf8');
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(web,/diffGroundSnapshot\(session,visible/);
 assert.match(web,/deltaMode:snap\?\.mode/);
 assert.match(app,/ev\.meta\?\.deltaMode==='delta'/);
 assert.match(html,/#composer #work-progress\[data-phase="delta"\]/);
});
