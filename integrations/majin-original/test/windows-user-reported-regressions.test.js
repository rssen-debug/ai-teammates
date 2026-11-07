import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../src/core/tools/index.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=p=>fs.readFileSync(path.join(root,p),'utf8');

test('packaged Windows updater has no dynamic imports; its crypto and process APIs are static',()=>{
  const content=source('src/core/update.js');
  assert.doesNotMatch(content,/await\s+import\s*\(/,'pkg Windows VM cannot resolve dynamic import callbacks');
  assert.match(content,/import\s+\{\s*spawn\s+as\s+spawnProcess\s*\}\s+from\s+'node:child_process'/);
  assert.match(content,/crypto\.createHash\('sha256'\)/);
});
test('screen.capture statically binds filesystem and writes PNG in Windows',()=>{
  const content=source('src/core/tools/net.js');
  assert.match(content,/import fsSync from 'node:fs'/);
  assert.doesNotMatch(content,/const fsSync = await import/);
  assert.match(content,/\[Drawing\.Imaging\.ImageFormat\]::Png/);
  const screen=ALL_TOOLS.find(x=>x.name==='screen.capture');
  assert.ok(screen);
});
test('mouse.move is a distinct guarded Windows action, never a false pink cursor proof',()=>{
  const mouse=ALL_TOOLS.find(x=>x.name==='mouse.move');
  assert.ok(mouse);
  assert.equal(mouse.risk,'exec');
  assert.deepEqual(mouse.parameters.required,['x','y']);
  assert.match(source('src/core/tools/wincontrol.js'),/MAJIN_POINTER_VERIFIED/);
  const overlay=ALL_TOOLS.find(x=>x.name==='cursor.overlay');
  assert.ok(overlay);
});
test('Discord channel.send has no irrelevant required url/subject parameters',()=>{
  const tool=ALL_TOOLS.find(x=>x.name==='channel.send');
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required,['channel','text']);
  assert.equal(tool.parameters.properties.subject.type,'string');
});
test('MAJIN provides safe workspace previews directly in assistant chat',()=>{
  const app=source('src/ui/app.js');
  assert.match(app,/chat-open-file/);
  assert.match(app,/MAJIN_STUDIO\?\.previewFile/);
  assert.match(source('src/ui/onboard.js'),/Show OpenCode Go models/);
  assert.match(source('src/core/pink-cursor.js'),/Get-Content \$StateFile -Raw -Encoding UTF8/);
});
