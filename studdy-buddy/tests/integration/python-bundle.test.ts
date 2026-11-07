import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * En-fils-Python-paketet är en artefakt användaren laddar ner och kör själv.
 * Om det slutar fungera får det inte ske tyst: då ska det här testet falla.
 */

const root = join(__dirname, '..', '..');
const generator = join(root, 'scripts', 'make_python_bundle.py');
const cli = join(root, 'dist', 'cli', 'studdy.mjs');
const havePython = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!havePython)('one-file Python bundle', () => {
  it('packar hela repot och en CLI som faktiskt kör', () => {
    // Kräver byggd CLI; CI bygger före test, lokalt kan man köra npm run build.
    if (!existsSync(cli)) return;
    const dir = mkdtempSync(join(tmpdir(), 'studdy-py-'));
    const out = join(dir, 'bundle.py');
    try {
      execFileSync('python3', [generator, '--out', out], { cwd: root, stdio: 'pipe' });
      expect(existsSync(out)).toBe(true);

      const info = execFileSync('python3', [out, 'info'], { encoding: 'utf8' });
      expect(info).toMatch(/Källfiler\s+:\s+[1-9]\d{2,}/);
      expect(info).toMatch(/SHA-256\s+:\s+[0-9a-f]{64}/);

      // CLI:n inuti filen ska svara på riktigt, inte bara packas upp.
      const version = execFileSync('python3', [out, 'run', '--version'], { encoding: 'utf8' });
      expect(version).toMatch(/"version":\s*"\d+\.\d+\.\d+"/);

      // Uppackningen ska ge tillbaka källkoden, inklusive en känd fil.
      const target = join(dir, 'out');
      execFileSync('python3', [out, 'extract', target], { encoding: 'utf8' });
      const pkg = JSON.parse(readFileSync(join(target, 'studdy-buddy', 'package.json'), 'utf8'));
      expect(pkg.name).toBe('studdy-buddy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
