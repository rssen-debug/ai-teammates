// Client regressions use the explicitly labelled demo engine, not live Go.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';
import { evaluationClient } from '../../scripts/v4/evals/live-client.mjs';
import { runBrowserFormEvaluation } from '../../scripts/v4/evals/browser-form.mjs';
import { existingLocalOwnerCookie } from '../../scripts/v4/evals/local-owner.mjs';
import { runSoftwareEvaluation } from '../../scripts/v4/evals/software.mjs';
import { runMonitorEvaluation } from '../../scripts/v4/evals/monitor.mjs';

test('evaluation client uses real host approval continuation and reads a verified artifact', async () => {
  const server = await startTestServer({ env: { MAJIN_V4_WRITE_POLICY: 'strict' } });
  try {
    const client = evaluationClient({ base: server.base, cookie: server.existingSession() });
    const result = await client.run({ task: 'Skriv filen eval-client.txt med innehåll: test', approve: async (pending) => pending.tool === 'workspace_write' });
    assert.equal(result.status, 'completed');
    assert.equal(result.approvals, 1);
    assert.equal(fs.readFileSync(path.join(server.config.workspaceDir, 'eval-client.txt'), 'utf8'), 'test');
  } finally { await server.close(); }
});

test('evaluation client never self-approves an unknown scope; pending eval can be safely denied', async () => {
  const server = await startTestServer({ env: { MAJIN_V4_WRITE_POLICY: 'strict' } });
  try {
    const client = evaluationClient({ base: server.base, cookie: server.existingSession() });
    const result = await client.run({ task: 'Skriv filen denied-eval.txt med innehåll: test' });
    assert.equal(result.status, 'awaiting_approval');
    assert.equal(result.approvals, 0);
    assert.equal(fs.existsSync(path.join(server.config.workspaceDir, 'denied-eval.txt')), false);
    await client.stop(result.conversationId, { rejectPending: true });
    assert.equal(server.context.conversations.get(result.conversationId).pendingApproval, null);
  } finally { await server.close(); }
});

test('live Go form acceptance refuses to substitute demo or change providers', async () => {
  const server = await startTestServer();
  try {
    await assert.rejects(runBrowserFormEvaluation({ base: server.base, cookie: server.existingSession(), workspace: server.config.workspaceDir }), /existing real Go route/);
    assert.deepEqual(fs.readdirSync(server.config.workspaceDir), []);
  } finally { await server.close(); }
});

test('evaluation client refuses credential-bearing host URLs and non-local HTTP', () => {
  for (const base of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?secret=value']) assert.throws(() => evaluationClient({ base, cookie: 'paired=test' }), /Evaluation host/);
});

test('software and monitoring acceptance reject demo before creating any task or artifact',async()=>{
  const s=await startTestServer();
  try{
    const options={base:s.base,cookie:s.existingSession(),workspace:s.config.workspaceDir,output:path.join(s.home,'must-not-exist.json'),sourceDirectory:process.cwd()};
    await assert.rejects(runSoftwareEvaluation(options),/real Go/);
    await assert.rejects(runMonitorEvaluation(options),/real Go/);
    assert.equal(fs.existsSync(options.output),false);assert.deepEqual(fs.readdirSync(s.config.workspaceDir),[]);assert.deepEqual(s.context.backgroundTasks.list(),[]);
  }finally{await s.close();}
});

test('explicit local-owner mode reuses a valid paired session without modifying files or forwarding it remotely', async () => {
  const server = await startTestServer();
  try {
    server.existingSession();
    const files = [server.config.paths.secret, server.config.paths.serverState];
    const original = files.map(file => fs.readFileSync(file));
    const cookie = existingLocalOwnerCookie({ home: server.home, base: server.base });
    assert.ok(server.context.sessions.verify(cookie.slice(cookie.indexOf('=') + 1)));
    for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]), original[i]);
    assert.throws(() => existingLocalOwnerCookie({ home: server.home, base: 'https://example.com' }), /loopback/);
  } finally { await server.close(); }
});
