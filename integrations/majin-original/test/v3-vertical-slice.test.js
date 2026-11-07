import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runV3FileDeliverable, V3InputError } from '../src/v3/runtime/file-deliverable.js';
import { startV3Server, createV3Server } from '../src/v3/server.js';
import { renderV3Page } from '../src/v3/ui/page.js';
import { Goal } from '../src/v2/runtime/goal.js';

function tempWorkspace(prefix = 'majin-v3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('V3 vertical slice reuses V2 Goal and file verifier and returns a verified receipt', async () => {
  const workspaceDir = tempWorkspace();
  const content = '# Welcome\nA verified MAJIN artifact.\n';
  const result = await runV3FileDeliverable({
    objective: 'Create a welcome note for this project',
    fileName: 'welcome.md',
    content,
    workspaceDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.goal.state, 'COMPLETED');
  assert.equal(fs.readFileSync(path.join(workspaceDir, 'welcome.md'), 'utf8'), content);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.goal.acceptance[0].id, 'artifact-written-and-verified');
  assert.equal(result.goal.receipts.length, 1);
  assert.equal(result.goal.receipts[0].verified, true);
  assert.equal(result.goal.receipts[0].result, 'success');

  const saved = Goal.list(path.join(workspaceDir, '.majin', 'v3', 'goals'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, 'COMPLETED');
});

test('V3 file capability rejects traversal, hidden paths, and Windows device names', async () => {
  const workspaceDir = tempWorkspace();
  for (const fileName of ['../outside.txt', 'folder/file.txt', '..', '.env', 'CON.txt', 'name:stream']) {
    await assert.rejects(runV3FileDeliverable({
      objective: 'make a file', fileName, content: 'x', workspaceDir,
    }), V3InputError, `expected ${fileName} to be rejected`);
  }
  assert.equal(fs.readdirSync(workspaceDir).length, 0);
});

test('V3 never overwrites an existing file and records a failed goal honestly', async () => {
  const workspaceDir = tempWorkspace();
  const target = path.join(workspaceDir, 'keep.txt');
  fs.writeFileSync(target, 'original');
  const result = await runV3FileDeliverable({
    objective: 'replace this note', fileName: 'keep.txt', content: 'new content', workspaceDir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FILE_EXISTS');
  assert.equal(result.goal.state, 'FAILED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('V3 minimal page uses accessible labels, a live result region, reduced motion, and no external assets', () => {
  const html = renderV3Page();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<label for="objective">/);
  assert.match(html, /<label for="fileName">/);
  assert.match(html, /<label for="content">/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /Existing files are never overwritten/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\//i);
});

test('loopback UI serves the full request -> goal -> write -> verify -> visible result path', async (t) => {
  const workspaceDir = tempWorkspace();
  const { server, url } = await startV3Server({ workspaceDir });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Make something real/);

  const response = await fetch(`${url}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({
      objective: 'Create a small project note',
      fileName: 'project-note.md',
      content: 'This file was created and verified.\n',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.goal.state, 'COMPLETED');
  assert.equal(body.evidence.kind, 'file');
  assert.match(body.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(workspaceDir, 'project-note.md'), 'utf8'), 'This file was created and verified.\n');
});

test('loopback API rejects cross-origin writes, non-JSON forms, and absent workspace configuration', async (t) => {
  const workspaceDir = tempWorkspace();
  const { server, url } = await startV3Server({ workspaceDir });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const payload = JSON.stringify({ objective: 'make note', fileName: 'blocked.txt', content: 'blocked' });
  const crossOrigin = await fetch(`${url}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
    body: payload,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'ORIGIN_REJECTED');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'blocked.txt')), false);

  const formRequest = await fetch(`${url}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: url },
    body: payload,
  });
  assert.equal(formRequest.status, 415);
  assert.throws(() => createV3Server({}), /workspaceDir is required/);
  assert.throws(() => createV3Server({ workspaceDir, host: '0.0.0.0' }), /loopback/);
});

test('loopback API enforces the request-size limit and remains responsive after rejection', async (t) => {
  const workspaceDir = tempWorkspace();
  const { server, url } = await startV3Server({ workspaceDir, maxBodyBytes: 256 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const oversized = await fetch(`${url}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ objective: 'x'.repeat(400), fileName: 'large.txt', content: 'x' }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'BODY_TOO_LARGE');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'large.txt')), false);
  assert.equal((await fetch(url)).status, 200);
});
