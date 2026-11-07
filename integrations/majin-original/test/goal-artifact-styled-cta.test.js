import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRequestedArtifact } from '../src/core/goal-artifact.js';
const ws=fs.mkdtempSync(path.join(os.tmpdir(),'majin-cta-contract-'));
const name='cta-landing.html';
const goal='Build a single-file HTML landing page in '+name+' with a heading, a styled CTA button, a responsive viewport meta tag and a CSS style element.';
const base='<html><head><meta name="viewport" content="width=device-width"><style>body{background:#fff}</style></head><body><h1>Hero</h1><button>Buy</button></body></html>';
test('style tag without CTA styling is NOT good enough',()=>{
  fs.writeFileSync(path.join(ws,name),base);
  const r=inspectRequestedArtifact(goal,ws);
  assert.equal(r.ok,false);
  assert.ok(r.missing.some(x=>/styled CTA/i.test(x)),r.missing.join(','));
});
test('actual CSS button rule satisfies explicitly styled CTA',()=>{
  fs.writeFileSync(path.join(ws,name),base.replace('body{background:#fff}','body{background:#fff}button{background:#000;color:#fff}'));
  assert.equal(inspectRequestedArtifact(goal,ws).ok,true);
});
test('inline button style also satisfies CTA while preserving other requirements',()=>{
  fs.writeFileSync(path.join(ws,name),base.replace('<button>','<button style="background:black;color:white">'));
  assert.equal(inspectRequestedArtifact(goal,ws).ok,true);
});
