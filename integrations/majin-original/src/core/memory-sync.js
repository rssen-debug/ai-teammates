/**
 * MAJIN W9 MEMORY SYNC — bidirectional, conflict-safe sync between two
 * Memory stores (e.g. this machine's MAJIN and a server/shared drive).
 *
 * Contract majin-memory-sync/1:
 * - every store has a persistent spawnId (own sidecar file, no core-memory
 *   schema change → backward compatible)
 * - sync = export deltas since last-applied origin rev, both directions
 * - replay is CONTENT-IDEMPOTENT: remember() skips identical facts (its own
 *   proof inside memory.js), forget() on an absent fact is a no-op — that is
 *   why the engine needs no vector clocks
 * - tombstone rule: a forget-delta replays forget(query) locally; a LATER
 *   re-add wins because it is a later delta in replay order
 * - dryRun measures everything and writes NOTHING (mirrors reset.plan)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 'majin-memory-sync/1';
export const RECORD_VERSION = 'majin-memory-records/1';

function sidecar(dir, name) { return path.join(dir, name); }

export function spawnId(mem, {create = true} = {}) {
  const f = sidecar(mem.dir, 'memory-sync-id.json');
  try {
    const stat=fs.lstatSync(f);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unsafe memory identity file');
    const id=JSON.parse(fs.readFileSync(f, 'utf8')).id;
    if(typeof id!=='string'||!/^mem-[a-f0-9]{12}$/.test(id))throw Error('Invalid memory identity; existing file retained');
    return id;
  } catch (error) { if(error.code!=='ENOENT')throw error; }
  if(!create){
    let canonical;try{canonical=fs.realpathSync(mem.dir);}catch(error){if(error.code!=='ENOENT')throw error;canonical=path.resolve(mem.dir);}
    return 'preview-'+crypto.createHash('sha256').update(canonical).digest('hex').slice(0,24);
  }
  const id = 'mem-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(f, JSON.stringify({ id, createdAt: new Date().toISOString() }) + '\n',{flag:'wx',mode:0o600});
  return id;
}

function ledger(mem) {
  const f = sidecar(mem.dir, 'memory-sync-ledger.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { appliedFrom: {} }; }
}
function noteApplied(mem, originId, rev) {
  const f = sidecar(mem.dir, 'memory-sync-ledger.json');
  const l = ledger(mem);
  l.appliedFrom[originId] = Math.max(l.appliedFrom[originId] || 0, rev);
  fs.writeFileSync(f, JSON.stringify(l) + '\n');
}

export function exportBundle(mem, { fromRev = 0, dryRun = false } = {}) {
  const deltas=mem.deltaSince(fromRev,{limit:500});
  if((deltas.length&&deltas[0].rev>fromRev+1)||(!deltas.length&&mem.rev()>fromRev))throw Error('Memory delta history has a gap; explicit full recovery is required');
  return {
    version: VERSION,
    origin: spawnId(mem,{create:!dryRun}),
    fromRev,
    toRev: deltas.length?Math.max(...deltas.map(d=>d.rev)):fromRev,
    deltas,
  };
}

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* Resurrected-echo guard: my own newest local delta about this fact says
   FORGET, and the incoming (re-)add predates it → the add is the echo of
   something I deleted, not new information. Skipping it is what makes
   tombstones win without vector clocks. */
function localTombstoneTs(mem, factText) {
  const n = norm(factText);
  let ts = null;
  for (const d of mem.deltaSince(0, { limit: 2000 })) {
    if (d.kind === 'forget' && (n.includes(norm(d.text)) || norm(d.text).includes(n)) && norm(d.text)) {
      ts = d.ts; // keep the LATEST forget
    }
  }
  return ts;
}

export function applyBundle(mem, bundle, { dryRun = false } = {}) {
  const out = { applied: 0, skippedDup: 0, skippedSeen: 0, skippedResurrected: 0, errors: [] };
  if (!bundle || bundle.origin === spawnId(mem,{create:!dryRun})) { out.skippedSelf = true; return out; }
  const seenFrom = ledger(mem).appliedFrom[bundle.origin] || 0;
  for (const d of bundle.deltas || []) {
    if (!Number.isFinite(d.rev) || d.rev <= seenFrom) { out.skippedSeen++; continue; }
    try {
      if (d.kind === 'add' || d.kind === 'update') {
        const tomb = localTombstoneTs(mem, d.text);
        if (tomb && (!d.ts || d.ts <= tomb)) { out.skippedResurrected++; continue; }
        if (dryRun) { out.applied++; continue; }
        const r = mem.remember(d.text);
        if (r.unchanged) out.skippedDup++; else out.applied++;
      } else if (d.kind === 'forget') {
        if (dryRun) { out.applied++; continue; }
        mem.forget(d.text);
        out.applied++;
      } else {
        out.skippedKind = (out.skippedKind || 0) + 1;
      }
    } catch (e) {
      out.errors.push({ rev: d.rev, error: String(e?.message || e) });
    }
  }
  /* dryRun writes NOTHING — not even the ledger. Intent is enforced, not assumed. */
  if (!dryRun && !out.errors.length && Number.isFinite(bundle.toRev)) {
    noteApplied(mem, bundle.origin, Math.max(seenFrom, bundle.toRev));
  }
  return out;
}

/** Two-way sync between two Memory dirs. Returns the measured report. */
export function syncPair(memA, memB, { dryRun = false } = {}) {
  if(typeof memA?.syncSnapshot==='function'||typeof memB?.syncSnapshot==='function')return syncRecords(memA,memB,{dryRun});
  const idA = spawnId(memA,{create:!dryRun}), idB = spawnId(memB,{create:!dryRun});
  if (idA === idB) return { ok: false, error: { code: 'same_store', message: 'both stores share a spawnId — cloning a memory dir means the second copy must be re-minted (delete its memory-sync-id.json)' } };
  const ledA = ledger(memA), ledB = ledger(memB);
  const bundleBtoA = exportBundle(memB, { fromRev: ledA.appliedFrom[idB] || 0,dryRun });
  const bundleAtoB = exportBundle(memA, { fromRev: ledB.appliedFrom[idA] || 0,dryRun });
  const rA = applyBundle(memA, bundleBtoA, { dryRun });
  const rB = applyBundle(memB, bundleAtoB, { dryRun });
  return {
    ok: true,
    stores: { a: { id: idA, rev: memA.rev(), dir: memA.dir }, b: { id: idB, rev: memB.rev(), dir: memB.dir } },
    aReceived: rA, bReceived: rB,
    factsNow: dryRun ? { a: '(not modified)', b: '(not modified)' } : { a: memA.facts().length, b: memB.facts().length },
    dryRun: Boolean(dryRun),
  };
}

/** Same sync entry point, with a namespaced protocol for canonical V2 stores.
 * Lamport counters make deletions and later re-adds independent of wall clocks.
 * Concurrent equal-counter deletions win; remaining conflicts use stable actor IDs.
 * Each store/namespace is atomic, not a two-store transaction: retry converges.
 */
function syncRecords(a,b,{dryRun}) {
  if(typeof a?.syncSnapshot!=='function'||typeof b?.syncSnapshot!=='function')return {ok:false,error:{code:'incompatible_store',message:'Text-fact and namespaced stores require explicit migration, not a lossy sync.'}};
  // Strict read-only validation of BOTH stores before even minting identities.
  const previewA=a.syncSnapshot({dryRun:true}),previewB=b.syncSnapshot({dryRun:true});
  a.validateSyncRecords(previewA.records);b.validateSyncRecords(previewB.records);
  if(previewA.id===previewB.id)return {ok:false,error:{code:'same_store',message:'Both stores share a memory identity; explicit clone migration is required.'}};
  const key=r=>JSON.stringify([r.kind,r.key]);
  const merge=(left,right)=>{
  const all=new Map(left.records.map(r=>[key(r),r]));
  for(const r of right.records){
    const old=all.get(key(r));
    if(!old){all.set(key(r),r);continue;}
    const delta=r.version.counter-old.version.counter||Number(r.deleted)-Number(old.deleted)||r.version.actor.localeCompare(old.version.actor);
    if(delta>0)all.set(key(r),r);
    else if(delta===0&&JSON.stringify(r)!==JSON.stringify(old))throw Error('Conflicting memory records share a version; both stores retained');
  }
  return [...all.values()].sort((x,y)=>key(x).localeCompare(key(y)));
  };
  const preview=merge(previewA,previewB);
  a.validateSyncRecords(preview);b.validateSyncRecords(preview);
  const sa=dryRun?previewA:a.syncSnapshot(),sb=dryRun?previewB:b.syncSnapshot();
  if(sa.id===sb.id)return {ok:false,error:{code:'same_store',message:'Both paths resolve to the same memory identity.'}};
  const merged=dryRun?preview:merge(sa,sb);
  a.validateSyncRecords(merged);b.validateSyncRecords(merged);
  const changes=s=>{const before=new Map(s.records.map(r=>[key(r),JSON.stringify(r)]));return merged.filter(r=>before.get(key(r))!==JSON.stringify(r)).length;};
  const ca=changes(sa),cb=changes(sb);
  if(!dryRun){if(ca)a.applySyncRecords(merged);if(cb)b.applySyncRecords(merged);}
  return {ok:true,version:RECORD_VERSION,dryRun:Boolean(dryRun),provisionalIdentities:dryRun&&(sa.id.startsWith('preview-')||sb.id.startsWith('preview-')),aReceived:{applied:ca},bReceived:{applied:cb},factsNow:{a:merged.filter(r=>!r.deleted).length,b:merged.filter(r=>!r.deleted).length},stores:{a:{id:sa.id,dir:a.dir},b:{id:sb.id,dir:b.dir}},atomicity:'per-namespace; retry after interruption',conflictPolicy:'counter, concurrent deletion, actor'};
}
