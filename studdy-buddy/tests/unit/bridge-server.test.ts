import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { BrowserBridgeServer, isLoopbackAddress } from '../../packages/core/src/bridge-server.js';
import type { SourcePage, SelectionContext } from '@studdy/shared';

/**
 * These tests open a real WebSocket on a real loopback port. That is the point:
 * the bridge's job is socket behaviour, and a fake socket would not prove
 * anything about binding, authentication or frame limits.
 */

const TOKEN = 'a'.repeat(48);
const ALLOW = ['netacad.com', 'canvas.instructure.com'];

interface Harness {
  server: BrowserBridgeServer;
  port: number;
  pages: SourcePage[];
  selections: SelectionContext[];
  logs: string[];
}

const started: BrowserBridgeServer[] = [];

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
});

async function startServer(): Promise<Harness> {
  const pages: SourcePage[] = [];
  const selections: SelectionContext[] = [];
  const logs: string[] = [];
  const server = new BrowserBridgeServer({
    port: 0,
    token: TOKEN,
    allowList: ALLOW,
    onPage: (page) => pages.push(page),
    onSelection: (selection) => selections.push(selection),
    logger: (line) => logs.push(line),
  });
  started.push(server);
  const status = await server.start();
  if (!status.running || status.port === null) throw new Error(`server did not start: ${status.detail}`);
  return { server, port: status.port, pages, selections, logs };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Waits for one message, or resolves null when the socket closes first. */
function nextMessage(socket: WebSocket, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMessage = (data: { toString(): string }) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    }
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

describe('BrowserBridgeServer', () => {
  it('refuses to start without a token instead of running unauthenticated', async () => {
    const server = new BrowserBridgeServer({ port: 0, token: '', allowList: ALLOW });
    started.push(server);
    const status = await server.start();
    expect(status.running).toBe(false);
    expect(status.port).toBeNull();
    expect(status.detail).toMatch(/token/i);
  });

  it('binds to loopback and reports the real port when given port 0', async () => {
    const { server, port } = await startServer();
    expect(port).toBeGreaterThan(0);
    const status = server.status();
    expect(status.running).toBe(true);
    expect(status.host).toBe('127.0.0.1');
    expect(status.detail).toMatch(/loopback/i);
  });

  it('authenticates with the shared token and accepts a page from an allowed site', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    const welcome = await nextMessage(socket);
    expect(welcome?.type).toBe('welcome');

    socket.send(
      JSON.stringify({
        type: 'page-context',
        token: TOKEN,
        payload: {
          url: 'https://canvas.instructure.com/courses/1/pages/meiosis',
          title: 'Meiosis',
          schemaVersion: 1,
          snapshot: {
            url: 'https://canvas.instructure.com/courses/1/pages/meiosis',
            title: 'Meiosis',
            courseName: 'Biologi 1',
            headings: [{ level: 1, text: 'Meiosis' }],
            navLinks: [{ text: 'Modul 1', href: null, depth: 1 }],
            contentInIframe: false,
            capturedAt: new Date().toISOString(),
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.pages).toHaveLength(1);
    expect(harness.pages[0]?.url).toContain('canvas.instructure.com');
    expect(harness.pages[0]?.title).toBe('Meiosis');
    socket.close();
  });

  it('closes the socket when the token is wrong', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ type: 'hello', token: 'b'.repeat(48) }));
    expect(await closed).toBe(1008);
    expect(harness.logs.join(' ')).toMatch(/Autentisering misslyckades/);
  });

  it('closes the socket on an unknown message type before any parsing', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ type: 'exfiltrate', token: TOKEN }));
    expect(await closed).toBe(1008);
    expect(harness.pages).toHaveLength(0);
  });

  it('rejects an allowed-looking but unlisted site and says why', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'page-context',
        token: TOKEN,
        payload: { url: 'https://bank.example.com/account', headingPath: [] },
      }),
    );
    const rejected = await nextMessage(socket);
    expect(rejected?.type).toBe('rejected');
    expect(JSON.stringify(rejected)).toMatch(/tillåtna studiesajter/);
    expect(harness.pages).toHaveLength(0);
    socket.close();
  });

  it('accepts selections with text and rejects empty ones', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await nextMessage(socket);

    socket.send(
      JSON.stringify({
        type: 'selection',
        token: TOKEN,
        payload: { text: ' Mitokondrien är cellens kraftverk ', url: 'https://canvas.instructure.com/x', rect: null },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.selections[0]?.text).toBe('Mitokondrien är cellens kraftverk');

    socket.send(JSON.stringify({ type: 'selection', token: TOKEN, payload: { text: '   ', url: 'https://canvas.instructure.com/x' } }));
    const rejected = await nextMessage(socket);
    expect(rejected?.type).toBe('rejected');
    socket.close();
  });

  it('answers ping with pong so the extension can check liveness', async () => {
    const harness = await startServer();
    const socket = await connect(harness.port);
    // The first message on a socket also performs authentication, so `welcome`
    // and `pong` can arrive back to back; buffer instead of awaiting one by one.
    const seen: string[] = [];
    socket.on('message', (data: { toString(): string }) => {
      seen.push((JSON.parse(data.toString()) as { type: string }).type);
    });
    socket.send(JSON.stringify({ type: 'ping', token: TOKEN }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toEqual(['welcome', 'pong']);
    socket.close();
  });

  it('broadcasts only to authenticated sockets', async () => {
    const harness = await startServer();
    const authed = await connect(harness.port);
    authed.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await nextMessage(authed);

    const stranger = await connect(harness.port);
    const strangerGot = nextMessage(stranger, 300);

    expect(harness.server.broadcast({ type: 'request-snapshot' })).toBe(1);
    const received = await nextMessage(authed);
    expect(received?.type).toBe('request-snapshot');
    expect(await strangerGot).toBeNull();
    authed.close();
    stranger.close();
  });

  it('stops cleanly and reports that it is no longer listening', async () => {
    const { server, port } = await startServer();
    await server.stop();
    const status = server.status();
    expect(status.running).toBe(false);
    await expect(connect(port)).rejects.toBeTruthy();
  });
});

describe('isLoopbackAddress', () => {
  it('accepts only loopback forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
  });
});
