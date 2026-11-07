/**
 * "Full permission" — the owner's decision, made one tap away and never hidden.
 *
 * The owner's report from the phone: a task stopped at `browser_open` with
 * "no consent on file for this exact scope", and he asked for full permission so
 * MAJIN can do what he asks without a prompt.
 *
 * That is his machine and his choice, so it is implemented — but a policy that
 * removes every prompt must be:
 *
 *   - a stored decision, not an environment variable he has to remember
 *   - visible in the app and readable from the API, so he always knows
 *   - audited: every auto-approved held call is recorded
 *   - unable to widen WHICH tools exist: Owner Mode still decides the lanes
 *
 * These tests drive the real server and the real tool runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { startFakeProvider, lastToolMessage } from './fake-provider.mjs';
import {
  APPROVAL_POLICIES, readApprovalPolicy, writeApprovalPolicy, createPolicyAwareApprovals,
} from '../../src/v4/approval-policy.js';
import { Approvals } from '../../src/v2/safety/approvals.js';

const noopBus = { emit: () => {} };

async function approvalApi(s, cookie, init = {}) {
  const res = await fetch(`${s.base}/api/approvals`, {
    ...init,
    headers: {
      cookie,
      ...(init.method && init.method !== 'GET' ? { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base } : {}),
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * A held tool that does nothing harmful: `exec_start` is tier `process`, so the
 * runner holds it unless the policy says otherwise. Granting the shell lane makes
 * it exist; the policy decides whether it waits.
 */
function heldLaneEnv(provider) {
  return {
    MAJIN_V4_PROVIDER: 'openai',
    MAJIN_V4_BASE_URL: provider.url,
    MAJIN_V4_API_KEY: 'test-key-not-a-secret',
    MAJIN_V4_MODEL: 'scripted-model',
    MAJIN_V4_MAX_VISIBLE_TOOLS: '64',
    MAJIN_V4_MAX_TOOL_CALLS: '8',
    MAJIN_V4_MAX_MODEL_ROUNDS: '6',
    MAJIN_V4_RATE_REQUESTS: '1000',
    MAJIN_V4_RATE_TURNS: '1000',
  };
}

test('approvals: the policy is a stored decision and defaults to asking', () => {
  const home = tempHome();
  try {
    const file = path.join(home, 'approvals.json');
    assert.equal(readApprovalPolicy(file), APPROVAL_POLICIES.ASK, 'an unset policy must ask');
    writeApprovalPolicy(file, APPROVAL_POLICIES.AUTO);
    assert.equal(readApprovalPolicy(file), APPROVAL_POLICIES.AUTO);
    // An unknown value is REFUSED rather than silently stored as something else:
    // a typo must not be able to quietly change what the app believes.
    assert.throws(() => writeApprovalPolicy(file, 'whatever'), /policy must be one of/);
    assert.equal(readApprovalPolicy(file), APPROVAL_POLICIES.AUTO, 'a refused write must not change the stored value');
    // A corrupt file degrades to asking, not to trust.
    fs.writeFileSync(file, '{not json');
    assert.equal(readApprovalPolicy(file), APPROVAL_POLICIES.ASK);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('approvals: full trust allows a held tool immediately, asks otherwise', () => {
  const home = tempHome();
  try {
    const file = path.join(home, 'approvals.json');
    const seen = [];
    const layer = createPolicyAwareApprovals({
      approvals: new Approvals(noopBus),
      policyFile: file,
      onAutoApprove: (e) => seen.push(e.scope),
    });

    assert.equal(layer.check('tool:exec_start').decision, 'waiting', 'ask must hold');
    layer.set(APPROVAL_POLICIES.AUTO);
    assert.equal(layer.check('tool:exec_start').decision, 'allow');
    assert.deepEqual(seen, ['tool:exec_start'], 'an auto-approval must be recorded');

    // The switch takes effect on the next call in both directions.
    layer.set(APPROVAL_POLICIES.ASK);
    assert.equal(layer.check('tool:exec_start').decision, 'waiting');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('approvals: the phone can read and change the policy, and a restart remembers', async () => {
  const home = tempHome();
  const provider = await startFakeProvider({ text: 'ok' });
  let s = null;
  let after = null;
  try {
    s = await startTestServer({ home, env: heldLaneEnv(provider) });
    const { cookie } = await s.pair();

    const initial = await approvalApi(s, cookie);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.policy, 'ask', 'a fresh host must ask');

    const changed = await approvalApi(s, cookie, { method: 'POST', body: JSON.stringify({ policy: 'auto' }) });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.policy, 'auto');

    // Rejected values never become full trust.
    const bad = await approvalApi(s, cookie, { method: 'POST', body: JSON.stringify({ policy: 'yes-please' }) });
    assert.equal(bad.status, 400);
    const stillAuto = await approvalApi(s, cookie);
    assert.equal(stillAuto.body.policy, 'auto');

    // CSRF is required for the change.
    const noCsrf = await fetch(`${s.base}/api/approvals`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ policy: 'ask' }),
    });
    assert.equal(noCsrf.status, 403);

    // A restart keeps the decision.
    await s.close({ keep: true });
    s = null;
    after = await startTestServer({ home, env: heldLaneEnv(provider) });
    const remembered = await approvalApi(after, after.existingSession());
    assert.equal(remembered.body.policy, 'auto', 'the decision did not survive a restart');
  } finally {
    if (s) await s.close();
    if (after) await after.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('approvals: with full trust a real held tool runs instead of waiting', { timeout: 60_000 }, async () => {
  /**
   * `fs_write` is tier `write`, so the runner holds it: it is the cheapest
   * cross-platform tool that exercises the real approval path.
   *
   * The first version used `exec_start`, which spawns a child process. On Windows
   * that hung until the test timed out — the approval behaviour was never at
   * fault, the fixture was. A new file in a granted folder proves exactly the same
   * thing without a shell.
   */
  const home = tempHome();
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4', 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes: ['files'],
    folders: [documents],
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    history: [],
  }));
  const target = path.join(documents, 'full-trust.txt');

  const provider = await startFakeProvider((body) => {
    const last = lastToolMessage(body);
    if (last) return { text: 'Klart.' };
    return { toolCalls: [{ name: 'fs_write', args: { path: target, content: 'skrivet utan att fråga' } }] };
  });
  let s = null;
  try {
    s = await startTestServer({ home, env: heldLaneEnv(provider) });
    const { cookie } = await s.pair();

    // Default: the turn stops and asks, and the file is NOT written.
    const first = await readSse(await postChat(s.base, cookie, { text: 'Skriv filen.', requestId: 'ht-1' }));
    const firstDone = first.find((e) => e.type === 'done')?.data;
    assert.equal(firstDone?.status, 'awaiting_approval',
      `a held tool ran without a policy decision: ${JSON.stringify(firstDone)}`);
    assert.equal(fs.existsSync(target), false, 'a held tool wrote the file before consent');

    // Full trust: the same call runs and the bytes land on disk.
    await approvalApi(s, cookie, { method: 'POST', body: JSON.stringify({ policy: 'auto' }) });
    const second = await readSse(await postChat(s.base, cookie, { text: 'Skriv filen igen.', requestId: 'ht-2' }));
    const secondDone = second.find((e) => e.type === 'done')?.data;
    assert.notEqual(secondDone?.status, 'awaiting_approval', 'full trust still asked for approval');
    const results = second.filter((e) => e.type === 'tool_result').map((e) => e.data);
    assert.ok(results.some((r) => r.name === 'fs_write'), `the tool never ran: ${JSON.stringify(results)}`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'skrivet utan att fråga',
      'full trust allowed the call but the file was not written');
  } finally {
    if (s) await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('approvals: full trust does not widen which tools exist', async () => {
  // Owner Mode still decides the lanes. Full trust only removes the prompt inside
  // them, so a tool from an ungranted lane must remain unregistered.
  const home = tempHome();
  const provider = await startFakeProvider({ text: 'ok' });
  const s = await startTestServer({ home, env: heldLaneEnv(provider) });
  try {
    const { cookie } = await s.pair();
    await approvalApi(s, cookie, { method: 'POST', body: JSON.stringify({ policy: 'auto' }) });

    const caps = await (await fetch(`${s.base}/api/capabilities`, { headers: { cookie } })).json();
    const names = (caps.tools?.registered || []).map((t) => t.name);
    // No lane was granted on this host, so no host tool may appear.
    assert.ok(!names.some((n) => n.startsWith('exec_')), 'full trust registered a tool from an ungranted lane');
    assert.ok(!names.some((n) => n.startsWith('fs_')), 'full trust registered a filesystem tool with no folder granted');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('approvals: a change made by another process is picked up without a restart', async () => {
  /**
   * The CLI writes the same file the app writes. A server that cached the policy
   * at boot would keep asking after the owner said "never ask" — the exact
   * confusion this feature exists to remove. The facade re-reads on modification
   * time, so a held call after the change already sees the new policy.
   */
  const home = tempHome();
  const file = path.join(home, 'approvals.json');
  try {
    const layer = createPolicyAwareApprovals({
      approvals: new Approvals(noopBus),
      policyFile: file,
    });
    assert.equal(layer.check('tool:fs_write').decision, 'waiting');

    // Another process (the CLI) writes the decision.
    writeApprovalPolicy(file, APPROVAL_POLICIES.AUTO);
    assert.equal(layer.policy, APPROVAL_POLICIES.AUTO, 'the running layer did not notice the change');
    assert.equal(layer.check('tool:fs_write').decision, 'allow');

    writeApprovalPolicy(file, APPROVAL_POLICIES.ASK);
    assert.equal(layer.check('tool:fs_write').decision, 'waiting', 'turning it off did not take effect');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
