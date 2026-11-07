#!/usr/bin/env node
/** W14 reproducible: prove the tracked-source manifest hash is stable, optionally save evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reproducibilityProof } from '../src/core/reproducible.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proof = reproducibilityProof(ROOT);
process.stdout.write(`tracked files: ${proof.files} (${proof.bytes} bytes)\n`);
process.stdout.write(`hashA: ${proof.hashA.slice(0, 20)}…  hashB: ${proof.hashB.slice(0, 20)}…\n`);
process.stdout.write(`identical: ${proof.identical}\n`);
process.stdout.write(`binary-exe reproducibility scope: ${proof.binaryExeReproducibilityScope}\n`);
if (process.argv.includes('--save')) {
  const d = new Date().toISOString().slice(0, 10);
  const out = path.join(ROOT, 'docs', 'evidence', `reproducible-${d}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ...proof, at: new Date().toISOString() }, null, 2) + '\n');
  process.stdout.write(`saved: ${out}\n`);
}
process.exitCode = proof.identical ? 0 : 1;
