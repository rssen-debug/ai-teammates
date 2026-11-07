import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OUTLINE_JS, formatPageOutline } from '../src/core/browser-outline.js';

test('page outline script is read-only, bounded and does not expose input values',()=>{
  assert.match(OUTLINE_JS,/aria-label/);
  assert.match(OUTLINE_JS,/entries\.length >= limit/);
  assert.match(OUTLINE_JS,/^\(\(\) => \{/);
  assert.doesNotMatch(OUTLINE_JS,/\.value|document\.cookie|localStorage|\.outerHTML/);
  assert.doesNotMatch(OUTLINE_JS,/\.click\(|\.setAttribute\(/);
});
test('outline formats headings and regions with bounded safe text',()=>{
  const result=formatPageOutline({title:'Test',entries:[
    {role:'main',name:'Content',level:null},
    {role:'h2',name:'Billing\nOverview',level:2},
    {role:'navigation',name:'Menu',level:null}
  ]});
  assert.match(result,/Page structure — Test/);
  assert.match(result,/h2 2 "Billing Overview"/);
  assert.match(result,/navigation "Menu"/);
  assert.ok(result.split('\n').length<=5);
});
test('outline is opt-in on existing browser.elements tool, with no new permissions',()=>{
  const tools=fs.readFileSync('src/core/tools/web.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(tools,/outline = 'false'/);
  assert.match(tools,/b\.eval\(OUTLINE_JS\)/);
  assert.match(tools,/pageOutline \? result/);
  assert.match(html,/@keyframes majin-trace/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});

test('outline bounds invalid and oversized limits without unbounded output',()=>{
 const entries=Array.from({length:70},(_,i)=>({role:'heading',name:'Heading '+i}));
 assert.doesNotMatch(formatPageOutline({entries},{cap:-1}),/Heading 0/);
 const out=formatPageOutline({entries},{cap:99999});
 assert.match(out,/Heading 54/);
 assert.doesNotMatch(out,/Heading 55/);
});
