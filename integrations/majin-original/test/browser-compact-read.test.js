import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactBrowserText } from '../src/core/browser-compact.js';

test('compact browser read is bounded and does not mutate source',()=>{
  const source=Array.from({length:140},(_,i)=>'Item '+i+' : '+('Example page content '.repeat(7))).join('\n');
  const before=source;
  const out=compactBrowserText(source);
  assert.equal(source,before);
  assert.ok(out.outputChars<=2600);
  assert.ok(out.outputChars<out.originalChars);
  assert.match(out.text,/Item 0/);
  assert.equal(out.truncated,true);
});
test('short and repetitive page content is preserved without invented evidence',()=>{
  const source='Dashboard\nSave\nSave\nAccount';
  const out=compactBrowserText(source);
  assert.match(out.text,/Dashboard/);
  assert.match(out.text,/Account/);
  assert.equal(out.uniqueLines,3);
  assert.ok(!out.text.includes('password'));
});
test('browser.read compact is explicitly opt-in and visible as one inline activity indicator',()=>{
  const web=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(web,/String\(mode\)\.toLowerCase\(\)==='compact'/);
  assert.match(web,/compactBrowserText\(sourceText\)/);
  assert.match(web,/visibleChars:compressed\.outputChars/);
  assert.match(app,/ev\.meta\?\.mode==='compact'/);
  assert.match(html,/work-progress\[data-phase="compact"\]/);
});

test('long head rows never displace end-of-page success or failure evidence',()=>{
 for(const rowCount of [20,100]){
   const rows=Array.from({length:rowCount-1},(_,i)=>'Section '+i+' '+('details '.repeat(100)));
   rows.push('FINAL STATUS: operation failed');
   const out=compactBrowserText(rows.join('\n'),{maxChars:1000});
   assert.match(out.text,/FINAL STATUS: operation failed/);
   assert.match(out.text,/Section 0/);
   assert.ok(out.outputChars<=1000);
 }
});
test('browser evidence UI uses only existing composer and reduced motion',()=>{
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.ok(html.includes('majin-compact-evidence-glow'));
 assert.match(html,/prefers-reduced-motion:reduce/);
});

test('same initial 180 characters do not collapse different result rows',()=>{
 const prefix='Result '+('x'.repeat(190));
 const source=prefix+' FAILED\n'+prefix+' SAVED';
 const out=compactBrowserText(source,{maxChars:1200});
 assert.equal(out.uniqueLines,2);
 assert.match(out.text,/FAILED/);
 assert.match(out.text,/SAVED/);
});
