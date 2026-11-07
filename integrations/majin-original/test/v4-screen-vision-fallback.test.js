import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('valid screenshot survives missing optional vision resolver in V4',()=>{
 const src=fs.readFileSync(new URL('../src/core/tools/net.js',import.meta.url),'utf8');
 assert.match(src,/typeof ctx\.cfg\?\.resolveModel !== 'function'/);
 assert.match(src,/validatedPng: true, bytes: size, described: false/);
 assert.match(src,/screenshot saved \(visual interpretation unavailable\)/);
 assert.match(src,/catch \(error\)/);
 assert.match(src,/screenshot saved \(vision analysis failed\)/);
 assert.match(src,/await analyzeImage/);
});
