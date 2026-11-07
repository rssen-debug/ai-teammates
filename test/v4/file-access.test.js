/**
 * Universal file access, proven on real files.
 *
 * The reported failure: MAJIN could not find a CV the owner had granted. The
 * cause was not a missing tool — it was that Owner Mode recorded folders that
 * nothing enforced and nobody told the model about. These tests use real files
 * in real temporary directories and go through the same runner, adapter and
 * approval policy the agent uses:
 *
 *   - a granted folder is searchable with fs_find and readable with fs_read;
 *   - document_read reads a PDF inside it through the existing extractor;
 *   - everything outside the workspace and the grants is refused with
 *     PERMISSION_DENIED (and that includes `..` traversal);
 *   - a revocation is effective on the next call;
 *   - the model is told which folders exist (system prompt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { runTool } from '../../src/v2/tools/runner.js';
import { createToolRegistry } from '../../src/v4/tools.js';
import { hostCapabilities, registerHostTools } from '../../src/v4/tools/host.js';
import { checkPath, normaliseRoots } from '../../src/v4/path-access.js';
import { z } from 'zod';

/** A real PDF with a text layer, built without any dependency. */
function tinyPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(out.length);
    out += `${obj}\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-files-'));
  const workspace = path.join(home, 'workspace');
  const documents = path.join(home, 'Documents');
  const inside = path.join(documents, 'Privat');
  const secret = path.join(home, 'Secret');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(inside, 'CV Anders 2026.pdf'), tinyPdf('Anders Curriculum Vitae'));
  fs.writeFileSync(path.join(inside, 'anteckning.txt'), 'en riktig anteckning');
  fs.writeFileSync(path.join(secret, 'losenord.txt'), 'hemlig');
  return {
    home,
    workspace,
    documents,
    inside,
    secret,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

async function registryWith({ workspace, folders }) {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const builtin = createToolRegistry({
    workspaceDir: workspace,
    memoryDir: path.join(workspace, 'memory'),
    allowedRoots: () => (typeof folders === 'function' ? folders() : folders),
  });
  for (const t of builtin.registry.list()) registry.define(builtin.registry.get(t.name));
  registerHostTools(registry, caps, {
    workspaceDir: workspace,
    dataFile: path.join(workspace, 'config.json'),
    folders: () => (typeof folders === 'function' ? folders() : folders),
  });
  return registry;
}

async function call(registry, name, input) {
  try {
    const out = await runTool(
      { tool: name, input },
      { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 15_000 },
    );
    return { ok: true, data: out.data };
  } catch (err) {
    return { ok: false, cls: err?.cls, message: String(err?.message || err) };
  }
}

test('files: a granted folder is searched, read and documented on real files', async () => {
  const dirs = scratch();
  try {
    const registry = await registryWith({ workspace: dirs.workspace, folders: [dirs.documents] });

    const found = await call(registry, 'fs_find', { path: dirs.documents, name: 'cv', glob: '*.pdf' });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.equal(found.data.meta.count, 1);
    assert.match(found.data.meta.hits[0].path, /CV Anders 2026\.pdf$/);

    const read = await call(registry, 'fs_read', { path: path.join(dirs.inside, 'anteckning.txt') });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.match(String(read.data.result), /en riktig anteckning/);

    // The document extractor runs on a real PDF outside the workspace.
    const doc = await call(registry, 'document_read', { path: path.join(dirs.inside, 'CV Anders 2026.pdf') });
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.match(doc.data.text, /Curriculum Vitae/);
    assert.equal(doc.data.confidence, 'text');
  } finally {
    dirs.cleanup();
  }
});

test('files: without the grant the same folder is refused, not silently empty', async () => {
  const dirs = scratch();
  try {
    const registry = await registryWith({ workspace: dirs.workspace, folders: [] });
    const found = await call(registry, 'fs_find', { path: dirs.documents, name: 'cv' });
    assert.equal(found.ok, false);
    assert.match(found.cls || '', /PERMISSION_DENIED/);
    assert.match(found.message, /outside the workspace and every granted folder/);

    const doc = await call(registry, 'document_read', { path: path.join(dirs.inside, 'CV Anders 2026.pdf') });
    assert.equal(doc.ok, false);
    assert.match(doc.message, /outside the workspace/);
  } finally {
    dirs.cleanup();
  }
});

test('files: traversal out of a granted folder is refused', async () => {
  const dirs = scratch();
  try {
    const registry = await registryWith({ workspace: dirs.workspace, folders: [dirs.inside] });
    const escape = await call(registry, 'fs_read', { path: path.join(dirs.inside, '..', '..', 'Secret', 'losenord.txt') });
    assert.equal(escape.ok, false);
    assert.match(escape.cls || '', /PERMISSION_DENIED/);

    const parent = await call(registry, 'fs_list', { path: dirs.documents });
    assert.equal(parent.ok, false, 'the parent of a grant is not granted');
  } finally {
    dirs.cleanup();
  }
});

test('files: a revocation applies to the very next call', async () => {
  const dirs = scratch();
  try {
    let folders = [dirs.documents];
    const registry = await registryWith({ workspace: dirs.workspace, folders: () => folders });
    assert.equal((await call(registry, 'fs_find', { path: dirs.documents, name: 'cv' })).ok, true);

    folders = [];
    const after = await call(registry, 'fs_find', { path: dirs.documents, name: 'cv' });
    assert.equal(after.ok, false, 'a revoked folder was still reachable');
  } finally {
    dirs.cleanup();
  }
});

test('files: the workspace stays reachable and its own bounds still hold', async () => {
  const dirs = scratch();
  try {
    fs.writeFileSync(path.join(dirs.workspace, 'inline.txt'), 'i arbetsytan');
    const registry = await registryWith({ workspace: dirs.workspace, folders: [] });
    const rel = await call(registry, 'fs_read', { path: 'inline.txt' });
    assert.equal(rel.ok, true, JSON.stringify(rel));
    const abs = await call(registry, 'fs_read', { path: path.join(dirs.workspace, 'inline.txt') });
    assert.equal(abs.ok, true);
  } finally {
    dirs.cleanup();
  }
});

test('files: path policy resolves symlinks and judges the real target', () => {
  const dirs = scratch();
  try {
    const link = path.join(dirs.workspace, 'genväg');
    let linked = true;
    try {
      fs.symlinkSync(dirs.secret, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false; // Windows without developer mode cannot create symlinks
    }
    if (linked) {
      const out = checkPath(path.join(link, 'losenord.txt'), { workspace: dirs.workspace, folders: [] });
      assert.equal(out.allowed, false, 'a symlink escaped the workspace');
    }
    assert.deepEqual(normaliseRoots(['/a/b', '/a/b/', '/a/c']).length, 2);
    assert.equal(checkPath('sub/fil.txt', { workspace: dirs.workspace, folders: [] }).allowed, true);
  } finally {
    dirs.cleanup();
  }
});

test('files: the model is told which folders it may use', async () => {
  const { createAgent } = await import('../../src/v4/agent.js');
  const { ConversationStore, GoalStore } = await import('../../src/v4/store.js');
  const dirs = scratch();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-prompt-'));
  try {
    const config = {
      version: 'test',
      paths: { home },
      workspaceDir: dirs.workspace,
      limits: { maxMessageChars: 4000, maxModelRounds: 1, maxToolCallsPerTurn: 2, toolTimeoutMs: 2000, maxContextTokens: 4000 },
      approvals: { policy: 'sandbox-auto' },
    };
    const tools = createToolRegistry({ workspaceDir: dirs.workspace, memoryDir: path.join(home, 'mem') });
    tools.registry.define({
      name: 'noop',
      description: 'does nothing',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });
    let seen = null;
    const model = {
      info: { demo: false, model: 'test', provider: 'test', label: 'test' },
      infoFor: () => ({ demo: false }),
      async chat({ messages }) {
        seen = messages.map((m) => String(m.content)).join('\n');
        return { text: 'ok', toolCalls: [] };
      },
    };
    const agent = createAgent({
      config,
      conversations: new ConversationStore({ dir: path.join(home, 'conv') }),
      goals: new GoalStore({ dir: path.join(home, 'goals') }),
      tools,
      model,
      access: () => ({ workspace: dirs.workspace, folders: [dirs.inside], lanes: ['files'] }),
    });
    await agent.runTurn({ text: 'Var ligger mitt CV?' });
    assert.ok(seen, 'the model was never called');
    assert.match(seen, /granted folder/, 'the granted folder never reached the system prompt');
    assert.ok(seen.includes(dirs.inside), 'the exact granted path is not in the prompt');
    assert.match(seen, /fs_find/, 'the model is not told how to search the folder');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    dirs.cleanup();
  }
});
