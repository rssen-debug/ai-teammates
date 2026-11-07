import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MemoryStore,MEMORY_KINDS} from '../../src/v2/memory/store.js';
import {syncPair} from '../../src/core/memory-sync.js';
import {Memory} from '../../src/core/memory.js';
import {runTool} from '../../src/v2/tools/runner.js';
import {createToolRegistry} from '../../src/v4/tools.js';
import {tempHome} from './helpers.mjs';

const files=dir=>fs.existsSync(dir)?Object.fromEntries(fs.readdirSync(dir).sort().filter(n=>fs.statSync(path.join(dir,n)).isFile()).map(n=>[n,fs.readFileSync(path.join(dir,n),'utf8')])):null;
const setup=()=>{const home=tempHome();return {home,a:new MemoryStore(path.join(home,'a')),b:new MemoryStore(path.join(home,'b'))};};

test('memory_save never acknowledges saved when retention drops the new entry',async()=>{
  const home=tempHome();
  try{
    const tools=createToolRegistry({workspaceDir:path.join(home,'workspace'),memoryDir:path.join(home,'memory')});
    tools.memory.maxEntriesPerNs=1;
    tools.memory.put('preference',{key:'important',text:'keep this',importance:1});
    await assert.rejects(runTool({tool:'memory_save',input:{key:'dropped',text:'must not claim saved'}},{registry:tools.registry,approvals:{check:()=>({decision:'allow'})}}),/not retained/);
    assert.equal(tools.memory.get('preference','important').text,'keep this');
    assert.equal(tools.memory.get('preference','dropped'),null);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('empty-store directory aliases are refused before minting an identity or writing data',()=>{
  const {home,a}=setup();
  try{
    const alias=path.join(home,'alias');fs.symlinkSync(a.dir,alias,'junction');
    const b=new MemoryStore(alias,{create:false}),before=files(a.dir);
    assert.equal(syncPair(a,b,{dryRun:true}).error.code,'same_store');
    assert.equal(syncPair(a,b).error.code,'same_store');assert.deepEqual(files(a.dir),before);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('canonical sync preserves every namespace, exact keys, long text, tags, importance and metadata; repeat is inert',()=>{
  const {home,a,b}=setup();
  try{
    const text='A full entry longer than the legacy delta truncation. '.repeat(30);
    a.put('preference',{key:'__proto__',text,tags:['English','voice'],importance:0.9,meta:JSON.parse('{"__proto__":{"kept":true},"nested":{"value":123}}')});
    b.put('project',{key:'__proto__',text:'A different namespace',tags:['project'],importance:0.3});
    for(const kind of MEMORY_KINDS)if(!['preference','project'].includes(kind))a.put(kind,{key:'namespace-check',text:'Preserve '+kind,tags:[kind],importance:0.7,meta:{kind}});
    const original=a.get('preference','__proto__');
    const result=syncPair(a,b);assert.equal(result.ok,true);assert.equal(result.version,'majin-memory-records/1');
    assert.deepEqual(b.get('preference','__proto__'),original);assert.equal(a.get('project','__proto__').text,'A different namespace');
    for(const kind of MEMORY_KINDS)assert.ok(a.list(kind).length&&b.list(kind).length,kind+' transferred');
    const before=[files(a.dir),files(b.dir)],again=syncPair(a,b);
    assert.equal(again.aReceived.applied,0);assert.equal(again.bReceived.applied,0);assert.deepEqual([files(a.dir),files(b.dir)],before);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('deletion survives stale peers and reload; explicit later re-add wins without wall-clock dependence',()=>{
  const {home,a,b}=setup();
  try{
    a.put('preference',{key:'voice',text:'old'});syncPair(a,b);
    a.delete('preference','voice');b.put('preference',{key:'other',text:'unrelated'});syncPair(a,b);
    assert.equal(a.get('preference','voice'),null);assert.equal(b.get('preference','voice'),null);
    const fresh=new MemoryStore(b.dir);fresh.put('preference',{key:'voice',text:'explicit new value'});syncPair(a,fresh);
    assert.equal(a.get('preference','voice').text,'explicit new value');assert.equal(b.get('preference','voice').text,'explicit new value','existing readers observe atomically replaced files');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('concurrent deletion wins an equal-counter update; clear and retention propagate tombstones',()=>{
  const {home,a,b}=setup();
  try{
    a.put('task',{key:'same',text:'old'});syncPair(a,b);
    a.delete('task','same');b.put('task',{key:'same',text:'concurrent'});syncPair(a,b);
    assert.equal(b.get('task','same'),null);
    a.put('preference',{key:'keep',text:'important',importance:1});syncPair(a,b);
    a.maxEntriesPerNs=1;a.put('preference',{key:'low',text:'low priority',importance:0});syncPair(a,b);
    assert.equal(b.get('preference','low'),null);
    a.clear('preference');syncPair(a,b);assert.equal(b.list('preference').length,0);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('dry run writes no identity, namespace, ledger or target directory, including legacy core sync',()=>{
  const {home,a}=setup();
  try{
    a.put('preference',{key:'language',text:'English'});
    const absent=path.join(home,'not-created'),peer=new MemoryStore(absent,{create:false}),before=files(a.dir);
    assert.equal(syncPair(a,peer,{dryRun:true}).bReceived.applied,1);assert.deepEqual(files(a.dir),before);assert.equal(fs.existsSync(absent),false);
    const x=new Memory({get:k=>k==='memory.dir'?path.join(home,'legacy-a'):undefined});
    const y=new Memory({get:k=>k==='memory.dir'?path.join(home,'legacy-b'):undefined});
    x.remember('unchanged in dry run');const original=[files(x.dir),files(y.dir)];
    syncPair(x,y,{dryRun:true});assert.deepEqual([files(x.dir),files(y.dir)],original);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('conflicting updates converge deterministically and capacity refusal preserves both stores byte-for-byte',()=>{
  const {home,a,b}=setup();
  try{
    a.put('preference',{key:'same',text:'a'});b.put('preference',{key:'same',text:'b'});
    const expected=[a.get('preference','same'),b.get('preference','same')].sort((x,y)=>x.syncVersion.actor.localeCompare(y.syncVersion.actor)).at(-1);
    syncPair(a,b);assert.deepEqual(a.get('preference','same'),expected);assert.deepEqual(b.get('preference','same'),expected);
    a.put('preference',{key:'extra',text:'extra'});b.maxEntriesPerNs=1;
    const before=[files(a.dir),files(b.dir)];assert.throws(()=>syncPair(a,b),/capacity/);assert.deepEqual([files(a.dir),files(b.dir)],before);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('corrupt, incompatible and cloned stores are retained and refused',()=>{
  const {home,a,b}=setup();
  try{
    a.put('preference',{key:'safe',text:'kept'});
    fs.writeFileSync(path.join(b.dir,'preference.json'),'{corrupt');const before=[files(a.dir),files(b.dir)];
    assert.throws(()=>syncPair(a,b));assert.deepEqual([files(a.dir),files(b.dir)],before);
    fs.writeFileSync(path.join(b.dir,'preference.json'),JSON.stringify({schema:'majin.v2.memory/v1',entries:[]}));
    fs.writeFileSync(path.join(b.dir,'memory-sync-id.json'),fs.readFileSync(path.join(a.dir,'memory-sync-id.json')));
    assert.equal(syncPair(a,b).error.code,'same_store');
    const legacy=new Memory({get:k=>k==='memory.dir'?path.join(home,'legacy'):undefined});
    legacy.remember('V1 text must not be silently converted');assert.equal(syncPair(a,legacy).error.code,'incompatible_store');
    assert.throws(()=>syncPair(a,new MemoryStore(legacy.dir)),/explicit migration/);
    assert.throws(()=>a.get('../outside','x'),/Unknown memory kind/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('partial two-store failure is recoverable without re-versioning or losing data',()=>{
  const {home,a,b}=setup();
  try{
    a.put('project',{key:'a',text:'a'});b.put('project',{key:'b',text:'b'});
    const real=b.applySyncRecords.bind(b);b.applySyncRecords=()=>{throw Error('controlled write interruption');};
    assert.throws(()=>syncPair(a,b),/controlled write interruption/);assert.equal(a.list('project').length,2);assert.equal(b.list('project').length,1);
    b.applySyncRecords=real;syncPair(a,b);assert.equal(b.list('project').length,2);
    const again=syncPair(a,b);assert.equal(again.aReceived.applied+again.bReceived.applied,0);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('real child process exits, then canonical records and deletion metadata reload and converge',()=>{
  const {home,a,b}=setup();
  try{
    const storeUrl=new URL('../../src/v2/memory/store.js',import.meta.url).href,syncUrl=new URL('../../src/core/memory-sync.js',import.meta.url).href;
    const child=`import {MemoryStore} from ${JSON.stringify(storeUrl)};import {syncPair} from ${JSON.stringify(syncUrl)};const a=new MemoryStore(process.argv[1]),b=new MemoryStore(process.argv[2]);if(!a.get('preference','persistent'))a.put('preference',{key:'persistent',text:'survived process exit'});syncPair(a,b);`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',child,a.dir,b.dir],{encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr);
    assert.equal(a.get('preference','persistent').text,'survived process exit');assert.equal(b.get('preference','persistent').text,'survived process exit');
    a.delete('preference','persistent');syncPair(new MemoryStore(a.dir),new MemoryStore(b.dir));assert.equal(b.get('preference','persistent'),null);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('V4 sync is approval-held and enforces live folder grants before any target write',async()=>{
  const home=tempHome(),workspaceDir=path.join(home,'workspace'),target=path.join(home,'shared','memory');let folders=[];
  const tools=createToolRegistry({workspaceDir,memoryDir:path.join(home,'canonical'),allowedRoots:()=>folders});
  const input={target,dryRun:false};
  const call=approvals=>runTool({tool:'memory_sync',input},{registry:tools.registry,approvals});
  try{
    tools.memory.put('preference',{key:'owner',text:'private controlled memory'});
    assert.equal((await call({check:()=>({decision:'waiting'})})).decision,'waiting');assert.equal(fs.existsSync(target),false);
    await assert.rejects(call({check:()=>({decision:'allow'})}),e=>e.cls==='PERMISSION_DENIED');assert.equal(fs.existsSync(target),false);
    folders=[path.join(home,'shared')];
    assert.equal((await call({check:()=>({decision:'allow'})})).data.bReceived.applied,1);
    assert.equal(new MemoryStore(target).get('preference','owner').text,'private controlled memory');
    const before=files(target);folders=[];
    await assert.rejects(call({check:()=>({decision:'allow'})}),e=>e.cls==='PERMISSION_DENIED');assert.deepEqual(files(target),before);
    folders=[home];
    const sourceBefore=files(tools.memory.dir);
    for(const overlap of [tools.memory.dir,path.join(tools.memory.dir,'nested'),home]){
      await assert.rejects(runTool({tool:'memory_sync',input:{target:overlap,dryRun:false}},{registry:tools.registry,approvals:{check:()=>({decision:'allow'})}}),e=>e.cls==='PERMISSION_DENIED'&&/non-overlapping/.test(e.message));
    }
    assert.deepEqual(files(tools.memory.dir),sourceBefore);assert.equal(fs.existsSync(path.join(tools.memory.dir,'nested')),false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
