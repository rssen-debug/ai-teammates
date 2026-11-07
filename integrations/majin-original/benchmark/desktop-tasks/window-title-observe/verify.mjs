// window-title-observe verifier: ground truth is state.json; the agent's claim is answer.txt.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

let state;
try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); }
catch { fail('state.json missing/invalid — task input damaged'); }
if (typeof state.activeWindowTitle !== 'string') fail('state.json has no activeWindowTitle');

let answer;
try { answer = fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8').trim(); }
catch { fail('answer.txt missing — the observation was never reported'); }

if (answer !== state.activeWindowTitle) {
  fail(`claimed title ${JSON.stringify(answer)} != ground truth ${JSON.stringify(state.activeWindowTitle)}`);
}
process.stdout.write('PASS window-title-observe\n');
