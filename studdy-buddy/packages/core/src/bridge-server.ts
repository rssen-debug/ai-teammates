import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SourcePage, SelectionContext } from '@studdy/shared';
import {
  generateBridgeToken,
  parseBridgeMessage,
  validatePageContext,
  validateSelection,
  validateSiteRequest,
  verifyToken,
} from './browser-bridge.js';

/**
 * The loopback WebSocket server for the browser extension.
 *
 * Security decisions, all enforced here rather than trusted to the client:
 *  - binds to 127.0.0.1 only, so nothing on the network can reach it
 *  - every message must carry the shared token; a socket that fails the first
 *    message is closed immediately
 *  - no token configured => the server refuses to start at all (fail closed)
 *  - page payloads are validated against the student's own site allow-list
 *  - incoming frames are size-capped before JSON parsing
 *  - messages from a client before `hello` are rejected, so a stray request
 *    cannot inject observations
 *
 * The server is deliberately dumb: it translates socket messages into typed
 * callbacks. Nothing product-specific lives here, which is why it can be tested
 * against a real socket in the test suite.
 */

export interface BridgeServerOptions {
  /** 0 picks a free port (used by tests). */
  port?: number;
  host?: string;
  /** Shared secret. Empty string means "do not start". */
  token: string;
  /** Student's allowed study sites. Empty list blocks all page payloads. */
  allowList: string[];
  onPage?: (page: SourcePage, raw: unknown) => void;
  onSelection?: (selection: SelectionContext) => void;
  onRawMessage?: (message: { type: string; payload: unknown; sentAt?: string }) => void;
  /** The student pressed "allow this site" in the extension popup. */
  onSiteRequest?: (host: string) => void;
  logger?: (line: string) => void;
}

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  host: string;
  clients: number;
  /** Why it is not running, when it is not. */
  detail: string;
}

export class BrowserBridgeServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly authenticated = new WeakSet<WebSocket>();
  private actualPort: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: BridgeServerOptions) {}

  async start(): Promise<BridgeStatus> {
    if (this.wss) return this.status();
    if (!this.options.token) {
      this.lastError = 'Ingen bryggtoken är genererad. Öppna inställningarna och anslut webbläsartillägget.';
      return this.status();
    }

    const host = this.options.host ?? '127.0.0.1';
    // Explicitly 127.0.0.1 by default: never 0.0.0.0.
    const httpServer = createServer((_req, res) => {
      // No HTTP surface at all. Anything that is not an upgrade gets a 404.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Studdy Buddy bridge: WebSocket only.');
    });
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 2_000_000 });

    wss.on('connection', (socket, request) => {
      // Defence in depth: the bind already limits us to loopback, and we check
      // the peer address again so a misconfigured host cannot open this up.
      const remote = request.socket.remoteAddress ?? '';
      if (!isLoopbackAddress(remote)) {
        this.log(`Avvisade anslutning från ${remote} (endast loopback tillåts).`);
        socket.close(1008, 'loopback only');
        return;
      }

      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', (err) => this.log(`Socket-fel: ${err.message}`));
      socket.on('message', (data) => this.handleMessage(socket, data.toString()));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(this.options.port ?? 8765, host);
    }).catch((err: unknown) => {
      this.lastError = `Kunde inte starta bryggan: ${err instanceof Error ? err.message : String(err)}`;
    });

    if (this.lastError) {
      httpServer.close();
      return this.status();
    }

    const address = httpServer.address();
    this.actualPort = typeof address === 'object' && address ? address.port : null;
    this.httpServer = httpServer;
    this.wss = wss;
    this.log(`Brygga lyssnar på ws://${host}:${this.actualPort} (endast denna dator).`);
    return this.status();
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close(1001, 'app closing');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.actualPort = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  status(): BridgeStatus {
    return {
      running: this.wss !== null,
      port: this.actualPort,
      host: this.options.host ?? '127.0.0.1',
      clients: this.clients.size,
      detail: this.wss
        ? 'Bryggan lyssnar på loopback.'
        : (this.lastError ?? 'Bryggan är inte startad.'),
    };
  }

  /** Replaces the allow-list (used when the student adds a site). */
  updateAllowList(sites: string[]): void {
    this.options.allowList = sites;
    this.broadcast({ type: 'welcome', payload: { allowedSites: sites, siteCount: sites.length } });
  }

  /** Sends a message to every authenticated client. Never throws. */
  broadcast(message: { type: string; payload?: unknown }): number {
    let sent = 0;
    const data = JSON.stringify({ ...message, sentAt: new Date().toISOString() });
    for (const client of this.clients) {
      if (client.readyState !== 1 /* OPEN */) continue;
      if (!this.authenticated.has(client)) continue;
      try {
        client.send(data);
        sent += 1;
      } catch {
        /* a dead socket is removed by its close handler */
      }
    }
    return sent;
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const parsed = parseBridgeMessage(raw);
    if (!parsed.message) {
      this.log(`Avvisade meddelande: ${parsed.error ?? 'okänt fel'}`);
      socket.close(1008, 'invalid message');
      return;
    }
    const message = parsed.message;

    // Authentication happens on the first message and is sticky per socket.
    if (!this.authenticated.has(socket)) {
      const auth = verifyToken(message.token, this.options.token);
      if (!auth.ok) {
        this.log(`Autentisering misslyckades: ${auth.reason}`);
        socket.close(1008, 'unauthorized');
        return;
      }
      this.authenticated.add(socket);
      // Tell the extension what it may send, so a client cannot guess.
      // The app owns the allow-list, so it tells the extension what it may read
      // rather than the extension deciding for itself.
      socket.send(
        JSON.stringify({ type: 'welcome', payload: { allowedSites: this.options.allowList, siteCount: this.options.allowList.length } }),
      );
    }

    if (message.type === 'hello' || message.type === 'ping') {
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', sentAt: new Date().toISOString() }));
      return;
    }

    if (message.type === 'page-context' || message.type === 'curriculum') {
      const validated = validatePageContext(message.payload, this.options.allowList);
      if (!validated.value) {
        this.log(`Sidan avvisades: ${validated.error ?? 'okänt skäl'}`);
        socket.send(JSON.stringify({ type: 'rejected', payload: { reason: validated.error } }));
        return;
      }
      this.options.onPage?.(validated.value, message.payload);
      return;
    }

    if (message.type === 'selection') {
      const validated = validateSelection(message.payload, this.options.allowList);
      if (!validated.value) {
        socket.send(JSON.stringify({ type: 'rejected', payload: { reason: validated.error } }));
        return;
      }
      this.options.onSelection?.(validated.value);
      return;
    }

    if (message.type === 'site-request') {
      const request = validateSiteRequest(message.payload);
      if (!request.host) {
        socket.send(JSON.stringify({ type: 'rejected', payload: { reason: request.error } }));
        return;
      }
      this.options.onSiteRequest?.(request.host);
      return;
    }

    this.options.onRawMessage?.({ type: message.type, payload: message.payload, sentAt: message.sentAt });
  }

  private log(line: string): void {
    this.options.logger?.(line);
  }
}

export function isLoopbackAddress(address: string): boolean {
  // Node reports IPv4-mapped IPv6 for loopback sockets such as ::ffff:127.0.0.1.
  const normalised = address.replace(/^::ffff:/, '');
  return normalised === '127.0.0.1' || normalised === '::1' || normalised === 'localhost';
}

/** Re-exported so callers can create a token without importing the pure module. */
export { generateBridgeToken };
