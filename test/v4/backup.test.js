/**
 * Backup, verify, restore — the round trip that must not lose or invent data.
 *
 * The interesting cases are the refusals: a tampered bundle, a bundle that
 * carries a key, a schema from the future, and a restore that would overwrite
 * live data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { BACKUP_FORMAT, createBackup, restoreBackup, verifyBackup, BackupError } from '../../src/v4/backup.js';

/** Produce a data dir with a real conversation, goal, file and memory entry. */
async function seededHome() {
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen backup.txt med innehåll: spara mig', requestId: 'b1' });
    await readSse(res);
    // a memory entry through the agent's tool surface
    await s.context.tools.memory.put('preference', { key: 'language', text: 'svenska', tags: ['ui'], importance: 0.9 });
  } finally {
    // the data dir is the subject of these tests, so it must survive close()
    await s.close({ keep: true });
  }
  return home;
}

test('backup: a real data dir becomes a verified bundle', async () => {
  const home = await seededHome();
  const out = path.join(home, 'bk');
  try {
    const created = createBackup({ home, out });
    assert.ok(created.files >= 2, `expected conversation + goal, got ${created.files}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'MANIFEST.json'), 'utf8'));
    assert.equal(manifest.format, BACKUP_FORMAT);
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));

    const check = verifyBackup(out);
    assert.equal(check.ok, true, check.problems.join('; '));
    assert.equal(check.verdict, 'BUNDLE_OK');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: keys, pairing records and sessions are never included', async () => {
  const home = await seededHome();
  const out = path.join(home, 'bk');
  try {
    createBackup({ home, out });
    const everything = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else everything.push(path.relative(out, p));
      }
    };
    walk(out);
    for (const forbidden of ['secret.key', 'pairing.json', 'sessions.json']) {
      assert.ok(!everything.includes(forbidden), `${forbidden} must not be in a backup`);
    }
    const storedSecret = fs.readFileSync(path.join(home, 'v4', 'secret.key'), 'utf8').trim();
    for (const rel of everything) {
      if (rel === 'MANIFEST.json') continue;
      assert.ok(!fs.readFileSync(path.join(out, rel), 'utf8').includes(storedSecret), `${rel} contains the HMAC key`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: verify catches a tampered file', async () => {
  const home = await seededHome();
  const out = path.join(home, 'bk');
  try {
    createBackup({ home, out });
    const file = fs.readdirSync(path.join(out, 'conversations'))[0];
    const target = path.join(out, 'conversations', file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('spara', 'förstör'));

    const check = verifyBackup(out);
    assert.equal(check.ok, false);
    assert.equal(check.verdict, 'BUNDLE_TAMPERED');
    assert.ok(check.problems.some((p) => p.includes('hash mismatch')));
    assert.throws(() => restoreBackup({ bundle: out, home: tempHome() }), /refusing to restore/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: verify catches a missing file and an unlisted extra file', async () => {
  const home = await seededHome();
  const out = path.join(home, 'bk');
  try {
    createBackup({ home, out });
    const goals = fs.readdirSync(path.join(out, 'goals'));
    fs.unlinkSync(path.join(out, 'goals', goals[0]));
    fs.writeFileSync(path.join(out, 'conversations', 'sneaky.json'), '{"schema":"x"}');

    const check = verifyBackup(out);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((p) => p.startsWith('missing:')));
    assert.ok(check.problems.some((p) => p.startsWith('unlisted file:')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: a bundle carrying a key file is rejected even if the manifest lists it', async () => {
  const home = await seededHome();
  const out = path.join(home, 'bk');
  try {
    createBackup({ home, out });
    fs.copyFileSync(path.join(home, 'v4', 'secret.key'), path.join(out, 'secret.key'));
    const check = verifyBackup(out);
    assert.equal(check.ok, false);
    assert.ok(check.problems.some((p) => p.includes('forbidden file')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: restore brings conversations, goals and memory back', async () => {
  const home = await seededHome();
  const bundle = path.join(home, 'bk');
  const fresh = tempHome();
  try {
    createBackup({ home, out: bundle });
    const result = restoreBackup({ bundle, home: fresh });
    assert.ok(result.restored >= 2, `${result.restored} restored`);

    const convFile = fs.readdirSync(path.join(fresh, 'v4', 'conversations'))[0];
    const conv = JSON.parse(fs.readFileSync(path.join(fresh, 'v4', 'conversations', convFile), 'utf8'));
    assert.equal(conv.schema, 'majin.v4.conversation/v1');
    assert.ok(conv.messages.some((m) => m.content.includes('backup.txt')));

    const goalFile = fs.readdirSync(path.join(fresh, 'v4', 'goals'))[0];
    const goal = JSON.parse(fs.readFileSync(path.join(fresh, 'v4', 'goals', goalFile), 'utf8'));
    assert.equal(goal.schema, 'majin.v2.goal/v1');
    assert.equal(goal.state, 'COMPLETED');
    assert.ok(goal.receipts.some((r) => r.verified));

    const memory = JSON.parse(fs.readFileSync(path.join(fresh, 'v4', 'memory', 'preference.json'), 'utf8'));
    assert.ok(memory.entries.some((e) => e.key === 'language' && e.text === 'svenska'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('backup: dry run validates but writes nothing', async () => {
  const home = await seededHome();
  const bundle = path.join(home, 'bk');
  const fresh = tempHome();
  try {
    createBackup({ home, out: bundle });
    const result = restoreBackup({ bundle, home: fresh, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.restored >= 2);
    assert.equal(fs.existsSync(path.join(fresh, 'v4', 'conversations')), false, 'nothing was written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('backup: restore refuses to overwrite live data without --force', async () => {
  const home = await seededHome();
  const bundle = path.join(home, 'bk');
  try {
    createBackup({ home, out: bundle });
    assert.throws(() => restoreBackup({ bundle, home }), (err) => err instanceof BackupError && err.code === 'ALREADY_EXISTS');
    const forced = restoreBackup({ bundle, home, force: true });
    assert.ok(forced.restored >= 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: a schema from the future is refused instead of guessed', async () => {
  const home = await seededHome();
  const bundle = path.join(home, 'bk');
  const fresh = tempHome();
  try {
    createBackup({ home, out: bundle });
    // Rewrite one conversation with a future schema and re-hash the manifest.
    const crypto = await import('node:crypto');
    const rel = `conversations/${fs.readdirSync(path.join(bundle, 'conversations'))[0]}`;
    const file = path.join(bundle, rel);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.schema = 'majin.v4.conversation/v99';
    fs.writeFileSync(file, JSON.stringify(data));
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'MANIFEST.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === rel);
    entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    entry.bytes = fs.statSync(file).size;
    fs.writeFileSync(path.join(bundle, 'MANIFEST.json'), JSON.stringify(manifest));

    assert.throws(
      () => restoreBackup({ bundle, home: fresh }),
      (err) => err instanceof BackupError && err.code === 'UNKNOWN_SCHEMA' && /migration/i.test(err.message),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('backup: a newer bundle version is refused with a clear reason', async () => {
  const home = await seededHome();
  const bundle = path.join(home, 'bk');
  try {
    createBackup({ home, out: bundle });
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'MANIFEST.json'), 'utf8'));
    manifest.version = 99;
    fs.writeFileSync(path.join(bundle, 'MANIFEST.json'), JSON.stringify(manifest));
    const check = verifyBackup(bundle);
    assert.equal(check.ok, false);
    assert.equal(check.verdict, 'UNSUPPORTED_VERSION');
    assert.match(check.problems[0], /upgrade first/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('backup: writing a bundle inside the data dir is refused', async () => {
  const home = await seededHome();
  try {
    assert.throws(
      () => createBackup({ home, out: path.join(home, 'v4', 'backups') }),
      (err) => err instanceof BackupError && err.code === 'REFUSED',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
