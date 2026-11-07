import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {noteBrowserAction,observeBrowserPage,clearBrowserStagnation} from '../src/core/browser-stagnation.js';

const page=(text='Same page',url='https://example.test')=>({url,title:'Example',text,controls:[{selector:'#send',label:'Send'}]});
test('reads alone never count as browser-action stagnation',()=>{
  const s='reads-only';
  for(let i=0;i<12;i++)assert.equal(observeBrowserPage(s,page()).stagnant,false);
  clearBrowserStagnation(s);
});
test('two completed actions with same observed page produce advisory',()=>{
  const s='unchanged';
  observeBrowserPage(s,page());
  noteBrowserAction(s);
  assert.equal(observeBrowserPage(s,page()).unchangedActions,1);
  noteBrowserAction(s);
  const p=observeBrowserPage(s,page());
  assert.equal(p.stagnant,true);
  assert.equal(p.unchangedActions,2);
  clearBrowserStagnation(s);
});
test('real content or URL change resets stagnation and keeps sessions isolated',()=>{
  observeBrowserPage('a',page());observeBrowserPage('b',page());
  for(let i=0;i<2;i++){noteBrowserAction('a');observeBrowserPage('a',page());}
  assert.equal(observeBrowserPage('a',page()).stagnant,true);
  noteBrowserAction('a');
  assert.equal(observeBrowserPage('a',page('New visible result')).stagnant,false);
  noteBrowserAction('b');
  assert.equal(observeBrowserPage('b',page('Other','https://example.test/next')).stagnant,false);
  clearBrowserStagnation('a');clearBrowserStagnation('b');
});
test('tool and one-line UI are actually wired to browser stagnation evidence',()=>{
  const tools=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(tools,/observeBrowserPage\(session/);
  assert.match(tools,/noteBrowserAction\(session\)/);
  assert.match(tools,/clearBrowserStagnation\(ctx.session/);
  assert.match(app,/meta\?\.stagnation\?\.stagnant===true/);
  assert.match(html,/data-phase="stagnation"/);
});

test('long page tail progress resets stagnation without recording raw text',()=>{
 const s='tail-observation-round';
 const long='X'.repeat(16000);
 observeBrowserPage(s,page(long+' Pending'));
 for(let i=0;i<2;i++){noteBrowserAction(s);observeBrowserPage(s,page(long+' Pending'));}
 assert.equal(observeBrowserPage(s,page(long+' Pending')).stagnant,true);
 noteBrowserAction(s);
 assert.equal(observeBrowserPage(s,page(long+' Saved')).stagnant,false);
 clearBrowserStagnation(s);
});
test('last checked control on a large form is not considered stagnant',()=>{
 const s='tail-control-round';
 const controls=Array.from({length:60},(_,i)=>({selector:'#control-'+i,label:'Label '+i,checked:false}));
 const state={...page(),controls};
 observeBrowserPage(s,state);
 for(let i=0;i<2;i++){noteBrowserAction(s);observeBrowserPage(s,state);}
 assert.equal(observeBrowserPage(s,state).stagnant,true);
 const changed=controls.map(x=>({...x}));changed[59].checked=true;
 noteBrowserAction(s);
 assert.equal(observeBrowserPage(s,{...state,controls:changed}).stagnant,false);
 clearBrowserStagnation(s);
});
test('consolidated stagnation visual stays accessible and inline',()=>{
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(html,/majin-stagnation-orbit/);
 assert.match(html,/prefers-reduced-motion:reduce/);
});

test('newly enabled submit control resets stagnation warning',()=>{
 const session='enable-control-consolidated';
 const state={...page(),controls:[{selector:'#submit',label:'Submit',enabled:false,checked:false}]};
 observeBrowserPage(session,state);
 for(let i=0;i<2;i++){noteBrowserAction(session);observeBrowserPage(session,state)}
 assert.equal(observeBrowserPage(session,state).stagnant,true);
 noteBrowserAction(session);
 assert.equal(observeBrowserPage(session,{...state,controls:[{...state.controls[0],enabled:true}]}).stagnant,false);
 clearBrowserStagnation(session);
});

test('large form changes in middle and inserted fields are detected',()=>{
 const s='rebased-middle';const controls=Array.from({length:55},(_,i)=>({selector:'#field-'+i,label:'Field '+i,checked:false,enabled:false}));
 const state={...page(),controls};observeBrowserPage(s,state);
 for(let i=0;i<2;i++){noteBrowserAction(s);observeBrowserPage(s,state);}
 assert.equal(observeBrowserPage(s,state).stagnant,true);
 const changed=controls.map(x=>({...x}));changed[29].enabled=true;
 noteBrowserAction(s);assert.equal(observeBrowserPage(s,{...state,controls:changed}).stagnant,false);
 noteBrowserAction(s);observeBrowserPage(s,state);
 noteBrowserAction(s);assert.equal(observeBrowserPage(s,{...state,controls:[...controls.slice(0,25),{selector:'#extra',label:'Extra'},...controls.slice(25)]}).stagnant,false);
 clearBrowserStagnation(s);
});
