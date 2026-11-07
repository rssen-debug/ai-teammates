import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('browser.click rejects ambiguous selectors BEFORE clicking',()=>{
 const s=fs.readFileSync('src/core/tools/web.js','utf8');
 const start=s.indexOf("name: 'browser.click'");
 const end=s.indexOf("name: 'browser.fill'",start);
 const click=s.slice(start,end);
 assert.ok(start>=0 && end>start);
 assert.match(click,/const queryDeep=\(css\)=>/);
 assert.match(click,/matches\.length > 1/);
 assert.match(click,/blocked:'ambiguous_target'/);
 assert.ok(click.indexOf("blocked:'ambiguous_target'")<click.indexOf('el.click()'),'must reject ambiguity before side effects');
 assert.match(click,/blocked:'occluded'/);
 assert.match(click,/blocked:'disabled'/);
});
test('one-line agent trace stays inside composer and respects reduced-motion settings',()=>{
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(html,/#composer #work-progress:not\(\[hidden\]\)::after/);
 assert.match(html,/@keyframes majin-trace-sweep/);
 assert.match(html,/prefers-reduced-motion:reduce/);
 assert.match(html,/height:1px/);
});
