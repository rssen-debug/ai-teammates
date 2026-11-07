// report-largest verifier: recomputes truth from data/, compares report.json.
// Exit 0 = solved. The verifier never trusts a filename — it MEASURES.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

const dataDir = path.join(dir, 'data');
if (!fs.existsSync(dataDir)) fail('data/ missing — candidate damaged the task inputs');
const sizes = Object.fromEntries(fs.readdirSync(dataDir).map((f) => [f, fs.statSync(path.join(dataDir, f)).size]));
const truth = Object.entries(sizes).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([n]) => n);

let report;
try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); }
catch { fail('report.json missing or invalid JSON'); }

if (JSON.stringify(report.largest) !== JSON.stringify(truth)) {
  fail(`largest=${JSON.stringify(report.largest)} but truth-from-measurement=${JSON.stringify(truth)} (sizes: ${JSON.stringify(sizes)})`);
}
process.stdout.write(`PASS report-largest ${JSON.stringify(truth)}\n`);
