import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeRepo, gapAnalysis, integrationReport, absorb } from '../src/core/absorb.js';

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-fix-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-agent', version: '0.0.1', license: 'MIT',
    dependencies: { 'telegraf': '^4.0.0', 'node-cron': '^3.0.0', 'dockerode': '^4.0.0', 'playwright': '^1.40.0', 'lancedb': '^0.1.0' },
  }));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...\n');
  fs.mkdirSync(path.join(root, 'src', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'tools', 'weather.js'), 'export const tool = { name: "weather.get", desc: "fetch current weather" };\n');
  fs.writeFileSync(path.join(root, 'src', 'tools', 'exec.js'), '// puppeteer-driven docker container spawn helper\n');
  fs.mkdirSync(path.join(root, 'src', 'channels'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'channels', 'tg.js'), 'const telegram = require("telegraf"); new telegram.Telegraf(process.env.BOT_TOKEN);\n');
  fs.mkdirSync(path.join(root, 'src', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'memory', 'vec.js'), 'const lancedb = require("lancedb"); // vector memory store\n');
  fs.mkdirSync(path.join(root, 'src', 'scheduler'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'scheduler', 'cron.js'), 'const cron = require("node-cron"); cron.schedule("0 8 * * *", tick);\n');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'smoke.test.js'), 'assert.ok(true);\n');
  return root;
}

test('W1 analyzeRepo: fixture ger modulupptäckt (utan exekvering)', () => {
  const root = mkFixture();
  const cap = analyzeRepo(root, { repoLabel: 'fixture' });
  assert.equal(cap.license.id, 'MIT');
  assert.ok(cap.deps.npm.includes('telegraf'));
  assert.ok(cap.deps.npm.includes('node-cron'));
  for (const mod of ['tools', 'channels', 'memory', 'scheduler', 'execution', 'tests']) {
    assert.ok(cap.moduleHeat[mod].files >= 1, `modul ${mod} borde detekteras (files=${cap.moduleHeat[mod].files})`);
  }
  assert.ok(cap.fileCount >= 8);
  assert.ok(Array.isArray(cap.entrypoints));
});

test('W1 gap-analys: kända signaler kopplas till MAJIN:s eget catalog värde', () => {
  const root = mkFixture();
  const cap = analyzeRepo(root, { repoLabel: 'fixture' });
  const gap = gapAnalysis(cap);
  const capByName = Object.fromEntries(gap.signals.map(s => [s.external, s]));
  assert.equal(capByName.telegram?.ownCounterpart, 'core.channels.telegram');
  assert.equal(capByName.telegram?.majinHas, true);
  assert.equal(capByName.cron?.ownCounterpart, 'core.schedule');
  assert.equal(capByName.docker?.majinHas, false, 'MAJIN har ingen docker-backend-idag — måste rapporteras som sak');
  assert.ok(gap.detectedModuleCoverage.length > 0);
});

test('W1 rapport: all metadata i strukturen + ärlig labels', () => {
  const root = mkFixture();
  const cap = analyzeRepo(root, { repoLabel: 'fixture' });
  const md = integrationReport(cap, gapAnalysis(cap));
  assert.match(md, /fixture/);
  assert.match(md, /MIT/);
  assert.match(md, /absorption without approval/i);
});

test('W1 absorb(end-to-end, lokal mapp): artefakter skrivs + inga nätverksanrop för lokal path', async () => {
  const root = mkFixture();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-out-'));
  const res = await absorb(root, { outDir, workspace: outDir });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(res.artifacts.capabilityJson));
  assert.ok(fs.existsSync(res.artifacts.reportMd));
  const parsed = JSON.parse(fs.readFileSync(res.artifacts.capabilityJson, 'utf8'));
  assert.equal(parsed.capMap.license.id, 'MIT');
  assert.ok(parsed.gap.signals.length >= 1);
});

test('W1 absorb: okänd repo ger ärligt fel (aldrig tyst lyckad)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-out-'));
  const res = await absorb('https://github.com/this-org-does-not-exist-asdf/this-repo-does-not-exist-asdf', { outDir, workspace: outDir });
  assert.equal(res.ok, false);
  assert.ok(res.error.code === 'clone_failed');
});
