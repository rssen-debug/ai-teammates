/**
 * Uploads and previews: the two new attack surfaces.
 *
 * These tests attack the feature rather than use it, because that is what the
 * feature is for: the phone writes bytes to the owner's machine, and a file MAJIN
 * wrote is rendered as HTML in the owner's authenticated browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  INLINE_TYPES, MAX_UPLOAD_BYTES, UploadError, UploadStore, UPLOAD_TYPES,
  safeUploadName, serveHeadersFor, sniffType, typeForName,
} from '../../src/v4/uploads.js';
import { startTestServer, tempHome } from './helpers.mjs';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function store(home) {
  return new UploadStore({ dir: path.join(home, 'uploads') });
}

test('upload: names are leaves; traversal and device names are refused', () => {
  const bad = ['../x.png', '..\\x.png', '/etc/passwd', 'a/b.png', '.hidden', 'CON', 'nul.png', 'a\0b.png', 'n:b.png', 'x.'];
  for (const name of bad) assert.throws(() => safeUploadName(name), UploadError, name);
  assert.equal(safeUploadName('cv.pdf'), 'cv.pdf');
  assert.equal(safeUploadName('  foto 1.png  '), 'foto 1.png');
});

test('upload: executable types are not accepted at all', () => {
  const h = tempHome();
  const s = store(h);
  for (const type of ['text/html', 'image/svg+xml', 'text/javascript', 'application/x-msdownload']) {
    assert.throws(
      () => s.save({ name: 'x.html', type, data: Buffer.from('<script>x</script>').toString('base64') }),
      (e) => e.code === 'UNSUPPORTED_TYPE',
      type,
    );
  }
  assert.ok(!('text/html' in UPLOAD_TYPES));
  assert.ok(!('image/svg+xml' in UPLOAD_TYPES));
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: a real PNG is stored with its detected type and a hash', () => {
  const h = tempHome();
  const s = store(h);
  const out = s.save({ name: 'bild.png', type: 'image/png', data: PNG_1PX.toString('base64') });
  assert.equal(out.name, 'bild.png');
  assert.equal(out.type, 'image/png');
  assert.equal(out.kind, 'image');
  assert.equal(out.inline, true);
  assert.equal(out.bytes, PNG_1PX.length);
  assert.equal(out.sha256.length, 64);
  assert.deepEqual(fs.readFileSync(path.join(h, 'uploads', 'bild.png')), PNG_1PX);
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: a payload that lies about its type is refused', () => {
  const h = tempHome();
  const s = store(h);
  // claims PNG, is actually a PDF
  assert.throws(
    () => s.save({ name: 'x.png', type: 'image/png', data: Buffer.from('%PDF-1.7\n...').toString('base64') }),
    (e) => e.code === 'UNSUPPORTED_TYPE',
  );
  // claims PDF, is actually text
  assert.throws(
    () => s.save({ name: 'x.pdf', type: 'application/pdf', data: Buffer.from('hej').toString('base64') }),
    (e) => e.code === 'UNSUPPORTED_TYPE',
  );
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: size is enforced on the decoded bytes', () => {
  const h = tempHome();
  const s = new UploadStore({ dir: path.join(h, 'up'), maxBytes: 100 });
  const big = Buffer.alloc(200, 0x41);
  assert.throws(
    () => s.save({ name: 'big.txt', type: 'text/plain', data: big.toString('base64') }),
    (e) => e.code === 'TOO_LARGE',
  );
  assert.equal(MAX_UPLOAD_BYTES > 1024 * 1024, true, 'the product default is megabytes, not kilobytes');
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: a name collision gets a suffix instead of overwriting', () => {
  const h = tempHome();
  const s = store(h);
  const a = s.save({ name: 'cv.txt', type: 'text/plain', data: Buffer.from('ett').toString('base64') });
  const b = s.save({ name: 'cv.txt', type: 'text/plain', data: Buffer.from('två').toString('base64') });
  assert.equal(a.name, 'cv.txt');
  assert.equal(b.name, 'cv-2.txt');
  assert.equal(fs.readFileSync(path.join(h, 'uploads', 'cv.txt'), 'utf8'), 'ett');
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: a data: URL prefix is accepted, malformed base64 is not', () => {
  const h = tempHome();
  const s = store(h);
  const ok = s.save({
    name: 'd.txt',
    type: 'text/plain',
    data: `data:text/plain;base64,${Buffer.from('hej').toString('base64')}`,
  });
  assert.equal(fs.readFileSync(path.join(h, 'uploads', 'd.txt'), 'utf8'), 'hej');
  assert.ok(ok.bytes > 0);
  assert.throws(
    () => s.save({ name: 'e.txt', type: 'text/plain', data: '!!!inte base64!!!' }),
    (e) => e.code === 'BAD_ENCODING',
  );
  fs.rmSync(h, { recursive: true, force: true });
});

test('upload: resolve() cannot escape the upload directory', () => {
  const h = tempHome();
  const s = store(h);
  s.save({ name: 'a.txt', type: 'text/plain', data: Buffer.from('x').toString('base64') });
  assert.equal(s.resolve('../uploads/a.txt'), null);
  assert.equal(s.resolve('../../etc/passwd'), null);
  assert.equal(s.resolve('a.txt').name, 'a.txt');
  fs.rmSync(h, { recursive: true, force: true });
});

test('preview: HTML and SVG are served in an opaque origin', () => {
  const html = serveHeadersFor('sida.html', 'text/html');
  assert.match(html['content-security-policy'], /^sandbox/);
  assert.ok(!/allow-same-origin/.test(html['content-security-policy']), 'a previewed page must not share the app origin');
  assert.equal(html['content-disposition'], 'inline');

  const svg = serveHeadersFor('x.svg', 'image/svg+xml');
  assert.match(svg['content-security-policy'], /^sandbox/);

  const png = serveHeadersFor('x.png', 'image/png');
  assert.equal(png['content-disposition'], 'inline');
  assert.equal(png['x-content-type-options'], 'nosniff');

  const zip = serveHeadersFor('x.docx', 'application/octet-stream');
  assert.match(zip['content-disposition'], /^attachment/);
  assert.match(zip['content-security-policy'], /default-src 'none'/);
});

test('preview: type detection covers what the agent can create', () => {
  assert.equal(typeForName('index.html'), 'text/html');
  assert.equal(typeForName('style.css'), 'text/css');
  assert.equal(typeForName('app.js'), 'text/javascript');
  assert.equal(typeForName('logo.svg'), 'image/svg+xml');
  assert.equal(typeForName('photo.png'), 'image/png');
  assert.equal(typeForName('data.bin'), 'application/octet-stream');
});

test('upload: sniffing recognises the formats the store allows', () => {
  assert.equal(sniffType(PNG_1PX), 'image/png');
  assert.equal(sniffType(Buffer.from('%PDF-1.4')), 'application/pdf');
  assert.equal(sniffType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffType(Buffer.from('hej')), null);
});

/* --------------------------------------------------------- through the host -- */

async function uploadVia(s, cookie, body) {
  return fetch(`${s.base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
    body: JSON.stringify(body),
  });
}

test('upload/api: requires a session, a CSRF header and a supported type', async () => {
  const h = tempHome();
  const s = await startTestServer({ home: h });
  try {
    const anon = await fetch(`${s.base}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ name: 'a.txt', type: 'text/plain', data: 'aGVq' }),
    });
    assert.equal(anon.status, 401);

    const { cookie } = await s.pair();
    const noCsrf = await fetch(`${s.base}/api/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ name: 'a.txt', type: 'text/plain', data: 'aGVq' }),
    });
    assert.equal(noCsrf.status, 403);

    const bad = await uploadVia(s, cookie, { name: 'x.html', type: 'text/html', data: 'PGgxPng8L2gxPg==' });
    assert.equal(bad.status, 415, 'HTML is not an uploadable type');
  } finally {
    await s.close();
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('upload/api: a phone photo lands in the workspace and is listed', async () => {
  const h = tempHome();
  const s = await startTestServer({ home: h });
  try {
    const { cookie } = await s.pair();
    const res = await uploadVia(s, cookie, { name: 'foto.png', type: 'image/png', data: PNG_1PX.toString('base64') });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.upload.name, 'foto.png');
    assert.equal(body.upload.inline, true);

    // the agent must be able to see it with the ordinary workspace tool
    const listed = fs.readdirSync(path.join(h, 'workspace'));
    assert.ok(listed.includes('foto.png'), `workspace has: ${listed.join(', ')}`);

    const again = await (await fetch(`${s.base}/api/uploads`, { headers: { cookie } })).json();
    assert.ok(again.uploads.some((u) => u.name === 'foto.png'));
  } finally {
    await s.close();
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('upload/api: the file can be fetched back, and HTML from the agent is sandboxed', async () => {
  const h = tempHome();
  const s = await startTestServer({ home: h });
  try {
    const { cookie } = await s.pair();
    await uploadVia(s, cookie, { name: 'r.txt', type: 'text/plain', data: Buffer.from('hej').toString('base64') });

    const got = await fetch(`${s.base}/api/uploads/r.txt`, { headers: { cookie } });
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'hej');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

    // MAJIN writes an HTML page with the workspace tool; serving it must sandbox it
    fs.writeFileSync(path.join(h, 'workspace', 'sida.html'), '<!doctype html><h1>hej</h1><script>parent.alert(1)</script>');
    const page = await fetch(`${s.base}/api/uploads/sida.html`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /^sandbox/);
    assert.ok(!/allow-same-origin/.test(csp), 'a previewed page must not share the app origin');
  } finally {
    await s.close();
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('upload/api: fetching an upload requires a session', async () => {
  const h = tempHome();
  const s = await startTestServer({ home: h });
  try {
    const { cookie } = await s.pair();
    await uploadVia(s, cookie, { name: 'p.txt', type: 'text/plain', data: Buffer.from('x').toString('base64') });
    const anon = await fetch(`${s.base}/api/uploads/p.txt`);
    assert.equal(anon.status, 401);
    const missing = await fetch(`${s.base}/api/uploads/nope.txt`, { headers: { cookie } });
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${s.base}/api/uploads/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie } });
    assert.equal(traversal.status, 404);
  } finally {
    await s.close();
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('upload: the inline allowlist contains no type that can execute', () => {
  for (const t of INLINE_TYPES) {
    assert.ok(!/html|svg|javascript/.test(t), `${t} must not be inline`);
  }
});
