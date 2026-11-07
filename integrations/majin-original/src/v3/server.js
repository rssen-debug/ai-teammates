import http from 'node:http';
import { runV3FileDeliverable, V3InputError, V3_FILE_LIMIT } from './runtime/file-deliverable.js';
import { renderV3Page } from './ui/page.js';
import { assertV3NodeSupported } from './platform/runtime.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(body));
}

function localOriginAllowed(origin, host, port) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    return loopback && parsed.protocol === 'http:' && parsed.port === String(port)
      && host === `${parsed.hostname}:${parsed.port}`;
  } catch {
    return false;
  }
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'request body exceeds the size limit'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * A loopback-only V3 preview server. It exposes no file reads, shell tools,
 * provider routes, or CORS. The workspace path is a local operator choice.
 */
export function createV3Server({ workspaceDir, host = '127.0.0.1', maxBodyBytes = V3_FILE_LIMIT + 16_384 } = {}) {
  assertV3NodeSupported();
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) {
    throw new TypeError('workspaceDir is required; no implicit write destination is allowed');
  }
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new TypeError('V3 preview server may bind only to loopback');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > V3_FILE_LIMIT + 65_536) {
    throw new TypeError('maxBodyBytes is outside the supported limit');
  }

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    const requestHost = req.headers.host || '';
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(requestHost)) {
      json(res, 403, { ok: false, error: { code: 'HOST_REJECTED', message: 'Only loopback Host headers are accepted.' } });
      return;
    }

    const origin = req.headers.origin;
    if (!localOriginAllowed(origin, requestHost, port)) {
      json(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED', message: 'Cross-origin requests are not allowed.' } });
      return;
    }

    const url = new URL(req.url || '/', `http://${requestHost}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      });
      res.end(renderV3Page());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/goals') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        req.resume();
        json(res, 415, { ok: false, error: { code: 'JSON_REQUIRED', message: 'Send application/json.' } });
        return;
      }
      const length = Number(req.headers['content-length'] || 0);
      if (length > maxBodyBytes) {
        req.resume();
        json(res, 413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds the size limit.' } });
        return;
      }
      try {
        const input = await readJson(req, maxBodyBytes);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new HttpError(400, 'request must be a JSON object');
        }
        const result = await runV3FileDeliverable({ ...input, workspaceDir });
        const status = result.ok ? 201 : (result.error?.code === 'FILE_EXISTS' ? 409 : 422);
        json(res, status, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error instanceof V3InputError ? 400 : 500;
        json(res, status, {
          ok: false,
          error: {
            code: error instanceof V3InputError ? error.code : error instanceof HttpError ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Request could not be processed.',
          },
        });
      }
      return;
    }

    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  return server;
}

export async function startV3Server(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('port must be 0..65535');
  const server = createV3Server(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return { server, url: `http://${host}:${address.port}` };
}
