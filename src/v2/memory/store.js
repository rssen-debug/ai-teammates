/**
 * V2 memory store (master brief section 8).
 *
 * JSON-file-backed, namespaced, user-controllable memory. Zero dependencies
 * (unit of truth = one file per namespace inside a store directory; the
 * node:sqlite decision is documented and deferred to alpha packaging).
 * Families match the brief: conversation / project / task / preference /
 * tool-success / failure-pattern / workflow / environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnId,RECORD_VERSION} from '../../core/memory-sync.js';

export const MEMORY_KINDS = Object.freeze([
  'conversation', 'project', 'task', 'preference',
  'tool-success', 'failure-pattern', 'workflow', 'environment',
]);

export const MEMORY_SCHEMA = 'majin.v2.memory/v1';

export class MemoryStore {
  constructor(dir, { maxEntriesPerNs = 2000, create = true } = {}) {
    if (!dir) throw new Error('MemoryStore requires a directory');
    this.dir = dir;
    this.maxEntriesPerNs = maxEntriesPerNs;
    if(create)fs.mkdirSync(dir, { recursive: true, mode:0o700 });
  }

  #fileFor(ns) {
    if(!MEMORY_KINDS.includes(ns))throw Error('Unknown memory kind');
    return path.join(this.dir, `${ns}.json`);
  }

  #document(ns) {
    const file=this.#fileFor(ns);
    try{
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8_000_000)throw Error('Unsafe memory namespace file');
      const doc=JSON.parse(fs.readFileSync(file,'utf8'));
      if(doc?.schema!==MEMORY_SCHEMA||!Array.isArray(doc.entries))throw Error('Invalid memory namespace; existing file retained');
      if(doc.kind!==undefined&&doc.kind!==ns)throw Error('Memory namespace label mismatch');
      if(doc.syncSchema&&doc.syncSchema!==RECORD_VERSION)throw Error('Unsupported memory sync metadata');
      if(doc.tombstones!==undefined&&!Array.isArray(doc.tombstones))throw Error('Invalid memory tombstones');
      return doc;
    }catch(error){if(error.code==='ENOENT')return {schema:MEMORY_SCHEMA,kind:ns,entries:[],tombstones:[]};throw error;}
  }

  #loadNs(ns) {
    // A second host or a sync may replace this file. Never serve a stale cache.
    this.#fileFor(ns);
    try{return this.#document(ns).entries;}catch{return [];}
  }

  #writeNs(ns, entries, tombstones = []) {
    const file=this.#fileFor(ns),doc=this.#document(ns);
    const payload=JSON.stringify({...doc,schema:MEMORY_SCHEMA,kind:ns,syncSchema:RECORD_VERSION,entries,tombstones},null,2);
    if(Buffer.byteLength(payload)>8_000_000)throw Error('Memory namespace exceeds safe write size');
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const tmp=file+'.'+crypto.randomUUID()+'.tmp';
    try{
      const fd=fs.openSync(tmp,'wx',0o600);
      try{fs.writeFileSync(fd,payload);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(tmp,file);
    }finally{try{fs.unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }

  #nextVersion(){
    const {records}=this.syncSnapshot({dryRun:true});
    const counter=records.reduce((max,r)=>Math.max(max,r.version.counter),0)+1;
    if(!Number.isSafeInteger(counter))throw Error('Memory revision exhausted');
    return {counter,actor:spawnId(this)};
  }

  /** Canonical entries plus deletion metadata; no second materialized store. */
  syncSnapshot({dryRun=false}={}) {
    const names=(()=>{try{return fs.readdirSync(this.dir);}catch(error){if(error.code==='ENOENT')return [];throw error;}})();
    if(names.includes('facts.md')||names.includes('memory-state.json'))throw Error('V1 text memory requires explicit migration; no lossy sync');
    if(names.length&&!names.some(n=>MEMORY_KINDS.some(k=>n===k+'.json'))&&names.some(n=>n!=='memory-sync-id.json'))throw Error('Directory is not a recognized namespaced memory store');
    const actor=spawnId(this,{create:false}),records=[];
    for(const kind of MEMORY_KINDS){
      const doc=this.#document(kind);
      for(const e of doc.entries){
        const {syncVersion,...entry}=e;
        records.push({kind,key:entry.key,deleted:false,version:syncVersion||{counter:0,actor},entry});
      }
      for(const t of doc.tombstones||[])records.push({kind,key:t.key,deleted:true,version:t.version});
    }
    this.validateSyncRecords(records);
    if(dryRun)return {version:RECORD_VERSION,id:actor,records};
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const id=spawnId(this);
    // Legacy baseline entries receive a stable identity without rewriting data.
    for(const r of records)if(r.version.actor===actor&&actor.startsWith('preview-'))r.version={...r.version,actor:id};
    return {version:RECORD_VERSION,id,records};
  }

  validateSyncRecords(records){
    if(!Array.isArray(records)||Buffer.byteLength(JSON.stringify(records))>8_000_000)throw Error('Memory sync exceeds safe size');
    const seen=new Set(),counts=new Map();
    for(const r of records){
      if(!r||!MEMORY_KINDS.includes(r.kind)||typeof r.key!=='string'||!r.key||r.key.length>1000||typeof r.deleted!=='boolean')throw Error('Invalid namespaced memory record');
      const id=JSON.stringify([r.kind,r.key]);if(seen.has(id))throw Error('Duplicate memory record');seen.add(id);
      if(!Number.isSafeInteger(r.version?.counter)||r.version.counter<0||typeof r.version.actor!=='string'||!/^(mem-[a-f0-9]{12}|preview-[a-f0-9]{24})$/.test(r.version.actor))throw Error('Invalid memory record version');
      if(r.deleted){if(r.entry!==undefined)throw Error('Deleted memory record contains data');continue;}
      const e=r.entry;
      if(!e||e.key!==r.key||typeof e.text!=='string'||e.sensitive===true||!Array.isArray(e.tags)||e.tags.some(t=>typeof t!=='string')||!Number.isFinite(e.importance)||e.importance<0||e.importance>1)throw Error('Invalid or sensitive memory entry');
      counts.set(r.kind,(counts.get(r.kind)||0)+1);
      if(counts.get(r.kind)>this.maxEntriesPerNs)throw Error('Memory sync would exceed namespace capacity; nothing discarded');
    }
  }

  applySyncRecords(records){
    this.validateSyncRecords(records);
    const current=this.syncSnapshot();
    for(const kind of MEMORY_KINDS){
      const before=current.records.filter(r=>r.kind===kind),next=records.filter(r=>r.kind===kind);
      const order=rows=>JSON.stringify([...rows].sort((a,b)=>a.key.localeCompare(b.key)));
      if(order(before)===order(next))continue;
      const entries=next.filter(r=>!r.deleted).map(r=>({...r.entry,syncVersion:r.version}));
      entries.sort((a,b)=>(b.importance-a.importance)||String(b.at).localeCompare(String(a.at)));
      const tombstones=next.filter(r=>r.deleted).map(r=>({key:r.key,version:r.version}));
      this.#writeNs(kind,entries,tombstones);
    }
  }

  /**
   * Store an entry. ns must be a known kind; key dedupes within ns.
   * Entry: { key, text, tags[], importance 0..1, sensitive? (never serialized when true), meta? }
   */
  put(ns, { key, text, tags = [], importance = 0.5, sensitive = false, meta = null }) {
    if (!MEMORY_KINDS.includes(ns)) throw new Error(`unknown memory kind: ${ns}`);
    if (typeof key!=='string'||!key||key.length>1000||text == null) throw new Error('memory entry requires a string key and text');
    if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'))throw Error('Memory tags must be strings');
    if (sensitive === true) throw new Error('sensitive memory must never be stored (brief 8/57): invent a redacted form first');
    const doc=this.#document(ns),version=this.#nextVersion();
    const entries = doc.entries.filter((e) => e.key !== key);
    entries.push({
      key, text: String(text), tags: [...tags], importance: Math.max(0, Math.min(1, Number(importance) || 0)),
      meta, at: new Date().toISOString(),
      id: crypto.createHash('sha256').update(`${ns}:${key}`).digest('hex').slice(0, 16),
      syncVersion:version,
    });
    // retention: keep highest importance, newest first within ties
    entries.sort((a, b) => (b.importance - a.importance) || (b.at < a.at ? -1 : 1));
    const capped = entries.slice(0, this.maxEntriesPerNs);
    const tombstones=(doc.tombstones||[]).filter(t=>t.key!==key);
    for(const e of entries.slice(this.maxEntriesPerNs))tombstones.push({key:e.key,version});
    this.#writeNs(ns, capped,tombstones);
    return capped[capped.findIndex((e) => e.key === key)];
  }

  get(ns, key) { return this.#loadNs(ns).find((e) => e.key === key) || null; }
  list(ns, { last = 50 } = {}) { return this.#loadNs(ns).slice(0, last); }

  delete(ns, key) {
    if(typeof key!=='string'||!key||key.length>1000)throw Error('Invalid memory key');
    const doc=this.#document(ns),version=this.#nextVersion();
    const entries = doc.entries.filter((e) => e.key !== key);
    this.#writeNs(ns, entries,[...(doc.tombstones||[]).filter(t=>t.key!==key),{key,version}]);
    return true;
  }

  /**
   * Substring search over text+tags, ranked: tag hit > text hit, importance desc.
   * (Full-text/semantic ranking upgrades ride the sqlite/embedding decision —
   *  the API already accepts queries so the upgrade is invisible to callers.)
   */
  search(ns, query, { limit = 10 } = {}) {
    if (!query) return [];
    const q = String(query).toLowerCase();
    const hits = [];
    for (const e of this.#loadNs(ns)) {
      const tagHit = e.tags.some((t) => t.toLowerCase().includes(q)) ? 2 : 0;
      const textHit = e.text.toLowerCase().includes(q) ? 1 : 0;
      if (tagHit || textHit) hits.push({ e, score: tagHit || textHit });
    }
    return hits
      .sort((a, b) => (b.score - a.score) || (b.e.importance - a.e.importance))
      .slice(0, limit)
      .map((h) => h.e);
  }

  /** Export everything (user data ownership, brief 173). */
  exportAll() {
    const out = { schema: MEMORY_SCHEMA, exportedAt: new Date().toISOString(), kinds: {} };
    for (const k of MEMORY_KINDS) out.kinds[k] = this.#loadNs(k);
    return out;
  }

  /** Wipe one kind or the whole store (user control, brief 8.3). */
  clear(ns = null) {
    const kinds=ns?[ns]:MEMORY_KINDS;
    if(ns)this.#fileFor(ns);
    const version=this.#nextVersion();
    for(const kind of kinds){
      const doc=this.#document(kind),deleted=new Map((doc.tombstones||[]).map(t=>[t.key,t]));
      for(const e of doc.entries)deleted.set(e.key,{key:e.key,version});
      this.#writeNs(kind,[],[...deleted.values()]);
    }
  }
}
