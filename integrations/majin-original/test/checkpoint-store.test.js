import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkpointPath,saveCheckpoint,loadCheckpoint } from '../src/core/checkpoint-store.js';

test('atomic checkpoint roundtrip and replacement', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal(loadCheckpoint(dir,'task_1'),null);
 saveCheckpoint(dir,'task_1',{step:1});
 assert.equal(loadCheckpoint(dir,'task_1').state.step,1);
 saveCheckpoint(dir,'task_1',{step:2});
 assert.equal(loadCheckpoint(dir,'task_1').state.step,2);
 assert.deepEqual(fs.readdirSync(dir),['task_1.json']);
});
test('checkpoint ids cannot escape storage folder',()=>{
 assert.throws(()=>checkpointPath('/tmp','../oops'),/Invalid checkpoint/);
 assert.throws(()=>checkpointPath('/tmp',''),/Invalid checkpoint/);
});
test('checkpoint size and schema are bounded',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.throws(()=>saveCheckpoint(dir,'huge',{value:'x'.repeat(1100000)}),/too large/);
 fs.writeFileSync(checkpointPath(dir,'bad'),JSON.stringify({schema:4,id:'bad',state:{}}));
 assert.throws(()=>loadCheckpoint(dir,'bad'),/Invalid checkpoint schema/);
});

test('checkpoint rejects oversize input before reading or parsing',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(checkpointPath(dir,'too_big'),'x'.repeat(1100000));
 assert.throws(()=>loadCheckpoint(dir,'too_big'),/Invalid checkpoint file size/);
});

test('checkpoint loader rejects symlink files',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'target.json'),JSON.stringify({schema:1,id:'alias',state:{}}));
 try { fs.symlinkSync(path.join(dir,'target.json'),checkpointPath(dir,'alias')); }
 catch (e) { if (e.code==='EPERM'||e.code==='EACCES') { t.skip('symlinks unavailable'); return; } throw e; }
 assert.throws(()=>loadCheckpoint(dir,'alias'),/Invalid checkpoint file size/);
});

test('checkpoint state rejects BigInt rather than creating a partial file',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.throws(()=>saveCheckpoint(dir,'bigint',{value:1n}),/BigInt unsupported/);
 assert.deepEqual(fs.readdirSync(dir),[]);
});

test('checkpoint reader rejects a symlink swapped into place',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'outside.json');
 fs.writeFileSync(target,JSON.stringify({schema:1,id:'race',state:{ok:true}}));
 try { fs.symlinkSync(target,checkpointPath(dir,'race')); }
 catch(e){ if(['EPERM','EACCES'].includes(e.code)){t.skip('symlink unavailable');return;}throw e; }
 assert.throws(()=>loadCheckpoint(dir,'race'),/Invalid checkpoint file size|ELOOP/);
});

test('checkpoint saving rejects a symlinked destination',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'target');
 fs.writeFileSync(target,'untouched');
 try { fs.symlinkSync(target,checkpointPath(dir,'link')); }
 catch(e){ if(['EPERM','EACCES'].includes(e.code)){t.skip('symlinks unavailable');return;}throw e; }
 assert.throws(()=>saveCheckpoint(dir,'link',{step:1}),/Unsafe checkpoint destination/);
 assert.equal(fs.readFileSync(target,'utf8'),'untouched');
});

test('checkpoint load refuses symbolic-link storage root',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-checkpoint-root-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const real=path.join(dir,'real');fs.mkdirSync(real);
 saveCheckpoint(real,'demo',{safe:true});
 const link=path.join(dir,'alias');
 try{fs.symlinkSync(real,link,'dir');}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('symlinks unavailable');return;}throw e;}
 assert.throws(()=>loadCheckpoint(link,'demo'),/Invalid checkpoint directory/);
 assert.equal(loadCheckpoint(real,'demo').state.safe,true);
});
