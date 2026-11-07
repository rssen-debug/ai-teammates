import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('local narrator remains opt-in and only calls loopback',()=>{
 const s=fs.readFileSync('src/ui/app.js','utf8');
 assert.match(s,/127\.0\.0\.1:18765\/speak/);
 assert.match(s,/if\(S\.narratorEnglish === true\)/);
 assert.match(s,/S\.narratorEnglish === true/);
 assert.match(s,/localStorage\.setItem\('majin\.voice\.narratorEN'/);
 assert.match(s,/new Audio\(url\)/);
 assert.match(s,/await browserNarrator\(clean\)/);
 assert.match(s,/if\(S\.handsFree&&!S\.busy\)startMic\(\)/);
});
test('narrator UI mode and setup exist without model download on app launch',()=>{
 const h=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(h,/id="b-narrator"/);
 assert.match(h,/Narrator EN/);
 const p=fs.readFileSync('scripts/majin-kokoro-voice.py','utf8');
 assert.match(p,/127\.0\.0\.1/);
 assert.match(p,/kokoro_onnx import Kokoro/);
 assert.match(p,/MAX_TEXT_BYTES = 4096/);
 assert.match(p,/valid_origin/);
 assert.match(fs.readFileSync('scripts/install-kokoro-voice.ps1','utf8'),/kokoro-v1\.0\.onnx/);
});
test('V4 release identifiers align (4.0.0-alpha.3)',()=>{
 for(const f of ['package.json','package-lock.json'])assert.equal(JSON.parse(fs.readFileSync(f,'utf8')).version,'4.0.0-alpha.3');
 assert.equal(JSON.parse(fs.readFileSync('package-lock.json','utf8')).packages[''].version,'4.0.0-alpha.3');
 for(const f of ['src/core/version.js','installer/majin.iss','scripts/publish.ps1'])assert.match(fs.readFileSync(f,'utf8'),/4\.0\.0-alpha\.3/);
});
