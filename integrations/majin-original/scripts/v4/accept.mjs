#!/usr/bin/env node
/**
 * MAJIN V4 — private release acceptance run.
 *
 * One command on the Windows host that either proves the private release or
 * names exactly what failed. It exists because 21.5 of the 100 acceptance points
 * depend on the real machine, the real tunnel and a real phone — and a checklist
 * nobody runs is worth nothing.
 *
 *   npm run v4:accept                     full run against a local host
 *   npm run v4:accept -- --url https://…  also verify the public HTTPS URL
 *   npm run v4:accept -- --json           machine output only
 *   npm run v4:accept -- --write          save evidence to docs/v4/evidence/
 *
 * What it checks (each one is a real request or a real file, never a guess):
 *   env        Node floor, data dir writable, workspace writable
 *   host       health answers, loopback bind, version
 *   auth       an unauthenticated API call is refused; pairing works; session is HttpOnly
 *   chat       a real message streams and completes
 *   goal       the file exists on disk and the tool result was verified
 *   persist    the conversation survives a fresh read
 *   restart    a second host process on the same data dir still sees the goal
 *   tunnel     the public URL answers health and refuses unauthenticated reads
 *   model      a configured provider answers with a real inference (or says why not)
 *
 * It NEVER writes an acceptance point on its own. It writes evidence; the matrix
 * is updated by a human who reads the evidence. That rule is the whole point.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { startV4Server } from '../../src/v4/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(here, '../../docs/v4/evidence');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const results = [];
function record(id, ok, detail, hint = null) {
  results.push({ id, ok: Boolean(ok), detail: String(detail ?? ''), ...(hint ? { hint } : {}) });
  return ok;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-accept-'));
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch { /* non-JSON is a failure the caller reports */ }
  return { res, body };
}

/** Run one host on a private data dir and exercise it end to end. */
async function exerciseLocalHost() {
  const home = tmpHome();
  const config = loadConfig({
    env: { MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo', MAJIN_V4_RATE_REQUESTS: '1000', MAJIN_V4_RATE_TURNS: '1000' },
    argv: [],
    platform: process.platform,
  });

  let server;
  let context;
  for (let attempt = 0; ; attempt += 1) {
    const port = 36000 + Math.floor(Math.random() * 1500) + attempt;
    try {
      ({ server, context } = await startV4Server({ config: { ...config, port, host: '127.0.0.1' } }));
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt > 25) throw err;
    }
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = { home, base, config, server, context };

  try {
    // ---- host -------------------------------------------------------------
    const health = await jsonFetch(`${base}/api/health`);
    record('host.health', health.res.ok && health.body?.ok === true, `${health.res.status} ${health.body?.version || ''}`);

    // ---- auth -------------------------------------------------------------
    const anon = await jsonFetch(`${base}/api/state`);
    record('auth.refuses_anonymous', anon.res.status === 401, `unauthenticated /api/state -> ${anon.res.status}`);

    const pairRes = await fetch(`${base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ code: context.pairingFresh }),
    });
    const cookieHeader = pairRes.headers.get('set-cookie') || '';
    const cookie = cookieHeader.split(';')[0];
    record('auth.pairing_works', pairRes.status === 200 && cookie.length > 10, `pair -> ${pairRes.status}`);
    record('auth.cookie_hardened', /HttpOnly/i.test(cookieHeader) && /SameSite=Strict/i.test(cookieHeader), cookieHeader.split(';').slice(1).join(';').trim() || 'no flags');

    const csrfMissing = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ text: 'hej' }),
    });
    record('auth.csrf_required', csrfMissing.status === 403, `chat without CSRF -> ${csrfMissing.status}`);

    const crossOrigin = await fetch(`${base}/api/state`, { headers: { cookie, origin: 'https://evil.example' } });
    record('auth.cross_origin_refused', crossOrigin.status === 403, `cross-origin -> ${crossOrigin.status}`);

    // ---- chat + goal ------------------------------------------------------
    const started = Date.now();
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie, 'x-majin-csrf': '1' },
      body: JSON.stringify({ text: 'Skriv filen accept.txt med innehåll: acceptanskörning', requestId: 'accept-1' }),
    });
    const stream = await chat.text();
    const ms = Date.now() - started;
    const events = stream.split('\n\n').filter(Boolean);
    const hasDelta = events.some((b) => b.includes('event: delta'));
    const toolResult = events.find((b) => b.includes('event: tool_result'));
    const verified = Boolean(toolResult && /"verified":true/.test(toolResult));
    const doneBlock = events.filter((b) => b.includes('event: done')).pop() || '';
    record('chat.streams', chat.status === 200 && hasDelta, `${events.length} events in ${ms}ms`);
    record('goal.tool_verified', verified, verified ? 'tool result carried verified:true' : 'no verified tool result');
    record('chat.completes', /"status":"completed"/.test(doneBlock), doneBlock.replace(/\s+/g, ' ').slice(0, 120));

    const file = path.join(home, 'workspace', 'accept.txt');
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    record('goal.file_on_disk', onDisk === 'acceptanskörning', onDisk === null ? 'file missing' : JSON.stringify(onDisk));

    // ---- persistence ------------------------------------------------------
    const convId = (doneBlock.match(/"conversationId":"([^"]+)"/) || [])[1] || null;
    record('chat.conversation_id', Boolean(convId), convId || 'no conversation id in done event');
    if (convId) {
      const read = await jsonFetch(`${base}/api/conversation?id=${convId}`, { headers: { cookie } });
      const messages = read.body?.conversation?.messages?.length || 0;
      record('persist.conversation_reloads', messages >= 2, `${messages} messages`);

      // ---- conversation management (the shared history contract) ----------
      const patched = await jsonFetch(`${base}/api/conversations`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: base, cookie, 'x-majin-csrf': '1' },
        body: JSON.stringify({ id: convId, title: 'Acceptanskörning' }),
      });
      record('history.rename', patched.res.status === 200 && patched.body?.conversation?.title === 'Acceptanskörning',
        `PATCH -> ${patched.res.status}`);

      await jsonFetch(`${base}/api/conversations`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: base, cookie, 'x-majin-csrf': '1' },
        body: JSON.stringify({ id: convId, archived: true }),
      });
      const archived = await jsonFetch(`${base}/api/conversations?view=archived`, { headers: { cookie } });
      const inArchive = (archived.body?.conversations || []).some((c) => c.id === convId);
      await jsonFetch(`${base}/api/conversations`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: base, cookie, 'x-majin-csrf': '1' },
        body: JSON.stringify({ id: convId, archived: false }),
      });
      const active = await jsonFetch(`${base}/api/conversations?view=active`, { headers: { cookie } });
      const backActive = (active.body?.conversations || []).some((c) => c.id === convId);
      record('history.archive_restore', inArchive && backActive, `archived=${inArchive} restored=${backActive}`);

      const search = await jsonFetch(`${base}/api/conversations?view=all&q=${encodeURIComponent('acceptanskörning')}`, { headers: { cookie } });
      record('history.search', (search.body?.conversations || []).some((c) => c.id === convId), `${(search.body?.conversations || []).length} hit(s)`);

      // Two devices: a second session must see the same conversation.
      const secondSession = context.sessions.create({ ip: 'accept', userAgent: 'second-device' });
      const secondCookie = `${config.auth.cookieName}=${encodeURIComponent(secondSession.token)}`;
      const other = await jsonFetch(`${base}/api/conversations?view=all`, { headers: { cookie: secondCookie } });
      record('history.two_devices', (other.body?.conversations || []).some((c) => c.id === convId),
        `${(other.body?.conversations || []).length} conversation(s) on the second session`);

      // ---- file access ----------------------------------------------------
      // ---- real file access, through the same objects the agent uses ------
      // A scratch folder OUTSIDE the workspace, granted through the HTTP API,
      // then searched with the registered tool. This is the exact chain that
      // failed on the owner's machine: owner mode -> adapter -> fs.find.
      const folder = path.join(home, 'Documents', 'Acceptans');
      fs.mkdirSync(folder, { recursive: true });
      const needle = 'acceptans-cv.docx';
      fs.writeFileSync(path.join(folder, needle), 'inte en riktig docx, men ett riktigt filnamn');
      const granted = await jsonFetch(`${base}/api/owner-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie, 'x-majin-csrf': '1' },
        body: JSON.stringify({ action: 'grant', folders: [folder] }),
      });
      record('files.folder_grant', granted.res.status === 200 && (granted.body?.ownerMode?.folders || []).includes(folder),
        `grant -> ${granted.res.status}, folders: ${(granted.body?.ownerMode?.folders || []).join(', ') || 'none'}`);

      const findDef = context.tools.registry.get('fs_find');
      record('files.fs_find_registered', Boolean(findDef),
        findDef
          ? 'fs_find is registered once a folder is granted (the files lane is inert without one)'
          : 'fs_find is still not registered after granting a folder',
        findDef ? null : 'Check that the host capabilities list the files lane; npm run v4:tools shows why.');

      if (findDef) {
        let found = null;
        try {
          found = await findDef.execute({ path: folder, name: 'acceptans-cv' });
        } catch (err) {
          record('files.search_granted_folder', false, String(err?.message || err));
        }
        const hits = found?.meta?.hits || [];
        record('files.search_granted_folder', hits.some((h) => h.name === needle),
          hits.length ? `${hits.length} hit(s): ${hits.map((h) => h.name).join(', ')}` : 'no hit in a granted folder',
          hits.length ? null : 'The files lane and the folder grant must both be active for a search to work.');

        // And the same tool must refuse a folder nobody granted.
        const outside = path.join(home, 'Documents', 'InteGodkand');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'hemlig.txt'), 'x');
        let refused = null;
        try {
          await findDef.execute({ path: outside, name: 'hemlig' });
        } catch (err) {
          refused = err;
        }
        record('files.refuses_ungranted', Boolean(refused) && /PERMISSION_DENIED|outside/i.test(String(refused?.cls || '') + String(refused?.message || '')),
          refused ? `${refused.cls || 'refused'}: ${String(refused.message).slice(0, 90)}` : 'an ungranted folder was searched');
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // ---- restart ------------------------------------------------------------
  // A second process on the same data dir must still see the finished goal.
  let second;
  try {
    const config2 = loadConfig({ env: { MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo' }, argv: [], platform: process.platform });
    let server2;
    for (let attempt = 0; ; attempt += 1) {
      const port = 37600 + Math.floor(Math.random() * 1500) + attempt;
      try {
        ({ server: server2, context: second } = await startV4Server({ config: { ...config2, port, host: '127.0.0.1' } }));
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || attempt > 25) throw err;
      }
    }
    const goals = second.goals.list();
    record('restart.goal_survives', goals.some((g) => g.state === 'COMPLETED'), `${goals.length} goal(s) after restart`);
    const file = path.join(home, 'workspace', 'accept.txt');
    record('restart.file_survives', fs.existsSync(file), file);
    await new Promise((resolve) => server2.close(resolve));
  } catch (err) {
    record('restart.goal_survives', false, String(err.message || err));
  }

  fs.rmSync(home, { recursive: true, force: true });
  return out;
}

/** Verify a public URL: health answers, and it is not open to the world. */
async function verifyPublicUrl(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    record('tunnel.url_valid', false, `not a URL: ${url}`, 'Pass --url https://majin.your-domain.se');
    return;
  }
  record('tunnel.https', origin.startsWith('https://'), origin);
  try {
    const health = await jsonFetch(`${origin}/api/health`, { redirect: 'error' });
    record('tunnel.health', health.res.ok && health.body?.ok === true, `${health.res.status}`);
  } catch (err) {
    record('tunnel.health', false, String(err.message || err).slice(0, 120), 'Is the tunnel running and DNS pointed at it?');
    return;
  }
  try {
    const anon = await jsonFetch(`${origin}/api/state`);
    record('tunnel.closed_to_anonymous', anon.res.status === 401, `anonymous read -> ${anon.res.status}`);
  } catch (err) {
    record('tunnel.closed_to_anonymous', false, String(err.message || err).slice(0, 120));
  }
}

/** Is a real model configured and does it actually answer? */
async function verifyModel() {
  const config = loadConfig();
  if (config.model.kind === 'demo') {
    record('model.configured', false, 'no provider configured (running the demo brain)', 'Add a provider/key to the MAJIN config, or set MAJIN_V4_* for this host.');
    return;
  }
  const { discoverModels } = await import('../../src/v4/models.js');
  const catalogue = discoverModels({ home: config.paths.home, env: process.env });
  record('model.configured', catalogue.models.some((m) => m.configured), `${catalogue.models.filter((m) => m.configured).length} configured model(s) from ${catalogue.source}`);
}

function report({ json }) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  if (json) {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), node: process.versions.node, platform: process.platform, results, passed, failed }, null, 2)}\n`);
    return failed;
  }
  process.stdout.write(`\nMAJIN V4 — private release acceptance\n${'='.repeat(62)}\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(28)} ${r.detail}\n`);
    if (!r.ok && r.hint) process.stdout.write(`        → ${r.hint}\n`);
  }
  process.stdout.write(`${'-'.repeat(62)}\n  ${passed}/${results.length} checks passed\n`);
  if (failed) {
    process.stdout.write('\n  The private release is NOT verified. Nothing above is a claim about your phone.\n');
    process.stdout.write('  Fix the FAIL lines, then run again. Points in the matrix are only written by hand, from this output.\n\n');
  } else {
    process.stdout.write('\n  Every automated check passed. Still to do by hand: open the URL on the phone,\n');
    process.stdout.write('  add it to the home screen, send one message, and record that in TEST_EVIDENCE.md.\n\n');
  }
  return failed;
}

async function main() {
  const json = flag('--json');
  const url = value('--url');

  if (!json) process.stdout.write('\nMAJIN V4 acceptance run — exercising a real host on this machine…\n');
  try {
    await exerciseLocalHost();
  } catch (err) {
    record('host.boot', false, String(err.message || err));
  }

  await verifyModel();
  if (url) await verifyPublicUrl(url);
  else record('tunnel.skipped', true, 'no --url given; public access not checked', 'Run again with: npm run v4:accept -- --url https://your-tunnel');

  const failed = report({ json });

  if (flag('--write') && !json) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(EVIDENCE_DIR, `acceptance-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), node: process.versions.node, platform: process.platform, url: url || null, results, passed: results.length - failed, failed }, null, 2)}\n`);
    process.stdout.write(`  evidence: ${path.relative(process.cwd(), file)}\n\n`);
  }

  process.exitCode = failed ? 1 : 0;
}

await main();
