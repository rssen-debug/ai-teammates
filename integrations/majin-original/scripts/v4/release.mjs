#!/usr/bin/env node
/**
 * MAJIN V4 — build and sign a release.
 *
 *   node scripts/v4/release.mjs --key <private-key.pem> [--out <dir>]
 *
 * Produces, in <out>:
 *   manifest.json   every file with its SHA-256
 *   manifest.sig    detached Ed25519 signature over the canonical manifest
 *   files/          the exact bytes named by the manifest
 *
 * The private key never leaves this machine and is never written into the
 * release. The public half is what the owner pins once at install time.
 *
 * The file list is deliberately the product, not the repo: no node_modules, no
 * tests, no docs, no .git. A release is what the host runs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATER_SCHEMA, canonicalManifest, hashTree, signManifest } from '../../src/v4/updater.js';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keyFile = value('--key') || process.env.MAJIN_V4_RELEASE_KEY;
const out = value('--out') || path.join(root, 'dist', 'release');

if (!keyFile) {
  process.stderr.write('usage: node scripts/v4/release.mjs --key <private-key.pem>\n');
  process.exit(2);
}
if (!fs.existsSync(keyFile)) {
  process.stderr.write(`no such key: ${keyFile}\n`);
  process.exit(2);
}

/** What ships: the runtime, not the workshop. */
const INCLUDE = ['src', 'scripts', 'skins', 'package.json', 'package-lock.json', 'README.md', 'install.ps1'];
const SKIP = ['node_modules', 'test', 'docs', 'dist', '.git', 'benchmark', 'qa', 'assets', 'installer', '.github'];

function copyInto(from, rel, to) {
  const src = path.join(from, rel);
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(src)) copyInto(from, `${rel}/${entry}`, to);
    return;
  }
  const target = path.join(to, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, target);
}

const filesDir = path.join(out, 'files');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

for (const entry of INCLUDE) copyInto(root, entry, filesDir);

const files = hashTree(filesDir, { skip: SKIP });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = {
  schema: UPDATER_SCHEMA,
  version: pkg.version,
  commit: process.env.GITHUB_SHA || 'local',
  publishedAt: new Date().toISOString(),
  files,
};
const signature = signManifest(manifest, fs.readFileSync(keyFile, 'utf8'));

fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'manifest.sig'), `${signature}\n`);

// Prove the signature against the public half before declaring success.
const publicPem = crypto.createPublicKey(fs.readFileSync(keyFile, 'utf8')).export({ type: 'spki', format: 'pem' });
const ok = crypto.verify(null, Buffer.from(canonicalManifest(manifest), 'utf8'), crypto.createPublicKey(publicPem), Buffer.from(signature, 'base64'));
if (!ok) {
  process.stderr.write('signature does not verify against its own public key\n');
  process.exit(1);
}
fs.writeFileSync(path.join(out, 'public-key.pem'), publicPem);

process.stdout.write(`\n  release ${manifest.version} (${manifest.commit.slice(0, 7)})\n`);
process.stdout.write(`  ${files.length} file(s), ${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1024)} kB\n`);
process.stdout.write(`  manifest ${path.join(out, 'manifest.json')}\n`);
process.stdout.write(`  signature verified against public-key.pem\n\n`);
