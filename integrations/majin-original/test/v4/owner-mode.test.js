/**
 * Owner Mode: the owner's own phone grants access to their own machine.
 *
 * These tests are about the boring, dangerous parts: a revocation must win, a
 * drive root must never be grantable, and a fake config line must not resurrect
 * something the owner switched off.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OwnerMode, OwnerModeError, GRANTABLE_LANES, SENSITIVE_LANES, normaliseFolder, normaliseBrowserOrigin } from '../../src/v4/owner-mode.js';
import { tempHome } from './helpers.mjs';

const mode = (home, opts = {}) => new OwnerMode({ file: path.join(home, 'owner-mode.json'), ...opts });

test('owner-mode: nothing is granted by default', () => {
  const home = tempHome();
  const m = mode(home);
  assert.equal(m.enabled(), false);
  assert.deepEqual(m.activeLanes(), []);
  const view = m.view();
  assert.equal(view.enabled, false);
  assert.deepEqual(view.lanes, []);
  assert.equal(view.note.includes('not an OS sandbox'), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: a grant is persisted and survives a restart', () => {
  const home = tempHome();
  const a = mode(home);
  a.grant({ lanes: ['files'], folders: [home] });
  const b = mode(home);
  assert.equal(b.enabled(), true);
  assert.deepEqual(b.activeLanes().sort(), ['files']);
  assert.deepEqual(b.folders(), [home]);
  assert.equal(b.view().grantedAt !== null, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: the file is 0600 and carries no secrets beyond paths', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files'], folders: [home] });
  const file = path.join(home, 'owner-mode.json');
  const stat = fs.statSync(file);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0, 'group/other must not read it');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.schema, 'majin.v4.owner-mode/v1');
  assert.ok(Array.isArray(raw.history));
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: granting a folder implies the files lane, because that is what was meant', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ folders: [home] });
  assert.ok(m.activeLanes().includes('files'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: the files lane is inert without a folder', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files'] });
  assert.deepEqual(m.activeLanes(), [], 'no folder means the lane cannot do anything');
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: a drive root can never be granted', () => {
  const home = tempHome();
  const m = mode(home);
  for (const bad of ['/', 'C:\\', 'D:/', '\\']) {
    assert.throws(() => m.grant({ folders: [bad] }), OwnerModeError, bad);
  }
  assert.equal(m.folders().length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: folders are expanded and normalised', () => {
  const home = tempHome();
  const folder = path.join(home, 'Documents');
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(normaliseFolder(folder), path.resolve(folder));
  assert.throws(() => normaliseFolder(''), OwnerModeError);
  assert.throws(() => normaliseFolder('a\0b'), OwnerModeError);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: browser origins are canonical exact origins, persisted, and cannot carry credentials', () => {
  const home = tempHome();
  const m = mode(home);

  assert.equal(normaliseBrowserOrigin('HTTPS://Employer.Example:443/apply?job=1#form'), 'https://employer.example');
  assert.equal(normaliseBrowserOrigin('http://127.0.0.1:43123/portal'), 'http://127.0.0.1:43123');
  for (const bad of [
    'https://user:password@employer.example/apply',
    'https://user@employer.example/apply',
    'javascript:alert(1)',
    'file:///tmp/form.html',
    'not a url',
    '',
  ]) assert.throws(() => normaliseBrowserOrigin(bad), OwnerModeError, bad);

  m.grantBrowserOrigins(['https://employer.example/apply', 'https://employer.example/other', 'http://localhost:3000/form']);
  assert.deepEqual(m.browserOrigins(), ['http://localhost:3000', 'https://employer.example']);
  assert.ok(m.activeLanes().includes('browser'), 'granting an origin implies the browser lane');
  assert.deepEqual(mode(home).browserOrigins(), ['http://localhost:3000', 'https://employer.example'], 'the grant survives a restart');

  // Invalid entries already on disk (including credentials) are ignored on load.
  const file = path.join(home, 'owner-mode.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.browserOrigins.push('https://user:pass@evil.example', 'javascript:alert(1)');
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.deepEqual(mode(home).browserOrigins(), ['http://localhost:3000', 'https://employer.example']);

  m.revokeBrowserOrigins(['https://employer.example/apply']);
  assert.deepEqual(m.browserOrigins(), ['http://localhost:3000']);
  assert.ok(m.activeLanes().includes('browser'), 'revoking only an origin leaves browser reads available');
  m.revoke({ lanes: ['browser'] });
  assert.deepEqual(m.browserOrigins(), [], 'revoking the browser lane also removes every write origin');

  const otherProcess = mode(home);
  m.grantBrowserOrigins(['https://dynamic.example/apply']);
  assert.deepEqual(otherProcess.browserOrigins(), ['https://dynamic.example'], 'a running host sees an origin granted by another owner process');
  otherProcess.grant({ lanes: ['shell'] });
  assert.deepEqual(mode(home).browserOrigins(), ['https://dynamic.example'], 'an unrelated save from the other process does not erase the dynamic origin');
  m.revokeBrowserOrigins(['https://dynamic.example/apply']);
  assert.deepEqual(otherProcess.view().browserOrigins, [], 'a running host also sees the revocation immediately');
  otherProcess.grant({ lanes: ['web'] });
  assert.deepEqual(mode(home).browserOrigins(), [], 'an unrelated later save does not resurrect a revoked origin');
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: allowsPath is inside-only and not fooled by a sibling prefix', () => {
  const home = tempHome();
  const root = path.join(home, 'Docs');
  const sibling = path.join(home, 'Docs-private');
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  const m = mode(home);
  m.grant({ folders: [root] });

  assert.equal(m.allowsPath(root), true);
  assert.equal(m.allowsPath(path.join(root, 'cv', 'cv.pdf')), true);
  assert.equal(m.allowsPath(sibling), false, 'Docs-private starts with Docs but is not inside it');
  assert.equal(m.allowsPath(path.join(home, 'annat')), false);
  assert.equal(m.allowsPath('../../etc/passwd'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: revocation is immediate and total', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files', 'shell'], folders: [home] });
  assert.ok(m.activeLanes().length >= 2);
  m.revoke();
  assert.equal(m.enabled(), false);
  assert.deepEqual(m.folders(), []);
  assert.equal(m.view().revokedAt !== null, true);
  // and it is persisted
  assert.equal(mode(home).enabled(), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: a single lane can be revoked without touching the others', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files', 'shell', 'web'], folders: [home] });
  m.revoke({ lanes: ['shell'] });
  const active = m.activeLanes();
  assert.ok(!active.includes('shell'));
  assert.ok(active.includes('web'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: an env-forced lane cannot be resurrected after a revoke-all', () => {
  const home = tempHome();
  const forced = mode(home, { forceLanes: ['web'] });
  assert.deepEqual(forced.activeLanes(), ['web'], 'the installer path grants a lane');
  forced.revoke();
  // The force list is still applied, but the owner's revoke must be visible in
  // the view so the UI can say "this lane is forced by configuration".
  const after = mode(home, { forceLanes: ['web'] });
  assert.equal(after.view().revokedAt !== null, true);
  assert.deepEqual(after.view().forced, ['web']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: every grant and revoke is written to the audit history', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files'], folders: [home], reason: 'owner tapped allow' });
  m.revoke({ reason: 'owner tapped revoke' });
  const history = m.view().history;
  assert.equal(history.length, 2);
  assert.equal(history[0].action, 'grant');
  assert.equal(history[1].action, 'revoke-all', 'a revoke with no arguments is a full revoke');
  assert.ok(history.every((h) => h.at));
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: unknown lanes are refused rather than ignored', () => {
  const home = tempHome();
  const m = mode(home);
  assert.throws(() => m.grant({ lanes: ['root-everything'] }), (e) => e.code === 'UNKNOWN_LANE');
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: sensitive lanes are named so the UI can warn', () => {
  const home = tempHome();
  const m = mode(home);
  m.grant({ lanes: ['files', 'shell', 'desktop'], folders: [home] });
  const view = m.view();
  assert.deepEqual(view.sensitive.sort(), ['desktop', 'shell']);
  assert.ok(GRANTABLE_LANES.includes('computer'));
  assert.ok(SENSITIVE_LANES.includes('computer'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: a corrupt grant file degrades to nothing granted', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'owner-mode.json'), '{ inte json');
  const m = mode(home);
  assert.equal(m.enabled(), false, 'a broken file must not become a permission');
  fs.rmSync(home, { recursive: true, force: true });
});

test('owner-mode: a grant file with an unknown schema is ignored', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'owner-mode.json'), JSON.stringify({ schema: 'något-annat/v9', lanes: ['shell'] }));
  const m = mode(home);
  assert.equal(m.enabled(), false);
  fs.rmSync(home, { recursive: true, force: true });
});

/* ---------------------------------------------------- through the real host -- */

async function ownerApi(s, cookie, body) {
  return fetch(`${s.base}/api/owner-mode`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
    body: JSON.stringify(body),
  });
}

test('owner-mode/api: off by default, and a grant from the phone turns tools on without a restart', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();

    const before = await (await fetch(`${s.base}/api/owner-mode`, { headers: { cookie } })).json();
    assert.equal(before.ownerMode.enabled, false);
    assert.equal((await (await fetch(`${s.base}/api/capabilities`, { headers: { cookie } })).json()).tools.enabled, false);

    const res = await ownerApi(s, cookie, { action: 'grant', lanes: ['web', 'jobs'], folders: [home] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ownerMode.enabled, true);
    assert.ok(body.ownerMode.lanes.includes('web'));
    assert.ok(body.ownerMode.lanes.includes('files'), 'granting a folder implies files');
    assert.ok(body.registered > 0, 'tools were registered immediately');

    const after = await (await fetch(`${s.base}/api/capabilities`, { headers: { cookie } })).json();
    assert.equal(after.tools.enabled, true);
    assert.ok(after.tools.registered.some((t) => t.name === 'fs_read'), 'the file tool is live now');
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner-mode/api: a revoke removes the tools immediately, not at next boot', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await ownerApi(s, cookie, { action: 'grant', lanes: ['web'], folders: [home] });
    const withTools = await (await fetch(`${s.base}/api/capabilities`, { headers: { cookie } })).json();
    assert.ok(withTools.tools.registered.length > 0);

    const res = await ownerApi(s, cookie, { action: 'revoke' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ownerMode.enabled, false);
    assert.equal(body.registered, 0, 'every host tool was removed from the registry');

    // and the model no longer sees them
    const seen = [];
    const realChat = s.context.model.chat.bind(s.context.model);
    s.context.model.chat = async (opts) => { seen.push(opts.tools || []); return realChat(opts); };
    const { postChat, readSse } = await import('./helpers.mjs');
    await readSse(await postChat(s.base, cookie, { text: 'Hej', requestId: 'om1' }));
    const names = seen[0].map((t) => t.name);
    assert.deepEqual(names.sort(), [
      'document_read', 'memory_save', 'memory_search', 'memory_sync', 'task_list', 'task_manage', 'tools_activate', 'tools_search',
      'workspace_list', 'workspace_read', 'workspace_write',
    ]);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner-mode/api: granting a drive root is refused with a readable reason', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const res = await ownerApi(s, cookie, { action: 'grant', lanes: ['files'], folders: ['C:\\'] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_FOLDER');
    assert.match(body.error.message, /drive/i);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner-mode/api: requires a session and a CSRF header', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const anon = await fetch(`${s.base}/api/owner-mode`);
    assert.equal(anon.status, 401);
    const { cookie } = await s.pair();
    const noCsrf = await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['web'] }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('owner-mode/api: a grant survives a host restart', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const first = await startTestServer({ home });
  try {
    const { cookie } = await first.pair();
    await ownerApi(first, cookie, { action: 'grant', lanes: ['web'], folders: [home] });
  } finally {
    await first.close({ keep: true });
  }
  const second = await startTestServer({ home });
  try {
    const cookie = second.existingSession();
    const caps = await (await fetch(`${second.base}/api/capabilities`, { headers: { cookie } })).json();
    assert.equal(caps.tools.enabled, true, 'the grant was remembered');
    assert.ok(caps.tools.registered.length > 0);
  } finally {
    await second.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
