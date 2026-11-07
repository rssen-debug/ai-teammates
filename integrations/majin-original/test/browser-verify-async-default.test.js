import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('browser.verify waits for SPA DOM outcomes by default, but permits explicit immediate checks',()=>{
 const src=fs.readFileSync('src/core/tools/web.js','utf8');
 assert.match(src,/Number\(input\?\.waitMs \?\? 1800\)/);
 assert.match(src,/Math\.min\(5000,Math\.max\(0/);
 assert.match(src,/await b\.eval\(script\)/);
 assert.match(src,/if\(verdict\.ok\)/);
 assert.match(src,/setTimeout\(resolve,Math\.min\(120/);
});
test('single chat composer conveys verified and stalled states without extra cards',()=>{
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(html,/#composer #work-progress\[data-phase="verified"\] \.pulse::before\{content:"✓"/);
 assert.match(html,/#composer #work-progress\[data-phase="stalled"\] \.pulse/);
 assert.match(html,/prefers-reduced-motion:reduce/);
 assert.equal((html.match(/id="work-progress"/g)||[]).length,1);
});
