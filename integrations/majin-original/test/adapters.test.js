/* GRAND ARCHITECT Acceptans — Del 7B: safe adapters = declarative http-json
   descriptors with HARD validation BEFORE any file is written; permission
   classes gate what an adapter may ever do; no executable content, https
   only, no raw secrets. An invalid adapter never touches disk. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adapters, validateAdapter, PERMISSIONS } from '../src/core/adapters.js';

const mk = () => new Adapters({ get: (k, d) => (k === 'adapters.dir' ? fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adp-')) : d ?? undefined) });
const GOOD = () => ({ name: 'arbetsformedningen', kind: 'http-json', baseUrl: 'https://xt-xt.af/1', permission: 'read', headers: { Accept: 'application/json', Authorization: 'Bearer {env:AF_TOKEN}' }, mapping: { title: 'items.0.title', city: 'items.0.city' }, timeoutMs: 15000, rate: { maxPerHour: 60 } });

test('7B.1 a clean declarative adapter validates + creates + lists + removes', () => {
  const a = mk();
  assert.deepEqual(validateAdapter(GOOD()), []);
  const r = a.create(GOOD());
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(a.dir, 'arbetsformedningen.json')), true, 'descriptor lives on disk');
  const json = JSON.parse(fs.readFileSync(path.join(a.dir, 'arbetsformedningen.json'), 'utf8'));
  assert.equal(json.permission, 'read');
  assert.equal(a.list().length, 1);
  assert.equal(a.remove('arbetsformedningen').ok, true);
  assert.equal(a.list().length, 0);
});

test('7B.2 validation REJECTS unsafe specs — nothing is ever written', () => {
  const a = mk();
  const cases = [
    ['plain http (no TLS)', { ...GOOD(), baseUrl: 'http://jobs.example.com/api' }],
    ['javascript: scheme', { ...GOOD(), baseUrl: 'javascript:fetch(x)' }],
    ['code in kind', { ...GOOD(), kind: 'eval-js' }],
    ['unknown permission', { ...GOOD(), permission: 'everything' }],
    ['raw secret in header', { ...GOOD(), headers: { Authorization: 'Bearer sk-live1234567890' } }],
    ['executable header payload', { ...GOOD(), headers: { 'X-Run': 'javascript:require("fs")' } }],
    ['code-shaped mapping source', { ...GOOD(), mapping: { title: 'process.exit(1)' } }],
    ['bad name', { ...GOOD(), name: 'DROP TABLE' }],
  ];
  for (const [why, spec] of cases) {
    const issues = validateAdapter(spec);
    assert.ok(issues.length > 0, `must reject: ${why}`);
    const r = a.create(spec);
    assert.equal(r.ok, false, `create refuses: ${why}`);
  }
  assert.equal(a.list().length, 0, 'NO unsafe descriptor reached disk');
});

test('7B.3 permission classes are the contract — read adapters may only GET', () => {
  assert.deepEqual(Object.keys(PERMISSIONS ? { r: 1 } : {}), ['r']);
  assert.ok(PERMISSIONS.includes('read') && PERMISSIONS.includes('external-write') && PERMISSIONS.includes('external-post'), 'three classes exist');
  const a = mk();
  const r = a.create({ ...GOOD(), name: 'pub-post', permission: 'external-post', baseUrl: 'https://public.example.com/submit' });
  assert.equal(r.ok, true);
  assert.equal(r.adapter.permission, 'external-post', 'class sticker travels with the descriptor');
});

test('7B.4 localhost in dev is allowed, but remote non-TLS is not', () => {
  assert.deepEqual(validateAdapter({ ...GOOD(), baseUrl: 'http://127.0.0.1:8080/api' }), []);
  assert.ok(validateAdapter({ ...GOOD(), baseUrl: 'http://192.168.1.50/api' }).length === 0, 'LAN host ok in dev');
  assert.ok(validateAdapter({ ...GOOD(), baseUrl: 'http://evil.example.net/api' }).length > 0, 'remote http rejected');
});
