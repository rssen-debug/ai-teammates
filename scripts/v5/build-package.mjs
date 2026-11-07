#!/usr/bin/env node
/**
 * MAJIN V5 — Reproducible Package Builder & Canonical Skill Registry Exporter.
 *
 * Produces:
 *  - `docs/v5/SKILL_REGISTRY.json` (`majin.v5.skill-registry/v1`)
 *  - `docs/v5/build-manifest.json` (`majin.v5.build-manifest/v1` with SHA-256 of every V5 file)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillTree, SKILL_REGISTRY_SCHEMA, DOMAINS } from '../../src/v5/skill-tree.js';
import { XP_CURVE_SCHEMA } from '../../src/v5/xp-engine.js';
import { V5_VERSION, resolveBuildSha } from '../../src/v5/ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function walkFiles(dir, baseDir = REPO_ROOT) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

export function buildV5PackageManifest() {
  // 1. Export clean versioned SKILL_REGISTRY.json
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-reg-export-'));
  const tree = new SkillTree({ dir: tmpDir });
  const registryPayload = {
    schema: SKILL_REGISTRY_SCHEMA,
    xpCurveSchema: XP_CURVE_SCHEMA,
    version: V5_VERSION,
    domains: DOMAINS,
    skills: tree.list(),
    aggregate: tree.aggregateSummary(),
  };
  const registryOutPath = path.join(REPO_ROOT, 'docs', 'v5', 'SKILL_REGISTRY.json');
  fs.mkdirSync(path.dirname(registryOutPath), { recursive: true });
  fs.writeFileSync(registryOutPath, `${JSON.stringify(registryPayload, null, 2)}\n`, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 2. Hash all V5 runtime, UI, test, script and documentation files
  const trackedPaths = [
    'bin/majin-v5.mjs',
    'desktop/main.cjs',
    'desktop/policy.cjs',
    'desktop/stage-host.mjs',
    'desktop/offline.html',
    'desktop/package.json',
    ...walkFiles(path.join(REPO_ROOT, 'src', 'v5')),
    ...walkFiles(path.join(REPO_ROOT, 'test', 'v5')),
    'scripts/v5/desktop-host.mjs',
    'scripts/v5/desktop-smoke.mjs',
    'scripts/v5/desktop-installer-verify.ps1',
    'scripts/v5/install-majin-v5-windows.ps1',
    'scripts/v5/render-screenshots.mjs',
    'scripts/v5/build-package.mjs',
    'docs/v5/REUSE_MATRIX.md',
    'docs/v5/RESEARCH_DECISIONS.md',
    'docs/v5/XP_RULES.md',
    'docs/v5/SKILL_REGISTRY.json',
    'docs/v5/HANDOVER.md',
    'assets/majin.png',
    'assets/majin.ico',
    'assets/majin-transparent.png',
  ].filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));

  const files = {};
  const treeHasher = crypto.createHash('sha256');
  for (const rel of trackedPaths) {
    const abs = path.join(REPO_ROOT, rel);
    const bytes = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    files[rel] = {
      bytes: bytes.length,
      sha256,
    };
    treeHasher.update(`${rel}:${sha256}\n`);
  }

  const manifest = {
    schema: 'majin.v5.build-manifest/v1',
    product: 'MAJIN V5 — GRAND ARCHITECT',
    version: V5_VERSION,
    gitSha: resolveBuildSha(REPO_ROOT),
    packageTreeSha256: treeHasher.digest('hex'),
    windowsInstallerScript: 'scripts/v5/install-majin-v5-windows.ps1',
    filesCount: Object.keys(files).length,
    files,
  };

  const manifestPath = path.join(REPO_ROOT, 'docs', 'v5', 'build-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = buildV5PackageManifest();
  console.log(`Built reproducible V5 package manifest (${m.filesCount} files, tree SHA-256 ${m.packageTreeSha256.slice(0, 16)}...)`);
}
