// notepad-write-save verifier: the TRUTH lives in spec.json; note.txt bytes are MEASURED.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

let spec;
try { spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')); }
catch { fail('spec.json missing/invalid — task input damaged'); }
if (typeof spec.expectedContent !== 'string') fail('spec.json has no expectedContent');

let note;
try { note = fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'); }
catch { fail('note.txt missing — the note was never actually saved'); }

if (note.replace(/\n+$/, '') !== spec.expectedContent) {
  fail(`note.txt bytes do not equal truth: got ${JSON.stringify(note)}, expected ${JSON.stringify(spec.expectedContent)} from spec.json`);
}
process.stdout.write('PASS notepad-write-save\n');
