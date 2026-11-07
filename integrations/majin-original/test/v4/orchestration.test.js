/**
 * Multi-agent orchestration, proven end to end.
 *
 * The architect's finding was specific: V1's standing teams and V2's scheduled
 * DAG were not replaced in V4, only approximated by a two-level delegation.
 * These tests drive the REAL chain — a scripted OpenAI-compatible provider, the
 * real V4 server, the real registry — through:
 *
 *   agent_graph  : V2's TaskGraph + runGraph, executed by V4 subagents
 *   team_run     : V1's TeamStore + runTeam + runSwarm, executed by V4 subagents
 *
 * and assert the properties that make them equivalent rather than decorative:
 * dependency order, results flowing into later steps, receipts, persisted
 * roster/blackboard/checkpoint, and a resume that does not repeat finished work.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { startFakeProvider, lastToolMessage, offeredTools, lastUserMessage } from './fake-provider.mjs';

function grantAgentLane(home) {
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4', 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes: ['agent'],
    folders: [],
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    history: [],
  }));
}

const env = (provider) => ({
  MAJIN_V4_PROVIDER: 'openai',
  MAJIN_V4_BASE_URL: provider.url,
  MAJIN_V4_API_KEY: 'test-key-not-a-secret',
  MAJIN_V4_MODEL: 'scripted-model',
  MAJIN_V4_MAX_VISIBLE_TOOLS: '40',
  MAJIN_V4_MAX_TOOL_CALLS: '20',
  MAJIN_V4_MAX_MODEL_ROUNDS: '10',
  MAJIN_V4_RATE_REQUESTS: '1000',
  MAJIN_V4_RATE_TURNS: '1000',
});

const isChild = (body) => (body.messages || [])
  .some((m) => m.role === 'system' && /MAJIN subagent/.test(String(m.content)));

test('graph: exhausted child reasoning budget is incomplete and blocks dependents despite successful tool reads',async()=>{
  const home=tempHome();grantAgentLane(home);let parentCalls=0,childCalls=0,observedGraph;
  const provider=await startFakeProvider(body=>{
    if(isChild(body)){childCalls++;return {text:'Still checking.',toolCalls:[{name:'workspace_list',args:{}}]};}
    if(parentCalls++===0)return {toolCalls:[{name:'agent_graph',args:{steps:[
      {id:'a',task:'Keep researching until independently finished.'},
      {id:'b',task:'Publish the completed research.',deps:['a']},
    ]}}]};
    const result=lastToolMessage(body)?.data;
    observedGraph=result;
    assert.equal(result?.ok,false);assert.equal(result.failed,1);assert.equal(result.blocked,1);
    assert.match(result.results.find(r=>r.id==='a').error,/model round budget exhausted/);
    return {text:'The research is incomplete: the bounded worker exhausted its model rounds. Publication did not run.'};
  });
  const s=await startTestServer({home,env:env(provider)});
  try{
    const {cookie}=await s.pair();
    const events=await readSse(await postChat(s.base,cookie,{text:'Run bounded research graph.',requestId:'graph-round-budget'}));
    const result=observedGraph;
    assert.equal(result?.ok,false);assert.equal(result.done,0);assert.equal(result.failed,1);assert.equal(result.blocked,1);
    assert.equal(childCalls,3,'no fourth model call and no dependent worker');assert.equal(parentCalls,2);
    assert.equal(JSON.stringify(events).includes('FAKE_PROVIDER_ERROR'),false);
  }finally{await s.close();await provider.close();}
});

test('graph: dependencies are respected, results flow forward, artifacts are verified', async () => {
  const home = tempHome();
  grantAgentLane(home);
  const childTasks = [];
  // Provider requests include the subagents' own calls, so a raw request index
  // is not the parent's round number. Count the parent's rounds explicitly.
  let parentRound = -1;

  const provider = await startFakeProvider((body) => {
    if (isChild(body)) {
      const task = lastUserMessage(body);
      const last = lastToolMessage(body);
      if (!last) {
        childTasks.push(task);
        if (task.includes('Skapa filen graph-a')) {
          return { toolCalls: [{ name: 'workspace_write', args: { fileName: 'graph-a.txt', content: 'FRÅN A' } }] };
        }
        if (task.includes('Läs filen graph-a')) {
          return { toolCalls: [{ name: 'workspace_read', args: { fileName: 'graph-a.txt' } }] };
        }
        return { text: 'SVAR-C: oberoende steg klart' };
      }
      return { text: `SVAR: ${task.slice(0, 20)} bearbetad` };
    }
    parentRound += 1;
    const last = lastToolMessage(body);
    if (parentRound === 0) {
      return {
        toolCalls: [{
          name: 'agent_graph',
          args: {
            steps: [
              { id: 'a', task: 'Skapa filen graph-a med innehållet FRÅN A.' },
              { id: 'b', task: 'Läs filen graph-a och sammanfatta den.', deps: ['a'] },
              { id: 'c', task: 'Räkna till tre och svara kort.' },
            ],
            concurrency: 2,
          },
        }],
      };
    }
    assert.equal(last?.data?.done, 3, `graph did not finish every step: ${JSON.stringify(last)}`);
    return { text: 'KLART: grafen körde alla tre stegen.' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, { text: 'Kör en graf.', requestId: 'graph-1' }));
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', `turn failed: ${JSON.stringify(events.filter((e) => e.type === 'error'))}`);

    const graphResult = events.find((e) => e.type === 'tool_result' && e.data?.name === 'agent_graph')?.data;
    assert.ok(graphResult?.ok, `agent_graph failed: ${JSON.stringify(graphResult)}`);

    // Dependency order and the forwarded result: step b must have seen a's answer.
    assert.equal(childTasks.length, 3, `expected three subagent runs, saw ${childTasks.length}`);
    const bTask = childTasks.find((t) => t.includes('Läs filen graph-a'));
    assert.ok(bTask, 'step b never ran');
    assert.match(bTask, /Results from earlier steps/, 'step b did not receive earlier step results');
    assert.match(bTask, /\[a\]/, 'the result of step a was not passed to step b');

    // The file is real, and the write was verified and lifted onto the parent.
    assert.equal(fs.readFileSync(path.join(home, 'workspace', 'graph-a.txt'), 'utf8'), 'FRÅN A');
    const goal = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'goals', `${done.goalId}.json`), 'utf8'));
    assert.equal(goal.state, 'COMPLETED');
    const lifted = goal.receipts.find((r) => r.action === 'subagent.verify' && String(r.target).includes('graph-a.txt'));
    assert.ok(lifted?.verified, 'the graph artifact was never verified on the parent goal');

    assert.ok(offeredTools(provider.requests[0]).includes('agent_graph'), 'the model was not offered agent_graph');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team: roster, blackboard, dependency order, checkpoint and resume without repeats', async () => {
  const home = tempHome();
  grantAgentLane(home);
  const childTasks = [];
  let runId = null;
  let parentRound = -1;

  const provider = await startFakeProvider((body) => {
    if (isChild(body)) {
      const task = lastUserMessage(body);
      const last = lastToolMessage(body);
      if (!last) childTasks.push(task);
      // The second goal must see the first member's result.
      if (!last) return { text: `MEDLEMSSVAR: ${task.slice(0, 40)}` };
      return { text: 'klart' };
    }
    parentRound += 1;
    const last = lastToolMessage(body);
    if (parentRound === 0) {
      return { toolCalls: [{ name: 'team_manage', args: { action: 'create', team: 'demo' } }] };
    }
    if (parentRound === 1) {
      return {
        toolCalls: [
          { id: 'add1', name: 'team_manage', args: { action: 'add', team: 'demo', id: 'spanare', role: 'samla fakta', tools: ['workspace_list'], maxSteps: 2 } },
          { id: 'add2', name: 'team_manage', args: { action: 'add', team: 'demo', id: 'skrivare', role: 'sammanställa', tools: ['workspace_write', 'workspace_list'], maxSteps: 2 } },
        ],
      };
    }
    if (parentRound === 2) {
      return { toolCalls: [{ name: 'team_manage', args: { action: 'note', team: 'demo', id: 'spanare', key: 'fynd', value: 'arbetsytan är tom' } }] };
    }
    if (parentRound === 3) {
      return {
        toolCalls: [{
          name: 'team_run',
          args: {
            team: 'demo',
            cap: 2,
            goals: [
              { id: 'g1', member: 'spanare', input: 'Inventera arbetsytan.' },
              { id: 'g2', member: 'skrivare', input: 'Skriv en kort slutsats.', deps: ['g1'] },
            ],
          },
        }],
      };
    }
    if (parentRound === 4) {
      runId = last?.data?.runId || null;
      assert.ok(runId, `team_run returned no runId: ${JSON.stringify(last)}`);
      assert.equal(last.data.status, 'complete', `team run was not complete: ${JSON.stringify(last.data)}`);
      // Resume the same run: every node is already checkpointed, so nothing may run again.
      return { toolCalls: [{ name: 'team_run', args: { team: 'demo', resumeId: runId, goals: [
        { id: 'g1', member: 'spanare', input: 'Inventera arbetsytan.' },
        { id: 'g2', member: 'skrivare', input: 'Skriv en kort slutsats.', deps: ['g1'] },
      ] } }] };
    }
    const resumed = last?.data || {};
    assert.deepEqual([...(resumed.skipped || [])].sort(), ['g1', 'g2'], 'resume did not skip finished work');
    return { text: 'KLART: teamet körde och återupptogs utan omkörning.' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, { text: 'Sätt ihop ett team.', requestId: 'team-1' }));
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', `turn failed: ${JSON.stringify(events.filter((e) => e.type === 'error'))}`);

    // Both members actually ran, once each, before the resume.
    assert.equal(childTasks.length, 2, `expected two member runs, saw ${childTasks.length}`);

    // Persistent state on disk, in V1's own layout.
    const teamDir = path.join(home, 'workspace', 'teams', 'demo');
    const roster = JSON.parse(fs.readFileSync(path.join(teamDir, 'roster.json'), 'utf8'));
    assert.deepEqual(roster.members.map((m) => m.id).sort(), ['skrivare', 'spanare']);
    assert.equal(roster.members.find((m) => m.id === 'spanare').role, 'samla fakta');
    const board = fs.readFileSync(path.join(teamDir, 'memory.jsonl'), 'utf8').trim().split('\n');
    assert.ok(board.some((line) => line.includes('fynd')), 'the blackboard note was not persisted');

    const checkpoint = JSON.parse(fs.readFileSync(path.join(teamDir, 'runs', runId, 'checkpoint.json'), 'utf8'));
    assert.deepEqual(Object.keys(checkpoint.done).sort(), ['g1', 'g2']);
    assert.equal(checkpoint.status, 'complete');

    // The API exposes the same view the agent sees.
    const view = await (await fetch(`${s.base}/api/teams?team=demo`, { headers: { cookie } })).json();
    assert.equal(view.members.length, 2);
    assert.ok(view.runs.some((r) => r.id === runId));

    assert.ok(offeredTools(provider.requests[0]).includes('team_run'), 'the model was not offered team_run');
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team: a budget breach is loud, not a silent truncation', async () => {
  const home = tempHome();
  grantAgentLane(home);
  let parentRound = -1;
  let budgetResult = null;
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'medlemsarbete' };
    parentRound += 1;
    const last = lastToolMessage(body);
    if (parentRound === 0) return { toolCalls: [{ name: 'team_manage', args: { action: 'create', team: 'snal' } }] };
    if (parentRound === 1) {
      return { toolCalls: [{ name: 'team_manage', args: { action: 'add', team: 'snal', id: 'arbetare', role: 'jobba', maxSteps: 2 } }] };
    }
    if (parentRound === 3) {
      budgetResult = last?.data || null;
      return { text: 'klart' };
    }
    if (parentRound === 2) {
      return {
        toolCalls: [{
          name: 'team_run',
          args: {
            team: 'snal',
            teamStepCap: 1,
            goals: [
              { id: 't1', member: 'arbetare', input: 'första' },
              { id: 't2', member: 'arbetare', input: 'andra' },
            ],
          },
        }],
      };
    }
    return { text: 'klart' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, { text: 'Kör med för liten budget.', requestId: 'team-2' }));
    assert.ok(events.find((e) => e.type === 'tool_result' && e.data?.name === 'team_run'), 'team_run produced no result');

    // The cap is 1 step and each member reports at least 1, so the second launch
    // must be refused LOUDLY. What matters is what the model was told: a result
    // marked ok:false with a failed or blocked node, never a quiet truncation.
    assert.ok(budgetResult, 'the model never received a team_run result');
    assert.equal(budgetResult.ok, false, `the budget breach was reported as success: ${JSON.stringify(budgetResult)}`);
    assert.ok((budgetResult.failCount || 0) + (budgetResult.blockedCount || 0) >= 1,
      `a refused node was silently dropped: ${JSON.stringify(budgetResult)}`);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
