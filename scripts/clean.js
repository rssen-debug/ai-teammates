#!/usr/bin/env node
/**
 * Reset MAJIN runtime data: logs, saved reports, cache, uploaded files.
 * Config, memory, skills and sessions are left alone (that is where your setup lives).
 *   npm run clean            # empty cache/out/logs/uploads
 *   npm run clean -- --all   + tmp-filer och .bak
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../src/core/paths.js';

const all = process.argv.includes('--all');
const targets = [dirs.logs, dirs.out, dirs.cache, dirs.uploads, path.join(dirs.root, 'last-shutdown.json')];
if (all) targets.push(dirs.root + '.tmp', path.join(dirs.root, 'usage.json.bak'), path.join(dirs.config + '.bak'), path.join(dirs.root, 'schedule.json.bak'));

let n = 0;
for (const t of targets) {
  if (!t) continue;
  try {
    const st = fs.statSync(t);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(t)) {
        if (!all && /\.(bak)$/i.test(f)) continue;
        fs.rmSync(path.join(t, f), { recursive: true, force: true });
        n += 1;
      }
    } else {
      fs.rmSync(t, { force: true });
      n += 1;
    }
    console.log(`· rensade ${t}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`  (skipping ${t}: ${err.code || err.message})`);
  }
}
console.log(`\nDONE: ${n} record(s) removed. Config + memory + sessions stay in ${dirs.root}`);
