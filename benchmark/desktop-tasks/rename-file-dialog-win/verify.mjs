// rename-file-dialog-win verifier (WINDOWS REAL LANE): proof = the OS file system,
// measured with process.env.TEMP — never a spoken claim. Runs ONLY on the
// user's Windows machine; on any other host it refuses to score honestly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.error('DEFERRED: hardware-required — this task measures a real Windows desktop; refusing to claim a non-Windows run.');
  process.exit(3); // distinct exit: harness marks deferred, never pass, never fail
}
const tmp = process.env.TEMP || os.tmpdir();
const renamed = path.join(tmp, 'majin-eval-renamed.txt');
const original = path.join(tmp, 'majin-eval-doc.txt');
if (!fs.existsSync(renamed)) { console.error('FAIL: renamed file absent in %TEMP% — the rename was never actually done'); process.exit(1); }
if (fs.existsSync(original)) { console.error('FAIL: original still exists alongside renamed copy — desktop state is ambiguous'); process.exit(1); }
const bytes = fs.readFileSync(renamed, 'utf8');
if (!bytes.includes('majin-eval doc')) { console.error(`FAIL: renamed file content not the seeded bytes (${JSON.stringify(bytes.slice(0, 60))})`); process.exit(1); }
process.stdout.write('PASS rename-file-dialog-win (real %TEMP% measured)\n');
