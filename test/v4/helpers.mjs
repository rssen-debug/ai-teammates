/**
 * Test helpers for MAJIN V4. Every helper creates an isolated MAJIN_HOME so
 * tests never touch the developer's real data directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import { startV4Server } from '../../src/v4/server.js';

const PORT_BASE = (() => {
  let port = 21000 + (process.pid % 400) * 25;
  return { next: () => (port += 25) };
})();

export function tempHome(prefix = 'majin-v4-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export async function startTestServer(overrides = {}) {
  const home = overrides.home || tempHome();
  const env = {
    MAJIN_HOME: home,
    MAJIN_V4_PROVIDER: 'demo',
    MAJIN_V4_RATE_REQUESTS: '1000',
    MAJIN_V4_RATE_TURNS: '1000',
    MAJIN_V4_RATE_PAIRING: '100',
    ...(overrides.env || {}),
  };
  let config;
  let server;
  let context;
  // Node's global fetch pools connections per origin. If a later test reused
  // an ephemeral port that an earlier (closed) server had used, undici could
  // hand out a dead socket. Unique, monotonic ports per process avoid that.
  let attempt = 0;
  for (;;) {
    const port = PORT_BASE.next() + attempt;
    config = loadConfig({ env, argv: ['--port', String(port)], platform: 'linux' });
    try {
      ({ server, context } = await startV4Server({ config }));
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt > 40) throw err;
      attempt += 1;
    }
  }
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const pairingFile = path.join(home, 'v4', 'pairing.json');

  async function pair(code = context.pairingFresh) {
    const res = await fetch(`${base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ code }),
    });
    const cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
    return { res, cookie, body: await res.json() };
  }

  return {
    home,
    base,
    config,
    server,
    context,
    pairingFile,
    pair,
    /**
     * A cookie for an already-paired device, e.g. the phone's session that the
     * host remembers across a restart. Used to test "second device / after
     * restart" scenarios without minting a new pairing code.
     */
    existingSession() {
      const { token } = context.sessions.create({ ip: 'test', userAgent: 'test-device' });
      return `${config.auth.cookieName}=${encodeURIComponent(token)}`;
    },
    /** `keep: true` leaves the data dir on disk (backup/restore tests need it). */
    async close({ keep = false } = {}) {
      await new Promise((resolve) => {
        server.close(resolve);
        // Browser clients keep history SSE subscriptions open. Test teardown
        // must close those sockets before removing the isolated data directory.
        server.closeAllConnections();
      });
      if (!keep) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Read an SSE response fully, returning typed events. */
export async function readSse(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    let type = null;
    let data = null;
    for (const line of lines) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (type) events.push({ type, data: data ? JSON.parse(data) : null });
  }
  return events;
}

export function postChat(base, cookie, body, extraHeaders = {}) {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-majin-csrf': '1',
      origin: base,
      cookie,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}
