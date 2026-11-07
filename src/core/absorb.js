/**
 * MAJIN W1 ABSORB — capability radar for external repositories.
 *
 * `majin absorb <repo-url-or-path>` → discovery report. Nothing is *absorbed*:
 * detection ≠ integration. Output: machine-readable capability map (JSON) +
 * human integration report (MD), plus a gap-analysis against MAJIN's own tool
 * catalog (ALL_TOOLS). No network calls beyond the git clone itself. No code
 * from the target repo is ever executed (static analysis only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ALL_TOOLS } from './tools/index.js';

const LIMIT = { maxFiles: 4000, maxBytesPerFile: 256 * 1024 };

const LANG_SUFFIX = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'c++',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.sh': 'shell', '.ps1': 'powershell',
};

const MODULE_SIGNATURES = {
  agents:       /\b(agent|planner|orchestrat|autopilot|supervisor)\w*/i,
  tools:        /\b(tool|function.?call|tool_choice|instruments?)\w*/i,
  channels:     /\b(telegram|whatsapp|discord|slack|matrix|gmail|smtp|teams|signal|irc)\w*/i,
  memory:       /\b(memory|embeddi|vector|chroma|qdrant|pinecone|sqlite-?vec|faiss|lance)\w*/i,
  scheduler:    /\b(cron|schedul|crontab|node-?schedule|every).{0,24}(?:morning|minute|hour|day|tick)?/i,
  execution:    /\b(docker(ker|file|compose)?|container|ssh|paramiko|pty|jails|sandbox|firecracker)\w*/i,
  browsers:     /\b(playwright|puppeteer|cdp|chrome.?devtools|selenium)\w*/i,
  mcp:          /(?:mcp|model.?context.?protocol|@modelcontextprotocol)/i,
  permissions:  /\b(permiss|guard|approval|consent|acl|allowlist|denylist)\w*/i,
  tests:        /\b(test|spec|fixture|snapshot|assert|mock)\w*/i,
};

const DIR_HINTS = {
  tools: /tools?|functions?|instruments?/i,
  channels: /channels?|adapters?|connectors?/i,
  memory: /memor|vector|embedding/i,
  scheduler: /schedul|cron|queue/i,
  execution: /(docker|sandbox|runtime|executor|backend)/i,
  skills: /skills?|procedures?|playbook/i,
};

function* walk(dir, base = dir, n = { c: 0 }) {
  if (n.c >= LIMIT.maxFiles) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (n.c >= LIMIT.maxFiles) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('__')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base, n);
    else { n.c++; yield { p, rel: path.relative(base, p) }; }
  }
}

function readHead(p, max = LIMIT.maxBytesPerFile) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function parseJsonFile(p) { try { return JSON.parse(readHead(p, 1 << 20)); } catch { return null; } }

function detectLicense(root) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT', 'COPYING', 'LICENCE']) {
    const f = path.join(root, name);
    if (!fs.existsSync(f)) continue;
    const t = readHead(f, 64 * 1024).slice(0, 4000);
    if (/MIT License/i.test(t)) return { file: name, id: 'MIT', risk: 'low' };
    if (/Apache License/i.test(t)) return { file: name, id: 'Apache-2.0', risk: 'low' };
    if (/GNU AFFERO|AGPL/i.test(t)) return { file: name, id: 'AGPL', risk: 'high', note: 'copyleft network clause - adapter must be runtime-isolated or dynamically called' };
    if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return { file: name, id: 'GPL', risk: 'high', note: 'copyleft - UI-side embedding is potentially viral; adapter-boundary review required' };
    if (/GNU LESSER/i.test(t)) return { file: name, id: 'LGPL', risk: 'medium' };
    return { file: name, id: 'unknown', risk: 'medium', note: 'unrecognized license file - manual review' };
  }
  return { file: null, id: 'none-found', risk: 'high', note: 'no license file - treated as all-rights-reserved (integration framing only, no copying)' };
}

function scanDeps(root) {
  const deps = { npm: [], python: [], go: [], rust: [] };
  const pj = parseJsonFile(path.join(root, 'package.json'));
  if (pj) {
    deps.npm = Object.keys(pj.dependencies || {}).concat(Object.keys(pj.devDependencies || {})).sort();
    deps.npmName = pj.name || null; deps.npmVersion = pj.version || null; deps.licenseField = pj.license || null;
  }
  const req = path.join(root, 'requirements.txt');
  if (fs.existsSync(req)) deps.python = readHead(req, 128 * 1024).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (fs.existsSync(path.join(root, 'go.mod'))) deps.go = readHead(path.join(root, 'go.mod'), 128 * 1024).split('\n').filter(l => /^\s*[\w./-]+\.\w+/i.test(l)).length;
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) deps.rust = readHead(path.join(root, 'Cargo.toml'), 128 * 1024).length ? true : 0;
  return deps;
}

function detectEntrypoints(root, langs) {
  const names = [];
  for (const f of ['package.json']) {
    const pj = parseJsonFile(path.join(root, f));
    if (pj?.main) names.push(`main=${pj.main}`);
    if (pj?.bin) names.push(`bin=${JSON.stringify(pj.bin).slice(0, 120)}`);
  }
  for (const f of ['README.md', 'readme.md', 'README.MD']) {
    if (fs.existsSync(path.join(root, f))) { names.push(f); break; }
  }
  return names;
}

export function analyzeRepo(root, { repoLabel = 'local' } = {}) {
  const files = [];
  const byLang = {};
  const hits = Object.fromEntries(Object.keys(MODULE_SIGNATURES).map(k => [k, { files: 0, exemplars: [] }]));
  const dirTags = {};
  let totalBytes = 0;
  for (const f of walk(root)) {
    const ext = path.extname(f.rel).toLowerCase();
    if (LANG_SUFFIX[ext]) byLang[LANG_SUFFIX[ext]] = (byLang[LANG_SUFFIX[ext]] || 0) + 1;
    totalBytes += 1;
    const top = f.rel.split(path.sep)[0];
    for (const [tag, re] of Object.entries(DIR_HINTS)) {
      if (re.test(top)) { (dirTags[tag] = dirTags[tag] || []).push(top); }
    }
    files.push(f.rel);
    const dot = f.rel.includes('test') || f.rel.includes('fixture');
    if (!LANG_SUFFIX[ext] && !/dockerfile/i.test(f.rel)) continue;
    const text = readHead(f.p);
    if (/dockerfile/i.test(f.rel)) { hits.execution.files++; hits.execution.exemplars.push(f.rel); continue; }
    if (dot && hits.tests.files < 2000) { hits.tests.files++; hits.tests.exemplars.length < 6 && hits.tests.exemplars.push(f.rel); continue; }
    for (const [k, re] of Object.entries(MODULE_SIGNATURES)) {
      if (re.test(text)) {
        hits[k].files += 1;
        if (hits[k].exemplars.length < 6) hits[k].exemplars.push(f.rel);
      }
    }
  }
  const dirs = {}; for (const [k, v] of Object.entries(dirTags)) dirs[k] = [...new Set(v)];
  return {
    scanner: 'majin-absorb-static/1',
    repoLabel,
    fileCount: files.length,
    langRank: Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}:${c}`),
    entrypoints: detectEntrypoints(root, byLang),
    deps: scanDeps(root),
    license: detectLicense(root),
    structureHints: dirs,
    moduleHeat: hits,
  };
}

/* Gap-analys: marker-kända pattern → produktnamn-jämförelse mot MAJINs egna belt.
   Allt hamnar under "detected", inget under "absorbed". */
export function gapAnalysis(capMap) {
  const ownCaps = new Set([...ALL_TOOLS.map(t => t.name)]);
  ownCaps.add('core.agent'); ownCaps.add('core.swarm'); ownCaps.add('core.memory'); ownCaps.add('core.schedule');
  ownCaps.add('core.vision'); ownCaps.add('core.update'); ownCaps.add('core.channels.telegram'); ownCaps.add('core.channels.whatsapp');
  const mods = Object.entries(capMap.moduleHeat).filter(([, v]) => v.files > 0).map(([k, v]) => ({ module: k, strength: v.files >= 8 ? 'strong' : v.files >= 3 ? 'moderate' : 'weak', exemplars: v.exemplars.slice(0, 4) }));
  const TOUCH = {
    telegram: { cap: 'core.channels.telegram', alias: ['telegram', 'telegraf', 'botfather', 'grammY'.toLowerCase()] },
    whatsapp: { cap: 'core.channels.whatsapp', alias: ['whatsapp', 'baileys', 'venom-bot'] },
    discord: { cap: 'W8.channels.discord', alias: ['discord', 'discord.js'] },
    slack: { cap: 'W8.channels.slack', alias: ['slack', '@slack'] },
    docker: { cap: 'W3.execution.docker', alias: ['docker', 'dockerode', 'compose'] },
    ssh: { cap: 'W3.execution.ssh', alias: ['ssh2', 'paramiko', '/ssh', 'libssh'] },
    playwright: { cap: 'core.browser.cdp', alias: ['playwright'] },
    puppeteer: { cap: 'core.browser.cdp', alias: ['puppeteer'] },
    cron: { cap: 'core.schedule', alias: ['cron', 'node-schedule'] },
    'vector-db': { cap: 'W9.memory.vector', alias: ['lancedb', 'chroma', 'qdrant', 'pinecone', 'faiss', 'vectra', 'sqlite-vec'] },
    embedding: { cap: 'W9.memory.vector', alias: ['embed'] },
    mcp: { cap: 'interop.mcp', alias: ['modelcontextprotocol', '.mcp', 'mcp_tools'] },
  };
  const depBlob = JSON.stringify(capMap.deps || {}).toLowerCase();
  const heatBlob = JSON.stringify(capMap.moduleHeat || {}).toLowerCase();
  const signals = [];
  for (const [sign, meta] of Object.entries(TOUCH)) {
    const present = meta.alias.some((a) => depBlob.includes(a) || heatBlob.includes(a));
    if (present) signals.push({ external: sign, ownCounterpart: meta.cap, majinHas: ownCaps.has(meta.cap), action: ownCaps.has(meta.cap) ? 'compare approaches (no duplicate import)' : 'evaluate adapter implementation' });
  }
  return { ownToolCount: ALL_TOOLS.length, detectedModuleCoverage: mods, signals, note: 'comparison against the MAJIN registry; no capability imported' };
}

export function integrationReport(capMap, gap) {
  const L = [];
  L.push(`# Absorb analysis: ${capMap.repoLabel}`);
  L.push(`Scanner: ${capMap.scanner} - files: ${capMap.fileCount} - languages: ${capMap.langRank.slice(0, 5).join(', ')}`);
  L.push(`License: ${capMap.license.id} (risk=${capMap.license.risk})${capMap.license.note ? ' — ' + capMap.license.note : ''}`);
  L.push(``);
  L.push(`## Module heat (measured, not guessed)`);
  for (const m of gap.detectedModuleCoverage) L.push(`- ${m.module}: ${m.strength} (${m.exemplars.join(', ')}${m.exemplars.length === 4 ? ' …' : ''})`);
  L.push(``);
  L.push(`## MAJIN touch-points (gap analysis)`);
  for (const s of gap.signals) L.push(`- "${s.external}" → ${s.ownCounterpart} — MAJIN ${s.majinHas ? 'HAS' : 'LACKS'} an equivalent: ${s.action}`);
  if (!gap.signals.length) L.push('- (no explicit touch-points detected)');
  L.push(``);
  L.push(`## Caution (never absorption without approval)`);
  L.push('- Static analysis only: no code from the target repo is executed.');
  L.push('- "Detected" is not "integrated"; integration requires the W6 pipeline (DISCOVER -> APPROVE -> INSTALL).');
  L.push('- License risk shapes design: AGPL/GPL requires adapter isolation.');
  return L.join('\n');
}

function cloneRepo(url, dest) {
  const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, dest], { encoding: 'utf8' });
  return { code: r.status, stderr: (r.stderr || '').trim() };
}

function commitOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function absorb(target, { outDir = null, workspace = process.cwd() } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = String(target).trim();
  let root = null, isLocal = false, cloneErr = null;
  if (fs.existsSync(path.resolve(label)) && fs.statSync(path.resolve(label)).isDirectory()) {
    root = path.resolve(label); isLocal = true;
  } else {
    const name = (label.match(/[\/:]([\w.-]+?)(?:\.git)?$/i) || [null, crypto.randomUUID()])[1].replace(/^\.+/, '');
    root = path.join(outDir || path.join(workspace, 'absorb'), `${slug(name)}-${stamp}`);
    const res = cloneRepo(/^git@|^https?:\/\//.test(label) ? label : `https://github.com/${label}.git`, root);
    if (res.code !== 0) cloneErr = res.stderr || `git clone exit ${res.code}`;
  }
  if (cloneErr || !root) {
    return { ok: false, error: { code: 'clone_failed', message: cloneErr || 'unknown root cause', hint: 'private repo? pass a full https url (with token) or point at a local path' } };
  }
  const capMap = analyzeRepo(root, { repoLabel: label });
  capMap.commit = isLocal ? commitOf(root) : null;
  const gap = gapAnalysis(capMap);
  const md = integrationReport(capMap, gap);
  const out = outDir || path.join(workspace, 'absorb');
  fs.mkdirSync(out, { recursive: true });
  const jsonPath = path.join(out, `${slug(label.replace(/[:/\\]/g, '_'))}-capability.json`);
  const mdPath = jsonPath.replace(/\.json$/, '-REPORT.md');
  fs.writeFileSync(jsonPath, JSON.stringify({ capMap, gap, generatedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(mdPath, md);
  return {
    ok: true, artifacts: { capabilityJson: jsonPath, reportMd: mdPath, root },
    summary: { files: capMap.fileCount, license: capMap.license.id, moduleStrength: Object.fromEntries(Object.entries(capMap.moduleHeat).map(([k, v]) => [k, v.files])) },
  };
}
function slug(s) { return s.toLowerCase().replace(/[^\w.-]+/g, '-').slice(0, 80); }
