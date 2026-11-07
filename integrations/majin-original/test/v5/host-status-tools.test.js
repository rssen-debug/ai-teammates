import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GrandArchitect } from '../../src/v5/architect.js';
import { createHostStatusTools } from '../../src/v5/host-status-tools.js';
import { MemoryStore } from '../../src/v2/memory/store.js';

const SECRET = 'sk-host-status-secret-1234567890';
const URL_PASSWORD = 'url-password-secret';
const URL_QUERY = 'query-secret-value';

function snapshotFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        files[path.relative(root, target)] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      }
    }
  };
  walk(root);
  return files;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-host-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const architect = new GrandArchitect({ dataDir: root });
  await architect.providers.configureProvider({
    providerId: 'opencode-go',
    apiKey: SECRET,
    baseUrl: `https://owner:${URL_PASSWORD}@example.test/v1?token=${URL_QUERY}#fragment`,
    discover: false,
  });
  architect.providers.selectModel({
    providerId: 'opencode-go',
    modelId: 'host-status-model',
    allowManualFallback: true,
  });
  architect.files.enableOwnerMode({ folders: [architect.workspaceDir] });
  architect.memoryStore.put('preference', {
    key: 'report-style',
    text: 'Owner prefers concise reports with independent evidence.',
    tags: ['report', 'evidence'],
    importance: 0.95,
  });
  architect.memoryStore.put('project', {
    key: 'majin-cli',
    text: 'The CLI release marker is HOST-STATUS-MEMORY-42.',
    tags: ['majin', 'cli'],
    importance: 0.8,
  });
  const goal = {
    goal_id: 'goal-host-status',
    objective: 'Inspect the MAJIN host safely',
    status: 'RUNNING',
    criteria: [{ kind: 'file', path: 'proof.txt' }],
    budget: { maxRounds: 20 },
    cost: { modelCalls: 2, inputTokens: 100, outputTokens: 25 },
    tool_results: [{ tool: 'fs_read', ok: true, status: 'completed', operationId: 'op-1' }],
    verification_evidence: [],
    trace: [{ seq: 1, type: 'goal_started' }],
    adaptive: { mode: 'direct', needsReplan: false, verificationFailures: 0, plan: [] },
    delegation: { batches: [], tasks: {} },
    context: { compacted: false, sentMessages: 3 },
  };
  const tools = createHostStatusTools({
    architect,
    goal,
    getRuntimeSnapshot: () => ({
      controller: 'provider',
      driverToolCount: 42,
      hostTools: ['majin_status', 'majin_doctor', 'majin_provider', 'majin_memory'],
      visibleToolCount: 40,
      maxVisibleTools: 64,
      browserAvailable: true,
    }),
  });
  return { root, architect, goal, tools };
}

test('read-only host status tools expose useful V5 state without secrets or writes', async (t) => {
  const { root, architect, tools } = await fixture(t);
  assert.deepEqual([...tools.keys()], ['majin_status', 'majin_doctor', 'majin_provider', 'majin_memory']);
  for (const tool of tools.values()) assert.equal(tool.inputSchema.additionalProperties, false);

  const before = snapshotFiles(root);
  const status = await tools.get('majin_status').run({ detail: 'full' });
  const doctor = await tools.get('majin_doctor').run({});
  const providers = await tools.get('majin_provider').run({ action: 'list' });
  const models = await tools.get('majin_provider').run({ action: 'models' });
  const memoryStatus = await tools.get('majin_memory').run({ action: 'status' });
  const memorySearch = await tools.get('majin_memory').run({ action: 'read', query: 'HOST-STATUS-MEMORY-42' });
  const memoryKey = await tools.get('majin_memory').run({ action: 'read', kind: 'preference', key: 'report-style' });
  const after = snapshotFiles(root);

  assert.deepEqual(after, before, 'host status tools must not write any state file');
  const serialized = JSON.stringify({ status, doctor, providers, models, memoryStatus, memorySearch, memoryKey });
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /maskedKey/);
  assert.doesNotMatch(serialized, new RegExp(URL_PASSWORD));
  assert.doesNotMatch(serialized, new RegExp(URL_QUERY));
  assert.equal(architect.providers.getPublicState().providers['opencode-go'].hasKey, true);

  assert.equal(status.readOnly, true);
  assert.equal(status.workspaceDir, architect.workspaceDir);
  assert.equal(status.provider.canonicalSelection, 'opencode-go/host-status-model');
  assert.equal(status.provider.activeProviderHasKey, true);
  assert.equal(status.provider.active.baseUrl, 'https://example.test/v1');
  assert.equal(status.goal.id, 'goal-host-status');
  assert.equal(status.goal.toolResults.ok, 1);
  assert.ok(status.skills.totalSkills > 0);
  assert.equal(status.memory.total, 2);

  assert.equal(doctor.readOnly, true);
  assert.equal(doctor.healthy, true, JSON.stringify(doctor.checks.filter((item) => item.status === 'fix')));
  assert.equal(doctor.broken, 0);
  assert.ok(!doctor.nextActions.some((action) => /writable/.test(action)), 'healthy directories must not produce fix actions');
  assert.equal(doctor.checks.find((item) => item.id === 'provider-key')?.status, 'ok');
  assert.equal(doctor.checks.find((item) => item.id === 'provider-verified')?.status, 'note');
  assert.equal(doctor.checks.find((item) => item.id === 'tool-exposure')?.status, 'ok');

  assert.equal(providers.activeModelId, 'host-status-model');
  assert.equal(providers.providers.find((item) => item.id === 'opencode-go')?.hasKey, true);
  assert.equal(providers.routing.parentModel, 'opencode-go/host-status-model');
  assert.equal(providers.routing.independentPerJobRoutes, false);
  assert.deepEqual(models.models.map((model) => model.id), ['host-status-model']);
  assert.equal(models.models[0].discovered, false);
  assert.equal(models.models[0].capabilities.streaming, true);

  assert.equal(memoryStatus.total, 2);
  assert.equal(memoryStatus.byKind.preference, 1);
  assert.equal(memorySearch.entries[0].text, 'The CLI release marker is HOST-STATUS-MEMORY-42.');
  assert.equal(memoryKey.entries[0].key, 'report-style');
  assert.equal(memoryKey.trusted, false);
});

test('host status schemas reject provider mutation, API keys and destructive memory actions', async (t) => {
  const { tools } = await fixture(t);
  assert.throws(
    () => tools.get('majin_provider').run({ action: 'add', apiKey: SECRET }),
    (error) => error?.name === 'ZodError',
  );
  assert.throws(
    () => tools.get('majin_provider').run({ action: 'remove' }),
    (error) => error?.name === 'ZodError',
  );
  assert.throws(
    () => tools.get('majin_memory').run({ action: 'clear' }),
    (error) => error?.name === 'ZodError',
  );
  assert.throws(
    () => tools.get('majin_memory').run({ action: 'read', kind: 'secrets', query: 'key' }),
    (error) => error?.name === 'ZodError',
  );
  assert.throws(
    () => tools.get('majin_status').run({ detail: 'full', includeSecrets: true }),
    (error) => error?.name === 'ZodError',
  );
});

test('majin_memory remember stores a screened durable fact, refuses secrets and host-written kinds, and survives restart', async (t) => {
  const { root, architect, tools } = await fixture(t);
  const memory = tools.get('majin_memory');

  const saved = await memory.run({
    action: 'remember', kind: 'preference', key: 'owner.preferred-language',
    text: 'Owner prefers answers in Swedish.', tags: ['language'], importance: 0.9,
  });
  assert.equal(saved.remembered, true);
  assert.equal(saved.kind, 'preference');
  assert.equal(saved.key, 'owner.preferred-language');

  const entry = architect.memoryStore.get('preference', 'owner.preferred-language');
  assert.equal(entry.text, 'Owner prefers answers in Swedish.');
  assert.equal(entry.meta.rememberedBy, 'model');
  assert.equal(entry.meta.goalId, 'goal-host-status');
  assert.equal(entry.sensitive, undefined);

  const readBack = await memory.run({ action: 'read', kind: 'preference', key: 'owner.preferred-language' });
  assert.equal(readBack.entries[0].text, 'Owner prefers answers in Swedish.');

  // Restart persistence: a fresh store over the same data dir sees the fact.
  const reopened = new MemoryStore(path.join(root, 'memory'));
  assert.equal(reopened.get('preference', 'owner.preferred-language')?.text, 'Owner prefers answers in Swedish.');

  // Secrets are refused outright and never stored (not redacted-and-saved).
  assert.throws(
    () => memory.run({ action: 'remember', kind: 'preference', key: 'owner.api-note', text: `The key is ${SECRET}` }),
    (error) => error?.code === 'memory_secret_refused',
  );
  assert.equal(architect.memoryStore.get('preference', 'owner.api-note'), null);
  assert.throws(
    () => memory.run({ action: 'remember', kind: 'project', key: 'endpoint', text: 'Use https://user:hunter2@example.test/api' }),
    (error) => error?.code === 'memory_secret_refused',
  );

  // Host-verified learning kinds cannot be forged by the model.
  assert.throws(
    () => memory.run({ action: 'remember', kind: 'tool-success', key: 'fs-write-works', text: 'fs_write always works.' }),
    (error) => error?.code === 'memory_kind_not_model_writable',
  );
  assert.equal(architect.memoryStore.get('tool-success', 'fs-write-works'), null);

  // Keys must be stable slugs; destructive actions remain schema-rejected.
  assert.throws(
    () => memory.run({ action: 'remember', kind: 'preference', key: 'Not A Slug!', text: 'hello' }),
    (error) => error?.code === 'memory_remember_invalid',
  );
  assert.throws(
    () => memory.run({ action: 'forget', key: 'owner.preferred-language' }),
    (error) => error?.name === 'ZodError',
  );
  assert.ok(architect.memoryStore.get('preference', 'owner.preferred-language'), 'a rejected forget must not delete the entry');
});
