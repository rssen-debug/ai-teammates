// two-step-chain verifier: sum recomputed from nums.txt, chain relation checked.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

const truth = fs.readFileSync(path.join(dir, 'nums.txt'), 'utf8').trim().split(/\r?\n/).map(Number).reduce((a, b) => a + b, 0);

const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { fail(`${f} missing/invalid`); } };
const s1 = read('step1.json');
const s2 = read('step2.json');
if (s1.sum !== truth) fail(`step1.sum=${s1.sum} but truth=${truth}`);
if (s2.doubled !== truth * 2) fail(`step2.doubled=${s2.doubled} but 2*sum=${truth * 2} — chain is broken`);
process.stdout.write(`PASS two-step-chain sum=${truth}\n`);
