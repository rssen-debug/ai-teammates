import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stage = path.join(here, 'stage', 'host');
// Copy into a known workspace directory. Never copy local runtime data or keys.
fs.mkdirSync(stage, { recursive: true });

// Build Windows .ico from the official 512x512 Majin logo (`assets/majin.png`).
const sourceIconPath = path.join(root, 'assets/majin.png');
const sourceIcon = PNG.sync.read(fs.readFileSync(sourceIconPath));
if (sourceIcon.width !== 512 || sourceIcon.height !== 512) {
  throw new Error('Expected the 512px Majin icon at assets/majin.png');
}
const scaledIcon = new PNG({ width: 256, height: 256 });
for (let y = 0; y < 256; y++) {
  for (let x = 0; x < 256; x++) {
    for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          sum += sourceIcon.data[((y * 2 + dy) * 512 + x * 2 + dx) * 4 + channel];
        }
      }
      scaledIcon.data[(y * 256 + x) * 4 + channel] = Math.round(sum / 4);
    }
  }
}
const png = PNG.sync.write(scaledIcon);
const width = 256;
const height = 256;
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = width === 256 ? 0 : width;
header[7] = height === 256 ? 0 : height;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(here, 'stage/icon.ico'), Buffer.concat([header, png]));
fs.copyFileSync(sourceIconPath, path.join(here, 'stage/icon.png'));

if (process.platform === 'win32') {
  fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(stage, 'runtime/node.exe'));
  fs.writeFileSync(
    path.join(stage, 'runtime/version.json'),
    JSON.stringify({ node: process.versions.node, arch: process.arch }),
  );
}

for (const name of ['assets', 'bin', 'src', 'scripts', 'rules', 'skins', 'package.json', 'package-lock.json']) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(stage, name), { recursive: true });
  }
}

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
