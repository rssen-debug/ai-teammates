/**
 * MAJIN V5 — HTTP Server, Black Box UI Host & Mobile-to-Windows Remote Control.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrandArchitect } from './architect.js';
import { getV5InventorySummary } from './inventory.js';
import { ProviderAgent } from './provider-agent.js';
import { V5Schedule } from './schedule.js';
import { V5Heartbeat } from './heartbeat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOGO_PATH = path.join(REPO_ROOT, 'assets', 'majin-transparent.png');

function readJsonBody(req, maxBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400, cause: err }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  const bytes = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

export function createV5Server({
  dataDir = path.join(os.homedir(), '.majin', 'v5'),
  workspaceDir = null,
  browserWriteOrigins = [],
  browserVisible = undefined,
  host = '127.0.0.1',
  port = 0,
  fetchImpl = globalThis.fetch,
  completeImpl = null,
  portalAdapter = null,
  providerMaxRounds = undefined,
  providerContextCharBudget = undefined,
} = {}) {
  const architect = new GrandArchitect({
    dataDir,
    workspaceDir,
    fetchImpl,
    completeImpl,
    portalAdapter,
  });
  const providerAgent = new ProviderAgent({
    architect,
    browserWriteOrigins,
    browserVisible,
    ...(providerMaxRounds ? { maxRounds: providerMaxRounds } : {}),
    ...(providerContextCharBudget ? { contextCharBudget: providerContextCharBudget } : {}),
  });
  const schedule = new V5Schedule({
    dataDir,
    execute: input => providerAgent.execute(input),
    isBusy: () => Boolean(providerAgent.active) || ['RUNNING', 'WAITING_USER', 'BLOCKED', 'PAUSED'].includes(providerAgent.getGoalState()?.status)
      || architect.getGoalState()?.status === 'RUNNING',
    isAllowed: () => !architect.files.stopRequested && Boolean(architect.providers.state.activeModelId)
      && architect.files.describeAccessState().grantedLanes.includes('sys'),
  });
  architect.schedule = schedule;
  const heartbeat = new V5Heartbeat({ dataDir });
  architect.heartbeat = heartbeat;
  const useProviderAgent = body => Boolean(architect.providers.state.activeModelId) &&
    body.actions == null && body.jobAds == null && !body.synthesizeMissingSkill && !body.blocker && !body.requireUserConfirmation;

  // Safe mobile-to-host pairing tokens (Section 8 & 13)
  const pairedMobileClients = new Map();
  let currentPairingCode = String(crypto.randomInt(100000, 999999));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'POST' && req.headers.origin && req.headers.origin !== url.origin) {
        return sendJson(res, 403, { ok: false, code: 'CROSS_ORIGIN_WRITE_BLOCKED' });
      }
      // Static Black Box UI assets
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return serveStaticFile(res, path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/app.css') {
        return serveStaticFile(res, path.join(UI_DIR, 'app.css'), 'text/css; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/app.js') {
        return serveStaticFile(res, path.join(UI_DIR, 'app.js'), 'application/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/dot-matrix.js') {
        return serveStaticFile(res, path.join(UI_DIR, 'dot-matrix.js'), 'application/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/strings.js') {
        return serveStaticFile(res, path.join(UI_DIR, 'strings.js'), 'application/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/logo.png') {
        return serveStaticFile(res, LOGO_PATH, 'image/png');
      }

      // Health & version endpoint (supports both /api/v5/health and /api/health for Electron desktop)
      if (method === 'GET' && (pathname === '/api/v5/health' || pathname === '/api/health')) {
        return sendJson(res, 200, {
          ok: true,
          app: 'majin-v5',
          ...architect.ops.getVersionInfo(),
        });
      }

      if (pathname === '/api/v5/heartbeat') {
        if (method === 'GET') return sendJson(res, 200, heartbeat.view());
        if (method === 'POST') return sendJson(res, 200, await heartbeat.manage(await readJsonBody(req)));
      }

      if (pathname === '/api/v5/schedule') {
        if (method === 'GET') return sendJson(res, 200, schedule.status());
        if (method === 'POST') return sendJson(res, 200, schedule.manage(await readJsonBody(req)));
      }

      // Unified V5 state endpoint
      if (method === 'GET' && pathname === '/api/v5/state') {
        return sendJson(res, 200, {
          ok: true,
          versionInfo: architect.ops.getVersionInfo(),
          provider: architect.providers.getPublicState(),
          skills: architect.skillTree.list(),
          aggregateSkills: architect.skillTree.aggregateSummary(),
          activeGoal: providerAgent.getGoalState() || architect.getGoalState(),
          voice: architect.voice.describeStatus(),
          access: architect.files.describeAccessState(),
          inventory: getV5InventorySummary(),
        });
      }

      // Skill tree endpoints
      if (method === 'GET' && pathname === '/api/v5/skills') {
        return sendJson(res, 200, {
          ok: true,
          skills: architect.skillTree.list(),
          aggregate: architect.skillTree.aggregateSummary(),
        });
      }
      if (method === 'POST' && pathname === '/api/v5/skills/synthesize') {
        const body = await readJsonBody(req);
        const built = await architect.skillBuilder.synthesizeSkill(body);
        return sendJson(res, built.ok ? 200 : 400, built);
      }

      // Provider configuration & connection verification
      if (method === 'POST' && pathname === '/api/v5/provider') {
        const body = await readJsonBody(req);
        const providerId = body.providerId || 'opencode-go';
        if (body.apiKey || body.baseUrl || !architect.providers.getPublicState().providers[providerId]) {
          await architect.providers.configureProvider({
            providerId,
            apiKey: body.apiKey || undefined,
            baseUrl: body.baseUrl,
            discover: Boolean(body.verifyConnection),
          });
        }
        if (body.modelId) {
          architect.providers.selectModel({
            providerId,
            modelId: body.modelId,
            allowManualFallback: true,
          });
        }
        let verification = null;
        if (body.verifyConnection && !body.apiKey && !body.baseUrl) {
          verification = await architect.providers.discoverCatalog(providerId);
        }
        const pub = architect.providers.getPublicState();
        const activeProv = pub.providers?.[pub.activeProvider];
        return sendJson(res, 200, {
          ok: true,
          savedConfig: Boolean(activeProv?.savedConfig),
          connectionVerified: Boolean(activeProv?.connectionVerified),
          verification,
          provider: pub,
        });
      }

      // Execute goal on host
      if (method === 'POST' && pathname === '/api/v5/goal') {
        const body = await readJsonBody(req);
        const goalState = useProviderAgent(body) ? await providerAgent.execute(body) : await architect.executeGoal(body);
        return sendJson(res, 200, {
          ok: true,
          goal: goalState,
          ...goalState,
        });
      }

      // Steer active goal mid-flight
      if (method === 'POST' && pathname === '/api/v5/goal/steer') {
        const body = await readJsonBody(req);
        const steered = providerAgent.active ? providerAgent.steer(body.instruction || body.goalText) : await architect.steerActiveGoal(body);
        return sendJson(res, 200, { ok: true, ...steered });
      }

      // Cancel active goal
      if (method === 'POST' && pathname === '/api/v5/goal/cancel') {
        const body = await readJsonBody(req);
        const cancelled = providerAgent.active ? await providerAgent.cancel() : architect.cancelGoal(body.goalId);
        return sendJson(res, 200, { ok: true, goal: cancelled });
      }

      // Pause preserves provider checkpoints and aborts in-flight inference/tools.
      if (method === 'POST' && pathname === '/api/v5/goal/pause') {
        await readJsonBody(req);
        return sendJson(res, 200, { ok: true, goal: await providerAgent.pause() });
      }

      // Resume goal from checkpoint
      if (method === 'POST' && pathname === '/api/v5/goal/resume') {
        const body = await readJsonBody(req);
        const resumed = providerAgent.getGoalState() ? await providerAgent.execute({ goalText: body.goalText, criteria: body.criteria, maxRounds: body.maxRounds, resume: true }) : await architect.resumeGoal(body);
        return sendJson(res, 200, { ok: true, goal: resumed });
      }

      // File upload (base64 JSON or binary stream)
      if (method === 'POST' && pathname === '/api/v5/uploads') {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          const body = await readJsonBody(req);
          const saved = architect.files.saveUpload(body);
          return sendJson(res, 200, { ok: true, upload: saved });
        }
        const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload.bin'));
        const mimeType = ct.split(';')[0].trim() || 'application/octet-stream';
        const saved = await architect.files.saveStreamUpload({
          readableStream: req,
          name: fileName,
          type: mimeType,
        });
        return sendJson(res, 200, { ok: true, upload: saved });
      }

      // Access & Owner Mode control
      if (method === 'POST' && pathname === '/api/v5/access') {
        const body = await readJsonBody(req);
        if (body.action === 'stop_all') {
          const stopped = architect.files.triggerEmergencyStop();
          await providerAgent.cancel();
          architect.cancelGoal();
          return sendJson(res, 200, { ok: true, ...stopped });
        }
        if (body.action === 'grant_browser_origin') {
          const state = architect.files.grantBrowserOrigins(body.origins || body.origin);
          return sendJson(res, 200, { ok: true, access: state });
        }
        if (body.action === 'revoke_browser_origin') {
          const origins = body.origins ?? body.origin ?? null;
          const state = architect.files.revokeBrowserOrigins(!origins || (Array.isArray(origins) && !origins.length) ? null : origins);
          return sendJson(res, 200, { ok: true, access: state });
        }
        if (body.action === 'revoke') {
          await providerAgent.cancel();
          const state = architect.files.revokePermissions({ lanes: body.lane ? [body.lane] : body.lanes || null, folder: body.folder || null, browserOrigins: body.browserOrigins || null });
          return sendJson(res, 200, { ok: true, access: state });
        }
        const state = architect.files.enableOwnerMode({ lanes: body.lanes, folders: body.folders || body.allowedPaths, browserOrigins: body.browserOrigins || [] });
        return sendJson(res, 200, { ok: true, access: state });
      }

      // Voice opt-in & barge-in
      if (method === 'POST' && pathname === '/api/v5/voice/activate') {
        const body = await readJsonBody(req);
        const out = body.userInitiated
          ? architect.voice.activateMicrophone({ userInitiated: true })
          : architect.voice.deactivateMicrophone();
        return sendJson(res, out.ok ? 200 : 403, out);
      }
      if (method === 'POST' && pathname === '/api/v5/voice/interrupt') {
        const out = architect.voice.interruptSpeech({ reason: 'api_barge_in' });
        return sendJson(res, 200, out);
      }

      // Mobile client pairing & remote execution on the Windows host (Section 8 & 13)
      if (method === 'POST' && pathname === '/api/v5/pair') {
        const body = await readJsonBody(req);
        if (String(body.code || '') !== currentPairingCode) {
          return sendJson(res, 403, { ok: false, code: 'INVALID_PAIRING_CODE' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        pairedMobileClients.set(token, {
          deviceName: String(body.deviceName || 'Mobile Client'),
          pairedAt: new Date().toISOString(),
        });
        // Rotate one-time pairing code immediately after successful pairing
        currentPairingCode = String(crypto.randomInt(100000, 999999));
        return sendJson(res, 200, {
          ok: true,
          token,
          hostInfo: {
            hostname: os.hostname(),
            platform: process.platform,
            workspaceDir: architect.workspaceDir,
          },
        });
      }

      if (method === 'POST' && pathname === '/api/v5/remote/goal') {
        const auth = String(req.headers.authorization || '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (!pairedMobileClients.has(token)) {
          return sendJson(res, 401, { ok: false, code: 'UNPAIRED_MOBILE_CLIENT' });
        }
        const body = await readJsonBody(req);
        const goalState = useProviderAgent(body) ? await providerAgent.execute(body) : await architect.executeGoal(body);
        return sendJson(res, 200, {
          ok: true,
          executedOnHost: true,
          hostPlatform: process.platform,
          hostWorkspaceDir: architect.workspaceDir,
          goal: goalState,
        });
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      const status = err?.statusCode || 500;
      sendJson(res, status, {
        ok: false,
        error: String(err?.message || 'Internal error'),
        code: err?.code || 'SERVER_ERROR',
      });
    }
  });

  return {
    architect,
    providerAgent,
    schedule,
    heartbeat,
    server,
    getPairingCode: () => currentPairingCode,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      schedule.start();
      if (schedule.ownsLock) await providerAgent.recoverLearning();
      heartbeat.start({ ownsHost: schedule.ownsLock === true });
      heartbeat.observe(providerAgent.getGoalState());
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      schedule.verificationUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/api/v5/schedule`;
      return {
        host,
        port: actualPort,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
      };
    },
    async stop() {
      heartbeat.stop();
      const stoppingSchedule = schedule.stop();
      await providerAgent.close();
      await stoppingSchedule;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
