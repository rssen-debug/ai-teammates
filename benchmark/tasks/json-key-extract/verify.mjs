// json-key-extract verifier: truth re-derived from api-response.json itself.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

let src;
try { src = JSON.parse(fs.readFileSync(path.join(dir, 'api-response.json'), 'utf8')); }
catch { fail('api-response.json missing/invalid — candidate damaged the task inputs'); }
const truth = { endpoint: src.payload.endpoint, status: src.payload.status };

let out;
try { out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')); }
catch { fail('out.json missing or invalid JSON'); }

if (Object.keys(out).sort().join(',') !== 'endpoint,status') fail(`out.json keys must be exactly endpoint,status — got ${Object.keys(out).join(',')}`);
if (out.endpoint !== truth.endpoint || out.status !== truth.status) fail(`out=${JSON.stringify(out)} != truth=${JSON.stringify(truth)}`);
process.stdout.write(`PASS json-key-extract\n`);
