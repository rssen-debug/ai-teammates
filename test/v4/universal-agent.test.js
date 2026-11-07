/**
 * The universal-agent contract, proven end to end.
 *
 * These tests do not stub `model.chat`. They start a real OpenAI-compatible
 * SSE provider, a real V4 server, and drive real tools through the real
 * registry, ranking and approval policy. What they assert is the property the
 * owner asked for:
 *
 *   the agent can combine tools for a task no skill was written for
 *
 * Two independent capabilities make that true:
 *   1. discovery — a tool that does not fit in the per-request list is found by
 *      tools_search, activated, and callable in the next round;
 *   2. delegation — a bounded subagent with its own context and tool subset.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import {
  startFakeProvider, lastToolMessage, offeredTools,
} from './fake-provider.mjs';

function grantLanes(home, lanes) {
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4', 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes,
    folders: [],
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    history: [],
  }));
}

function realModelEnv(provider) {
  return {
    MAJIN_V4_PROVIDER: 'openai',
    MAJIN_V4_BASE_URL: provider.url,
    MAJIN_V4_API_KEY: 'test-key-not-a-secret',
    MAJIN_V4_MODEL: 'scripted-model',
    MAJIN_V4_RATE_REQUESTS: '1000',
    MAJIN_V4_RATE_TURNS: '1000',
  };
}

const REPORT = 'systemrapport.txt';
const REPORT_TEXT = 'CPU och minne inventerade av MAJIN.';

test('delegation: an explicit empty tool allowlist grants no tools', async () => {
  const home = tempHome();
  grantLanes(home, ['agent']);
  let childObserved = false;
  const provider = await startFakeProvider((body) => {
    const child = body.messages.some((message) => message.role === 'system' && /MAJIN subagent/.test(message.content));
    if (child) {
      childObserved = true;
      assert.deepEqual(offeredTools(body), []);
      return { text: 'reasoning only' };
    }
    if (lastToolMessage(body)) return { text: 'Finished bounded reasoning.' };
    return { toolCalls: [{ name: 'agent_delegate', args: { task: 'Think without using any tools.', tools: [] } }] };
  });
  const server = await startTestServer({ home, env: realModelEnv(provider) });
  try {
    const { cookie } = await server.pair();
    await readSse(await postChat(server.base, cookie, { text: 'Delegate reasoning only.', requestId: 'empty-allowlist' }));
    assert.equal(childObserved, true);
  } finally { await server.close(); await provider.close(); }
});

test('universal: a new task is composed from a discovered tool, a real file and a read-back', async () => {
  const home = tempHome();
  // Only the sys lane is granted: system introspection is real, nothing else.
  grantLanes(home, ['sys']);

  const provider = await startFakeProvider((body, index) => {
    // The script branches on what the tools actually returned — this is what
    // makes it a composition test rather than five hardcoded round trips.
    if (index === 0) {
      return { toolCalls: [{ name: 'tools_search', args: { query: 'system information cpu memory' } }] };
    }
    const last = lastToolMessage(body);
    if (index === 1) {
      const found = last?.data?.matches?.[0]?.name;
      assert.ok(found, `tools_search returned nothing to activate: ${JSON.stringify(last)}`);
      return { toolCalls: [{ name: 'tools_activate', args: { names: [found] } }] };
    }
    if (index === 2) {
      const activated = last?.data?.activated || [];
      assert.ok(activated.includes('sys_info'), `sys_info was not activated: ${JSON.stringify(last)}`);
      return { toolCalls: [{ name: 'sys_info', args: {} }] };
    }
    if (index === 3) {
      assert.match(String(last?.data?.result || ''), /Linux|Windows|darwin/i, 'sys.info returned no operating system');
      return { toolCalls: [{ name: 'workspace_write', args: { fileName: REPORT, content: REPORT_TEXT } }] };
    }
    if (index === 4) {
      return { toolCalls: [{ name: 'workspace_read', args: { fileName: REPORT } }] };
    }
    return { text: `KLART: ${REPORT} skrevs och lästes tillbaka.` };
  });

  const s = await startTestServer({
    home,
    env: {
      ...realModelEnv(provider),
      MAJIN_V4_MAX_VISIBLE_TOOLS: '8',
      MAJIN_V4_MAX_TOOL_CALLS: '12',
      MAJIN_V4_MAX_MODEL_ROUNDS: '8',
    },
  });

  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Inventera maskinen, skriv en rapport och verifiera den.',
      requestId: 'universal-1',
    }));

    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', `turn did not complete: ${JSON.stringify(done)}`);

    const results = events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    for (const name of ['tools_search', 'tools_activate', 'sys_info', 'workspace_write', 'workspace_read']) {
      assert.ok(results.some((r) => r.name === name && r.ok), `no successful call to ${name}: ${JSON.stringify(results.map((r) => [r.name, r.ok]))}`);
    }

    // Discovery is what made sys_info callable: it was not in the first list,
    // and it was in the list after tools_activate.
    assert.equal(provider.requests.length, 6, 'expected six model rounds');
    assert.ok(!offeredTools(provider.requests[0]).includes('sys_info'), 'sys_info was offered before it was activated');
    assert.ok(offeredTools(provider.requests[3]).includes('sys_info'), 'sys_info did not reach the next round');

    // The file is real and verified on disk.
    const written = fs.readFileSync(path.join(home, 'workspace', REPORT), 'utf8');
    assert.equal(written, REPORT_TEXT);

    // The V2 verifier ran and the goal completed: the model's words are not the
    // evidence, the file hash is.
    const goal = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'goals', `${done.goalId}.json`), 'utf8'));
    assert.equal(goal.state, 'COMPLETED');
    const verifiedWrite = goal.receipts.find((r) => r.action === 'tool:workspace_write' && r.verified);
    assert.ok(verifiedWrite, 'the workspace write was never independently verified');

    // And the answer persisted in the conversation the phone reopens.
    const read = await fetch(`${s.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie } });
    const conv = (await read.json()).conversation;
    assert.match(conv.messages.at(-1).content, /KLART/);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('universal: delegation runs a bounded subagent with its own tools and context', async () => {
  const home = tempHome();
  grantLanes(home, ['agent', 'files']);

  let childRequests = 0;
  const provider = await startFakeProvider((body, index) => {
    const isChild = (body.messages || []).some((m) => m.role === 'system' && /MAJIN subagent/.test(String(m.content)));
    if (isChild) {
      childRequests += 1;
      // A subagent cannot delegate: the tool must not even be offered.
      assert.ok(!offeredTools(body).includes('agent_delegate'), 'the subagent was offered delegation');
      assert.ok(offeredTools(body).includes('workspace_list'), 'the subagent did not get the tool it was told to use');
      const last = lastToolMessage(body);
      if (!last) return { toolCalls: [{ name: 'workspace_list', args: {} }] };
      return { text: `DELSVAR: arbetsytan innehåller ${last?.data?.files?.length ?? 0} fil(er).` };
    }
    const last = lastToolMessage(body);
    if (!last) {
      return {
        toolCalls: [{
          name: 'agent_delegate',
          args: { task: 'Läs arbetsytan och rapportera antalet filer.', tools: ['workspace_list'], maxRounds: 2 },
        }],
      };
    }
    assert.equal(last?.data?.tools?.[0], 'workspace_list', `the subagent used unexpected tools: ${JSON.stringify(last)}`);
    return { text: `SAMMANFATTNING: ${last?.data?.answer || ''}` };
  });

  const s = await startTestServer({
    home,
    env: {
      ...realModelEnv(provider),
      MAJIN_V4_MAX_VISIBLE_TOOLS: '32',
      MAJIN_V4_MAX_TOOL_CALLS: '12',
      MAJIN_V4_MAX_MODEL_ROUNDS: '6',
    },
  });

  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Dela upp inventeringen i en subagent.',
      requestId: 'universal-2',
    }));
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', `turn failed: ${JSON.stringify(done)}`);
    assert.equal(childRequests, 2, 'the subagent did not complete its own loop');

    const delegate = events.find((e) => e.type === 'tool_result' && e.data?.name === 'agent_delegate')?.data;
    assert.ok(delegate?.ok, 'delegation failed');

    const read = await fetch(`${s.base}/api/conversation?id=${done.conversationId}`, { headers: { cookie } });
    const conv = (await read.json()).conversation;
    const answer = conv.messages.at(-1).content;
    assert.match(answer, /SAMMANFATTNING/);
    assert.match(answer, /DELSVAR/, 'the subagent answer did not reach the parent turn');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
