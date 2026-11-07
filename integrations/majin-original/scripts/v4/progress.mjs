#!/usr/bin/env node
/**
 * MAJIN V4 — acceptance-matrix accountant.
 *
 * The matrix is the only source of progress. This script:
 *   - refuses a matrix whose weights do not sum to exactly 100
 *   - refuses a criterion marked VERIFIED without a real evidence reference
 *   - recomputes the score from scratch (no stored percentage to drift)
 *
 *   node scripts/v4/progress.mjs           human summary
 *   node scripts/v4/progress.mjs --json    machine summary
 *   node scripts/v4/progress.mjs --check   exit 1 on any structural error
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MATRIX_PATH = path.resolve(here, '../../docs/v4/ACCEPTANCE_MATRIX.json');

const STATUSES = new Set(['VERIFIED', 'PARTIAL', 'NOT_STARTED', 'BLOCKED']);
const EVIDENCE_PREFIXES = ['test/v4/', 'npm run', 'node scripts/v4/', 'manual:', 'device:', 'windows:'];

export function loadMatrix(file = MATRIX_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || !Array.isArray(raw.categories)) throw new Error('matrix must have categories[]');
  return raw;
}

/** Structural validation. Returns { errors, warnings }. */
export function validateMatrix(matrix) {
  const errors = [];
  const warnings = [];
  let weight = 0;
  const ids = new Set();
  for (const cat of matrix.categories) {
    if (!cat.id || !cat.title) errors.push('category missing id/title');
    if (!Array.isArray(cat.criteria) || cat.criteria.length === 0) errors.push(`category ${cat.id}: no criteria`);
    for (const c of cat.criteria || []) {
      if (!c.id) errors.push(`category ${cat.id}: criterion without id`);
      if (ids.has(c.id)) errors.push(`duplicate criterion id: ${c.id}`);
      ids.add(c.id);
      if (!Number.isInteger(c.weight) || c.weight <= 0) errors.push(`${c.id}: weight must be a positive integer`);
      weight += c.weight || 0;
      if (!STATUSES.has(c.status)) errors.push(`${c.id}: unknown status ${c.status}`);
      if (c.status === 'VERIFIED') {
        if (!c.evidence) errors.push(`${c.id}: VERIFIED without evidence`);
        else if (!EVIDENCE_PREFIXES.some((p) => String(c.evidence).startsWith(p))) {
          errors.push(`${c.id}: evidence must reference a real artifact (${EVIDENCE_PREFIXES.join(', ')})`);
        }
      }
      if (c.status === 'BLOCKED' && !c.blocker) errors.push(`${c.id}: BLOCKED without a stated blocker`);
      if (c.status === 'PARTIAL' && !c.note) warnings.push(`${c.id}: PARTIAL without a note`);
    }
  }
  if (weight !== 100) errors.push(`weights sum to ${weight}, must be exactly 100`);
  return { errors, warnings, weight };
}

export function score(matrix) {
  let earned = 0;
  let possible = 0;
  const byCategory = [];
  for (const cat of matrix.categories) {
    let catEarned = 0;
    let catWeight = 0;
    for (const c of cat.criteria) {
      catWeight += c.weight;
      if (c.status === 'VERIFIED') catEarned += c.weight;
      if (c.status === 'PARTIAL') catEarned += c.weight / 2;
    }
    possible += catWeight;
    earned += catEarned;
    byCategory.push({
      id: cat.id,
      title: cat.title,
      earned: round(catEarned),
      weight: catWeight,
    });
  }
  return {
    earned: round(earned),
    possible,
    percent: round((earned / possible) * 100),
    byCategory,
  };
}

const round = (n) => Math.round(n * 100) / 100;

export function report(matrix) {
  const { errors, warnings, weight } = validateMatrix(matrix);
  const s = score(matrix);
  const counts = { VERIFIED: 0, PARTIAL: 0, NOT_STARTED: 0, BLOCKED: 0 };
  for (const cat of matrix.categories) for (const c of cat.criteria) counts[c.status] += 1;
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    weight,
    score: s,
    counts,
    criteria: matrix.categories.reduce((n, c) => n + c.criteria.length, 0),
    updatedAt: matrix.updatedAt || null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const matrix = loadMatrix();
  const r = report(matrix);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    process.stdout.write(`\nMAJIN V4 — ${r.score.earned}/${r.score.possible} verified points (${r.score.percent}%)\n`);
    process.stdout.write(`criteria: ${r.criteria} · VERIFIED ${r.counts.VERIFIED} · PARTIAL ${r.counts.PARTIAL} · NOT_STARTED ${r.counts.NOT_STARTED} · BLOCKED ${r.counts.BLOCKED}\n`);
    for (const c of r.score.byCategory) {
      process.stdout.write(`  ${c.id.padEnd(10)} ${String(c.earned).padStart(5)} / ${c.weight}\n`);
    }
    if (r.errors.length) process.stdout.write(`\nMATRIX ERRORS:\n${r.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    if (r.warnings.length) process.stdout.write(`\nwarnings:\n${r.warnings.map((e) => `  - ${e}`).join('\n')}\n`);
    process.stdout.write('\n');
  }
  if (r.errors.length || process.argv.includes('--check')) process.exit(r.errors.length ? 1 : 0);
}
