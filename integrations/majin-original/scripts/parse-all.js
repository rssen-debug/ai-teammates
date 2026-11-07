#!/usr/bin/env node
/**
 * Dependency-free syntax check. Runs `node --check` over every JS file in the repo.
 * Catches the most expensive failure mode in this codebase: broken syntax in a module
 * that no test has imported yet.
 *
 *   npm run check            alla filer
 *   npm run check -- src     bara under src/
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] ? path.resolve(root, process.argv[2]) : root;
const skip = new Set(['node_modules', '.git', '.majin', 'data', 'dist', 'build', 'coverage', '.cache', 'stage']);

const files = [];
walk(only);

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
  }
}

let bad = 0;
let checked = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const isModule = /^\s*(import|export)\b/m.test(src);
  if (!isModule && !/[();=]\s*$/.test(src.trim().slice(-400))) {
    /* html/css-ish or empty — skip */
  }
  const extOk = /\.(js|mjs|cjs)$/.test(f);
  if (!extOk) continue;
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', cwd: root });
  checked += 1;
  if (r.status !== 0) {
    bad += 1;
    const first = String(r.stderr || '').split('\n').slice(0, 4).join('\n    ');
    console.log(`✖ ${path.relative(root, f)}\n    ${first}`);
  } else {
    console.log(`✔ ${path.relative(root, f)}`);
  }
}
console.log(`\n${checked - bad}/${checked} files parse cleanly${bad ? ` — ${bad} broken` : ''}.`);
process.exitCode = bad ? 1 : 0;
