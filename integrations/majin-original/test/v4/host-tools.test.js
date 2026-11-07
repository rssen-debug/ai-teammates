/**
 * Host tool bus: the honesty contract.
 *
 * These tests do NOT prove that Windows desktop control works — this machine is
 * Linux and has no browser binary. They prove the property that matters before
 * any of that: a capability that is absent is absent everywhere, and nothing
 * claims otherwise.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { runTool } from '../../src/v2/tools/runner.js';
import {
  RISK_TO_TIER, LANE_EXPORTS, V1_LANES, adaptV1Tool, browserBinary,
  describeCapabilities, hostCapabilities, registerHostTools, zodFromV1Params,
} from '../../src/v4/tools/host.js';
import { tempHome } from './helpers.mjs';
import { v1Context } from '../../src/v4/tools/host.js';
import { runInTurn } from '../../src/v4/turn-state.js';

test('host: rejected input names the missing argument without echoing private values', async () => {
  const registry = new ToolRegistry(); let executed = false;
  registry.define({ name: 'controlled_fill', description: 'Test input error', tier: 'read', inputSchema: z.object({value:z.string()}), outputSchema:z.object({}), execute:async()=>{executed=true;return {};} });
  await assert.rejects(runTool({tool:'controlled_fill',input:{text:'private-content'}},{registry}), error => {
    assert.match(error.message,/at value:/); assert.doesNotMatch(error.message,/private-content/); return true;
  });
  assert.equal(executed,false);
});

test('host: concurrent goals get isolated V1 sessions and approvals retain the same goal session', async () => {
  const context = v1Context({ session: 'v4' });
  assert.equal(context.session, 'v4', 'non-agent callers retain their explicit fallback');
  const observed = await Promise.all(['goal_A', 'goal_B'].map((id) => runInTurn({ goal: { id } }, async () => {
    const before = context.session;
    await new Promise((resolve) => setImmediate(resolve));
    return [before, context.session];
  })));
  assert.deepEqual(observed, [['v4:goal_A', 'v4:goal_A'], ['v4:goal_B', 'v4:goal_B']]);
  assert.equal(runInTurn({ goal: { id: 'goal_A' } }, () => context.session), 'v4:goal_A', 'resumed checkpoint uses its original browser/job session');
});

test('host: browser uploads enforce live folder grants before reaching the browser', async () => {
  const home=tempHome(), workspace=path.join(home,'workspace'), outside=path.join(home,'private');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  let folders=[], executed=0;
  const registry=new ToolRegistry();
  registry.define(adaptV1Tool({name:'browser.upload',group:'web',risk:'exec',desc:'Controlled upload boundary',
    raw:{path:'string: local file',ref:'string optional: observed control'},parameters:{required:['path']},
    run:async()=>{executed++;return {ok:true,result:'controlled no-op',summary:'controlled no-op'};}},
    {lane:'web',ctx:v1Context({workspaceDir:workspace,folders:()=>folders})}));
  const upload=p=>runTool({tool:'browser_upload',input:{path:p,ref:'e1'}},{registry,approvals:{check:()=>({decision:'allow'})}});
  try {
    assert.equal((await upload('synthetic.txt')).ok,true);
    await assert.rejects(upload(path.join(outside,'synthetic.txt')),e=>e.cls==='PERMISSION_DENIED');
    await assert.rejects(upload('../private/synthetic.txt'),e=>e.cls==='PERMISSION_DENIED');
    assert.equal(executed,1,'out-of-grant paths never reach the V1 browser tool');
    folders=[outside]; assert.equal((await upload(path.join(outside,'synthetic.txt'))).ok,true);
    folders=[]; await assert.rejects(upload(path.join(outside,'synthetic.txt')),e=>e.cls==='PERMISSION_DENIED');
    assert.equal(executed,2,'revocation takes effect on the next upload');
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});

test('host: adapted V1 calls receive the real per-call abort signal without mutating shared context', async()=>{
  const ctl=new AbortController(), ctx=v1Context(); let observed;
  const adapted=adaptV1Tool({name:'controlled.wait',risk:'read',desc:'Controlled abort propagation',raw:{},run:async(_,callContext)=>{
    observed=callContext.signal;
    await new Promise((_,reject)=>callContext.signal.addEventListener('abort',()=>reject(callContext.signal.reason),{once:true}));
  }},{lane:'web',ctx});
  const stopped=assert.rejects(adapted.execute({}, {signal:ctl.signal}),/controlled stop/);
  assert.equal(observed,ctl.signal); assert.equal(ctx.signal,undefined);
  ctl.abort(new Error('controlled stop'));await stopped;
});

test('host: capability detection is self-consistent on whatever host runs it', async () => {
  const caps = await hostCapabilities({ platform: 'linux' });
  // Desktop is Windows-only, always, on Linux.
  assert.equal(caps.lanes.desktop.available, false);
  assert.match(caps.lanes.desktop.reason, /Windows-only/);
  // The browser runtime depends on the machine: a CI image may ship a browser.
  // The contract is not "false", it is "a boolean plus a reason when false".
  assert.equal(typeof caps.browserRuntime.available, 'boolean');
  if (!caps.browserRuntime.available) assert.ok(caps.browserRuntime.reason, 'an unavailable runtime must say why');
});

test('host: the capability report is serialisable and carries no module handles', async () => {
  const caps = await hostCapabilities();
  const described = describeCapabilities(caps);
  const json = JSON.stringify(described);
  assert.ok(!json.includes('[object Module]'));
  assert.ok(!json.includes('"module"'));
  for (const lane of ['desktop', 'files', 'shell', 'web', 'jobs']) {
    assert.equal(typeof described.lanes[lane].available, 'boolean');
    assert.ok(Array.isArray(described.lanes[lane].tools));
  }
  assert.equal(typeof described.browserRuntime.available, 'boolean');
});

test('host: a lane reported unavailable registers no tools at all', async () => {
  // Synthetic caps: the real host may or may not have a browser, and the
  // contract must hold either way.
  const caps = {
    platform: 'linux',
    browserRuntime: { available: false, reason: 'synthetic: no browser' },
    lanes: {
      desktop: { available: false, reason: 'Windows-only (this host is linux)' },
      files: { available: false, reason: 'not loaded in this test' },
      web: { available: true, exportName: 'webTools', module: { webTools: [
        { name: 'web.search', desc: 'search the web', risk: 'net', raw: {}, run: async () => ({ ok: true }) },
        { name: 'browser.open', desc: 'open a page', risk: 'browser', raw: {}, run: async () => ({ ok: true }) },
      ] } },
    },
  };
  const registry = new ToolRegistry();
  const { registered, skipped } = registerHostTools(registry, caps);
  const names = registered.map((r) => r.name);
  assert.ok(!names.some((n) => n.startsWith('control')), 'no desktop tool when the lane is unavailable');
  assert.ok(names.includes('web_search'), 'the available tool in the same lane is registered');
  assert.ok(!names.some((n) => n.startsWith('browser')), 'a browser tool is withheld without a runtime');
  assert.ok(skipped.some((s) => s.lane === 'desktop'));
  assert.ok(skipped.some((s) => s.tool === 'browser.open' && /browser runtime/.test(s.reason)));
});

test('host: available lanes register with tiers that drive approval', async () => {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const { registered } = registerHostTools(registry, caps);
  const byName = Object.fromEntries(registered.map((r) => [r.name, r]));

  assert.ok(byName.fs_read, 'file reads are available');
  assert.equal(byName.fs_read.tier, 'read', 'a read is auto-approved');
  assert.equal(byName.fs_delete.tier, 'process', 'a delete is a held operation');
  if (byName.exec_start) {
    assert.equal(byName.exec_start.tier, 'process', 'a shell is a held operation');
  }
  // every registered tool has a tier the runner understands
  for (const r of registered) {
    assert.ok(['read', 'write', 'process', 'browser', 'external'].includes(r.tier), r.name);
  }
});

test('host: a held shell tool cannot run without consent', async () => {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const { registered } = registerHostTools(registry, caps);
  if (!registered.some((r) => r.name === 'exec_start')) return; // lane absent on this host

  const denier = { check: () => ({ decision: 'waiting', note: 'no consent on file' }) };
  const result = await runTool(
    { tool: 'exec_start', input: { backend: 'local', command: 'echo hej' } },
    { registry, approvals: denier, timeoutMs: 5000 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.decision, 'waiting');
});

test('host: a file read through the bus returns structured data', async () => {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const home = tempHome();
  const { registered } = registerHostTools(registry, caps, { workspaceDir: home });
  if (!registered.some((r) => r.name === 'fs_read')) return;

  const file = path.join(home, 'hej.txt');
  fs.writeFileSync(file, 'innehåll');
  try {
    const out = await runTool(
      { tool: 'fs_read', input: { path: file } },
      { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 5000 },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(typeof out.data, 'object');
    assert.equal(typeof out.data.ok, 'boolean');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('host: an owner allowlist narrows what is exposed', async () => {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const { registered, skipped } = registerHostTools(registry, caps, { allow: ['fs.read'] });
  assert.deepEqual(registered.map((r) => r.name), ['fs_read'], 'the allowlist accepts the V1 spelling');
  assert.ok(skipped.some((s) => s.reason === 'not in the owner allowlist'));
});

test('host: an adapted tool that reports "unsupported" fails with a class', async () => {
  const registry = new ToolRegistry();
  registry.define(adaptV1Tool({
    name: 'fake_control',
    desc: 'pretends to be unsupported',
    risk: 'exec',
    raw: { x: 'number: x' },
    run: async () => ({ ok: false, unsupported: true, result: 'no interactive desktop' }),
  }, { lane: 'desktop' }));
  await assert.rejects(
    () => runTool({ tool: 'fake_control', input: { x: 1 } }, { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 3000 }),
    (err) => err.cls === 'DEPENDENCY_MISSING',
  );
});

test('host: an adapted tool that throws is classified, never a success', async () => {
  const registry = new ToolRegistry();
  registry.define(adaptV1Tool({
    name: 'fake_throws',
    desc: 'testar att kasta',
    risk: 'read',
    raw: {},
    run: async () => { throw Object.assign(new Error('fönstret finns inte'), { cls: 'WINDOW_NOT_FOUND' }); },
  }, { lane: 'desktop' }));
  await assert.rejects(
    () => runTool({ tool: 'fake_throws', input: {} }, { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 3000 }),
    (err) => err.cls === 'WINDOW_NOT_FOUND',
  );
});

test('host: risk maps to the tiers the runner enforces', () => {
  assert.equal(RISK_TO_TIER.read, 'read');
  assert.equal(RISK_TO_TIER.write, 'write');
  assert.equal(RISK_TO_TIER.exec, 'process');
  assert.equal(RISK_TO_TIER.net, 'external');
  assert.equal(RISK_TO_TIER.browser, 'browser');
  assert.equal(RISK_TO_TIER.unknown, undefined);
});

test('host: V1 param strings become a permissive zod schema, not a guessing one', () => {
  const schema = zodFromV1Params({ x: 'number: x', name: 'string: n', flag: 'boolean: f', miss: undefined });
  assert.equal(schema.safeParse({ x: 1, name: 'a', flag: true }).success, true);
  assert.equal(schema.safeParse({ x: 'inte en siffra' }).success, false);
  assert.equal(schema.safeParse({}).success, true, 'everything optional: V1 defaults stay in charge');
});

test('host: browser binary detection never reports a binary it did not find', async () => {
  const fake = await browserBinary({ platform: 'linux', env: { HOME: '/nonexistent-home' } });
  assert.equal(fake, null);
  // an explicit override that does not exist is also refused
  const bogus = await browserBinary({ platform: 'linux', env: { MAJIN_V4_BROWSER: '/no/such/chrome' } });
  assert.equal(bogus, null);
});

test('host: lane export names come from one table, so a V1 rename is one line', () => {
  assert.equal(LANE_EXPORTS.desktop, 'winControlTools');
  assert.equal(LANE_EXPORTS.files, 'fileTools');
  assert.equal(LANE_EXPORTS.jobs, 'jobTools');
  assert.equal(LANE_EXPORTS.web, 'webTools');
  assert.ok(Object.keys(LANE_EXPORTS).length >= 8);
});

test('host: every discovered lane is a real module with a real export', async () => {
  const caps = await hostCapabilities();
  for (const [lane, cap] of Object.entries(caps.lanes)) {
    if (cap.available) {
      assert.ok(cap.module, `${lane} claims available without a module`);
      assert.ok(Array.isArray(cap.module[cap.exportName]), `${lane} has no exported tool array`);
      assert.ok(cap.tools.length > 0, `${lane} claims available with zero tools`);
    } else {
      assert.ok(cap.reason, `${lane} is unavailable but gives no reason`);
    }
  }
});

/* ------------------------------------------------- end to end through the host -- */

test('host: capabilities endpoint is authenticated and reports the owner-mode state', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const off = await startTestServer();
  try {
    const anon = await fetch(`${off.base}/api/capabilities`);
    assert.equal(anon.status, 401, 'capabilities are not public');

    const { cookie } = await off.pair();
    const res = await fetch(`${off.base}/api/capabilities`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tools.enabled, false, 'nothing is granted by default');
    assert.deepEqual(body.tools.registered, []);
    assert.equal(body.ownerMode.enabled, false);
    assert.ok(['files', 'shell', 'web'].every((l) => body.ownerMode.grantable.includes(l)));
    assert.equal(typeof body.host.lanes.desktop.available, 'boolean');
  } finally {
    await off.close();
  }
});

test('host: a grant registers the files lane and keeps destructive tools held', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const on = await startTestServer({ home });
  try {
    const { cookie } = await on.pair();
    const grant = await fetch(`${on.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: on.base },
      body: JSON.stringify({ action: 'grant', lanes: ['files'], folders: [home] }),
    });
    assert.equal(grant.status, 200);

    const res = await fetch(`${on.base}/api/capabilities`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(body.tools.enabled, true);
    const names = body.tools.registered.map((t) => t.name);
    assert.ok(names.includes('fs_read'), `expected fs_read, got ${names.join(',')}`);
    const del = body.tools.registered.find((t) => t.name === 'fs_delete');
    assert.equal(del.tier, 'process', 'a delete stays a held operation');
  } finally {
    await on.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('host: the install-time allowlist limits what a grant can expose', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home, env: { MAJIN_V4_HOST_TOOL_ALLOW: 'fs.read' } });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['files', 'shell'], folders: [home] }),
    });
    const body = await (await fetch(`${s.base}/api/capabilities`, { headers: { cookie } })).json();
    assert.deepEqual(body.tools.registered.map((t) => t.name), ['fs_read']);
    assert.ok(!body.tools.registered.some((t) => t.name.startsWith('exec')));
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('host: browser tools are withheld when no browser runtime exists, and named as skipped', () => {
  const caps = {
    platform: 'win32',
    browserRuntime: { available: false, reason: 'synthetic: no browser' },
    lanes: {
      web: { available: true, exportName: 'webTools', module: { webTools: [
        { name: 'browser.open', desc: 'open', risk: 'browser', raw: {}, run: async () => ({ ok: true }) },
        { name: 'browser.click', desc: 'click', risk: 'browser', raw: {}, run: async () => ({ ok: true }) },
        { name: 'browser.fill', desc: 'fill', risk: 'browser', raw: {}, run: async () => ({ ok: true }) },
        { name: 'browser.read', desc: 'read', risk: 'browser', raw: {}, run: async () => ({ ok: true }) },
        { name: 'web.search', desc: 'search', risk: 'net', raw: {}, run: async () => ({ ok: true }) },
      ] } },
    },
  };
  const registry = new ToolRegistry();
  const { registered, skipped } = registerHostTools(registry, caps);
  assert.ok(!registered.some((r) => r.name.startsWith('browser')), 'no browser tool without a runtime');
  assert.ok(registered.some((r) => r.name === 'web_search'), 'the rest of the lane still works');
  const why = skipped.filter((s) => s.tool && s.tool.startsWith('browser.'));
  assert.equal(why.length, 4, `expected four browser tools skipped, got ${why.length}`);
  assert.ok(why.every((s) => /browser runtime/.test(s.reason)));
});

test('host: the whole working tool set is substantial and every entry has a tier', async () => {
  const caps = await hostCapabilities();
  const registry = new ToolRegistry();
  const { registered } = registerHostTools(registry, caps);
  assert.ok(registered.length >= 25, `only ${registered.length} tools discovered`);
  const byTier = {};
  for (const r of registered) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
  assert.ok(byTier.read > 0, 'reads exist');
  assert.ok((byTier.process || 0) > 0, 'held operations exist and are not miscategorised as reads');
  // every registered name round-trips to a V1 name
  for (const r of registered) assert.ok(r.sourceName, `${r.name} lost its V1 origin`);
});

test('host: a structured V1 failure becomes a classified failure, not a schema break', async () => {
  const registry = new ToolRegistry();
  registry.define(adaptV1Tool({
    name: 'web.search',
    desc: 'pretends no engine answered',
    risk: 'net',
    raw: { query: 'string: q' },
    run: async () => ({ ok: false, error: { code: 'search_failed', message: 'no search engine answered (duckduckgo: fetch failed)', hint: 'check internet' } }),
  }, { lane: 'web' }));
  await assert.rejects(
    () => runTool({ tool: 'web_search', input: { query: 'x' } }, { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 3000 }),
    (err) => err.cls === 'NETWORK_FAILURE' && /no search engine/.test(err.message),
    'an honest failure must not be reported as INVALID_TOOL_OUTPUT',
  );
});

test('host: a protected-path refusal is classified as a permission error', async () => {
  const registry = new ToolRegistry();
  registry.define(adaptV1Tool({
    name: 'fs.delete',
    desc: 'pretends the path is protected',
    risk: 'exec',
    raw: { path: 'string: p' },
    run: async () => ({ ok: false, error: { code: 'protected', message: 'refusing to touch C:\\ — key directory' } }),
  }, { lane: 'files' }));
  await assert.rejects(
    () => runTool({ tool: 'fs_delete', input: { path: 'C:\\' } }, { registry, approvals: { check: () => ({ decision: 'allow' }) }, timeoutMs: 3000 }),
    (err) => err.cls === 'PERMISSION_DENIED',
  );
});

test('host: classifyV1Error maps the V1 vocabulary onto the kernel classes', async () => {
  const { classifyV1Error } = await import('../../src/v4/tools/host.js');
  assert.equal(classifyV1Error({ code: 'protected' }), 'PERMISSION_DENIED');
  assert.equal(classifyV1Error({ code: 'bad_args', message: 'path missing' }), 'DEPENDENCY_MISSING');
  assert.equal(classifyV1Error({ message: 'fetch failed' }), 'NETWORK_FAILURE');
  assert.equal(classifyV1Error({ message: 'timed out' }), 'TIMEOUT');
  assert.equal(classifyV1Error({ code: 'weird_unknown' }), 'UNKNOWN');
  assert.equal(classifyV1Error(null), 'UNKNOWN');
});

test('cli: v4:tools reports lanes and refuses to claim a tool it cannot probe', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const out = spawnSync(process.execPath, [path.join(root, 'scripts/v4/tools.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MAJIN_HOME: tempHome() },
    timeout: 60_000,
  });
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(typeof report.hostToolsEnabled, 'boolean');
  assert.ok(report.registry.total >= 5);
  assert.ok(Array.isArray(report.tools));
  for (const t of report.tools) assert.ok(['read', 'write', 'process', 'browser', 'external'].includes(t.tier));
  // anything not offered must carry a reason
  for (const s of report.skipped) assert.ok(s.reason && s.reason.length > 3);
});
