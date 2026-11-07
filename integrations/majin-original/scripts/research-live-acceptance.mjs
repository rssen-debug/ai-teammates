#!/usr/bin/env node
/**
 * MAJIN W2 acceptance-lane — REAL live research run inside sandbox egress.
 *
 * research.run requires an injected searchFn/fetchFn. The sandbox egress blocks
 * DuckDuckGo/Bing — but api.github.com + raw.githubusercontent.com are REACHABLE,
 * so this lane wires REAL network I/O through the GitHub search API (tokens read
 * from GITHUB_TOKEN if set, never persisted). No fixtures touch the run.
 *
 * Usage: node scripts/research-live-acceptance.mjs [question] [--save]
 * Exit != 0 unless the run produced real sources + a verified report.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as researchRun } from '../src/core/research.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const question = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ')
  || 'What are the most common entrypoint patterns of production TypeScript CLI agents?';
const save = process.argv.includes('--save');

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const headers = { 'User-Agent': 'majin-w2-acceptance', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

const STOP = new Set(['what', 'are', 'the', 'most', 'of', 'in', 'a', 'an', 'how', 'does', 'do', 'is', 'and', 'to', 'for', 'on', 'with', 's', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'vs', 'versus', 'use', 'used', 'using', 'dominate', 'dominates', 'best', 'top', 'popular']);
const adapterNotes = [];

/** adapter-level resilience, LOGGED — query as-is first; zero hits → LADDER of keyword reductions (every hop visible, never silent). */
function reduceLadder(q) {
  const toks = String(q).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
  const uniq = [...new Set(toks)];
  const ladder = [uniq.slice(0, 4).join(' '), uniq.slice(0, 2).join(' '), uniq[0] || q.split(/\s+/)[0]];
  return [...new Set(ladder.filter(Boolean))];
}

async function ghQuery(eff, count) {
  return fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(eff)}&per_page=${count}`, { headers });
}

/** LIVE searchFn: real https to api.github.com. Search-engine-neutral adapter — the W2 engine doesn't care who searched. */
async function ghSearch(query, { count = 5 } = {}) {
  let r = await ghQuery(query, count);
  if (r.ok) {
    let j = await r.json();
    const tried = [query];
    for (const hop of reduceLadder(query)) {
      if ((j.items || []).length > 0) break;
      tried.push(hop);
      r = await ghQuery(hop, count);
      if (r.ok) j = await r.json();
    }
    if (tried.length > 1) adapterNotes.push({ engineQuery: query, adapterTried: tried, reason: 'github full-text repo search ANDs tokens; natural-language questions return 0 — keyword-ladder fallback, recorded loudly' });
    return (j.items || []).map((it) => ({ url: it.html_url + '|api:' + it.url, title: it.full_name, snippet: it.description || '' }));
  }
  if (r.status === 403) throw new Error(`github-search rate/egress limit (403, left=${r.headers.get('x-ratelimit-remaining')})`);
  if (!r.ok) throw new Error(`github-search http ${r.status}`);
  const j = await r.json();
  return (j.items || []).map((it) => ({ url: it.html_url + '|api:' + it.url, title: it.full_name, snippet: it.description || '' }));
}

/** LIVE fetchFn: fetches the repo README via the GitHub API (json → base64 bytes → utf8 text). */
async function ghFetch(url) {
  const m = url.match(/\|api:(https:\/\/api\.github\.com\/repos\/[^|]+)$/);
  if (!m) throw new Error(`non-github url rejected by this lane's fetchFn: ${url}`);
  const r = await fetch(m[1] + '/readme', { headers });
  if (!r.ok) throw new Error(`readme http ${r.status} for ${url.split('|')[0]}`);
  const j = await r.json();
  if (!j.content) return '';
  return Buffer.from(String(j.content).replace(/\n/g, ''), 'base64').toString('utf8');
}

process.stdout.write(`W2 live-acceptance question: ${question}\n`);
const artDir = path.join(ROOT, 'docs', 'evidence', `research-live-${new Date().toISOString().slice(0, 10)}`);

const res = await researchRun(question, {
  searchFn: ghSearch,
  fetchFn: ghFetch,
  maxSources: 5,
  artifactsDir: save ? artDir : null,
});

if (!res.ok) {
  console.error(`LIVE RUN FAILED (honest): ${res.error.code} — ${res.error.message}`);
  console.error(JSON.stringify(res.progress || [], null, 2).slice(0, 800));
  process.exit(1);
}

const real = res.sources.filter((s) => /^https:\/\/github\.com\//.test(s.url));
process.stdout.write(`query count: ${res.progress.find((p) => p.step === 'plan')?.queries?.length ?? '?'} · hits: ${res.progress.filter((p) => p.step === 'search' && typeof p.hits === 'number').pop()?.hits ?? 0} · sources fetched: ${res.sources.length} (${real.length} real github) · clusters: ${res.clusters} · findings: ${res.stats?.findings} · unsupported: ${res.stats?.unsupported} · conflicted: ${res.stats?.conflicted}
  verify verdict: ${res.stats?.verdict}\n`);
process.stdout.write(`engine: ${res.engine}\n`);
for (const s of res.sources) process.stdout.write(`  ${s.id} ${s.url.split('|')[0].slice(0, 62)} (reliability=${s.reliability.score}, fetched=${s.fetchedAt.slice(0, 19)})\n`);
if (adapterNotes.length) process.stdout.write(`adapter notes (loud): ${adapterNotes.length} query reduction(s)\n`);
if (res.paths) process.stdout.write(`artifacts: ${res.paths.report}\n`);
if (save && adapterNotes.length) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(artDir, 'adapter-notes.json'), JSON.stringify(adapterNotes, null, 2) + '\n');
}

if (res.sources.length < 3 || (res.stats?.findings ?? 0) < 3 || (res.stats?.unsupported ?? 1) !== 0) {
  console.error('LIVE RUN TOO THIN — refusing to count it as acceptance evidence');
  process.exit(1);
}
process.stdout.write('W2 live-acceptance: PASS (real egress > github, no fixtures)\n');
