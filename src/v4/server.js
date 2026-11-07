/**
 * MAJIN V4 — HTTP + SSE server.
 *
 * Loopback by default. Authentication is a signed, server-side session cookie
 * issued by exchanging the host's pairing code; every mutating request also
 * needs the X-MAJIN-CSRF header and a same-origin Origin. Tool execution never
 * happens in a request handler — the agent owns it, behind approvals.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeSupported } from './config.js';
import {
  clearCookie,
  ensureDir,
  ensurePairing,
  loadSecret,
  parseCookies,
  pairingExists,
  SessionStore,
  sessionCookie,
  verifyPairing,
} from './auth.js';
import {
  clientKey,
  HttpError,
  RateLimiter,
  assertCsrfHeader,
  assertHostAllowed,
  assertOriginAllowed,
  readJsonBody,
} from './security.js';
import { ConversationStore, GoalStore, publicGoal } from './store.js';
import { createToolRegistry } from './tools.js';
import { createModelClient } from './model.js';
import { createAgent } from './agent.js';
import { discoverModels, refreshAllCatalogs } from './models.js';
import { publicModelSelection, selectCanonicalModel } from './model-selection.js';
import { Kernel } from './kernel.js';
import { t } from './ui/strings.js';
import { synthesize, transcribe, sttTemplateFromEnv, VOICE_MODES, voiceCapabilities, localNarratorStream } from './voice.js';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { protectAuditFile } from '../v2/audit/permissions.js';
import { TurnJournal } from './turns.js';
import { hostCapabilities, describeCapabilities, registerHostTools } from './tools/host.js';
import { UploadStore, UploadError, serveHeadersFor, typeForName, MAX_UPLOAD_BYTES } from './uploads.js';
import { OwnerMode, OwnerModeError, GRANTABLE_LANES } from './owner-mode.js';
import {
  APPROVAL_POLICIES, ApprovalPolicyError, createPolicyAwareApprovals, readApprovalPolicy,
} from './approval-policy.js';
import { Approvals } from '../v2/safety/approvals.js';
import { planV1Import, applyV1Import } from './import-history.js';
import { discoverSkills, usableSkills, describeSkills } from './skills.js';
import {
  LearnedSkillStore, environmentFingerprint, rankSkills, describeLearned, LEARNING_SCHEMA,
  SKILL_STATES, recallExperiences, originFingerprint, revalidateExternal,
} from './learning.js';
import { parseMcpConfig, connectServers } from './mcp.js';
import { registerMcpTools } from './mcp-tools.js';
import { TelemetryLedger,telemetryRow } from '../v2/telemetry/ledger.js';
import { createBackgroundTasks } from './background-tasks.js';
import { createPushService } from './push.js';
import { runTool } from '../v2/tools/runner.js';
import { createV4Audit } from './audit.js';
import { createV4Heartbeat } from './heartbeat.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/spirit.js': { file: 'spirit.js', type: 'text/javascript; charset=utf-8' },
  '/voice.js': { file: 'voice.js', type: 'text/javascript; charset=utf-8' },
  '/recorder.js': { file: 'recorder.js', type: 'text/javascript; charset=utf-8' },
  '/strings.js': { file: 'strings.js', type: 'text/javascript; charset=utf-8' },
  '/session.js': { file: 'session.js', type: 'text/javascript; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png' },
  '/icons/maskable-512.png': { file: 'icons/maskable-512.png', type: 'image/png' },
};

function securityHeaders({ frameAncestors }) {
  const headers = {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "media-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
    'cache-control': 'no-store',
  };
  if (frameAncestors === "'none'") headers['x-frame-options'] = 'DENY';
  return headers;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function fail(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

function isSecureRequest(req, config) {
  if (req.socket?.encrypted) return true;
  if (config.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') return true;
  }
  return Boolean(config.publicOrigin && config.publicOrigin.startsWith('https://'));
}

export function createV4Server({ config }) {
  assertNodeSupported();
  const paths = config.paths;
  ensureDir(paths.root);
  ensureDir(paths.conversations);
  ensureDir(paths.goals);
  ensureDir(paths.memory);
  const workspaceDir = path.join(paths.workspace);
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  const secret = loadSecret(paths.secret);
  const pairingFresh = ensurePairing(paths.pairing, secret);
  const sessions = new SessionStore({
    file: paths.serverState,
    secret,
    ttlMs: config.auth.sessionTtlMs,
  });

  const conversations = new ConversationStore({
    dir: paths.conversations,
    maxMessages: config.limits.maxStoredMessages,
  });
  const audit=createV4Audit({root:paths.root,workspace:workspaceDir});
  const goals = new GoalStore({ dir: paths.goals,onSave:goal=>audit.recordGoal(goal) });
  // Reconciled goals are reported by the doctor and the boot banner; the
  // pending approvals they orphan are cleared with the same call.
  const reconciled = goals.reconcileOnBoot({ conversations });

  // Uploads go INTO the workspace, so the agent reads them with the tools it
  // already has and the phone sees the same file the model saw.
  const uploads = new UploadStore({ dir: workspaceDir });

  let hostCaps = null;
  let hostTools = { registered: [], skipped: [] };
  const forcedLanes = config.platform?.hostTools ? ['*'] : [];
  // Owner Mode exists before the tools do: the filesystem tools must ask it
  // which folders are granted on every single call.
  const ownerMode = new OwnerMode({
    file: path.join(paths.root, 'owner-mode.json'),
    forceLanes: forcedLanes.includes('*') ? [...GRANTABLE_LANES] : [],
  });
  const grantedFolders = () => ownerMode.folders();

  const tools = createToolRegistry({
    workspaceDir,
    memoryDir: paths.memory,
    allowedRoots: grantedFolders,
  });
  const model = createModelClient(config, { workspaceDir });
  // Structured, privacy-preserving telemetry: V2's ledger keeps a fixed field
  // allowlist per event, so message text, paths and secrets cannot land in it.
  const telemetry = (() => {
    let ledger=null;
    try{ledger=new TelemetryLedger(path.join(paths.root,'telemetry'));}catch{/* optional analytics can be unavailable */}
    return {append(event,payload){
      const row=telemetryRow(event,payload);
      audit.recordTelemetry(row); // Mandatory integrity storage uses same serializer.
      try{ledger?.append(event,row);}catch{/* analytics failure cannot erase audit or break execution */}
      return row;
    }};
  })();
  // Skills are data on disk. What is *usable* depends on what the owner granted,
  // so the set is recomputed on every turn rather than cached at boot.
  const skillsDir = config.platform?.skillsDir || path.join(paths.root, 'skills');
  const shippedSkillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
  // Learned skills are data, not code: they live beside the other V4 data and
  // are loaded by the same loader as hand-written ones.
  const learnedDir = path.join(paths.root, 'learned-skills');

  /** The environment a skill was validated in, recomputed per call. */
  function fingerprintNow() {
    return environmentFingerprint({
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      lanes: ownerMode.activeLanes(),
      tools: tools.registry.list().map((t) => t.name),
    });
  }

  const learnedStore = new LearnedSkillStore({ dir: learnedDir, fingerprint: fingerprintNow() });

  /** Is this learned skill's required lane/tool set available right now? */
  function usableNow(skill) {
    const granted = new Set(ownerMode.activeLanes());
    const names = new Set(tools.registry.list().map((t) => t.name));
    const lanesOk = (skill.requires || []).every((lane) => granted.has(lane) || lane === 'workspace');
    const toolsOk = (skill.tools || []).every((tool) => names.has(tool));
    return lanesOk && toolsOk;
  }

  function skillsNow() {
    const shipped = discoverSkills(shippedSkillsDir);
    const custom = discoverSkills(skillsDir);
    const learned = discoverSkills(learnedDir);
    const handWritten = [...shipped.skills, ...custom.skills];
    const all = [...handWritten, ...learned.skills];
    const errors = [...shipped.errors, ...custom.errors, ...learned.errors];
    const grantedLanes = ownerMode.activeLanes();
    const availableTools = tools.registry.list().map((t) => t.name);
    // Learned procedures are filtered by the same rules as hand-written ones:
    // a skill whose required lane was revoked is not offered.
    const picked = usableSkills({ skills: handWritten, grantedLanes, availableTools });
    const learnedUsable = usableSkills({
      skills: learned.skills,
      grantedLanes,
      availableTools,
      limit: 50,
      // Their own state is rendered to the model, so EXPERIMENTAL is offered
      // with the caveat instead of being silently dropped.
      includeExperimental: true,
    }).usable;
    return { all, handWritten, learned: learned.skills, learnedUsable, errors, grantedLanes, availableTools, ...picked };
  }
  const skillsBridge = { usable: () => skillsNow().usable };

  /**
   * The learning bridge the agent talks to.
   *
   * `retrieve` is the only read path, and it is availability-filtered: a learned
   * skill that needs a lane the owner has not granted is not offered, exactly
   * like a hand-written one.
   */
  const learningBridge = {
    retrieve(query) {
      const view = skillsNow();
      return rankSkills(view.learnedUsable, { goalText: String(query || ''), limit: 4 });
    },
    /**
     * Workflow step 1, second half: what happened on earlier tasks of the same
     * kind. The goal store already holds every past objective, state and receipt,
     * so this reads it rather than keeping a parallel log.
     */
    recall(query) {
      try {
        return recallExperiences({ goals: goals.list(), goalText: String(query || ''), limit: 3 });
      } catch {
        return [];
      }
    },
    async observe({ goal, trace, conversationId, message, external = [] }) {
      // Fingerprint the origins this turn used, once each and bounded, so a later
      // revalidation can tell whether the site still serves what it did. Awaited
      // on purpose: a stored skill must carry the check it was validated against,
      // not a race that may or may not have finished.
      const externalChecks = [];
      for (const origin of (Array.isArray(external) ? external : []).slice(0, 3)) {
        externalChecks.push(await originFingerprint(origin));
      }
      const before = new Set(learnedStore.list().map((s) => `${s.name}:${s.learned.state}`));
      const result = learnedStore.observe({
        goal,
        trace,
        registry: tools.registry,
        // The lane map lives on the host registration, not on the V2 definition.
        laneFor: (name) => hostTools.registered.find((r) => r.name === name)?.lane || null,
        grantedLanes: ownerMode.activeLanes(),
        external,
        externalChecks,
      });
      if (result.learning) {
        const after = learnedStore.list().find((s) => s.name === result.name);
        if (after) result.state = after.learned.state;
        try {
          telemetry.append('task.result', {
            action: `learning:${result.action}`,
            taskId: result.name,
            result: 'success',
          });
        } catch { /* telemetry must never fail a turn */ }
        void before;
      }
      void conversationId;
      void message;
      return result;
    },
    observeFailure({ skills, trace }) {
      const out = learnedStore.observeFailure({ skills, trace });
      for (const item of out) {
        try {
          telemetry.append('task.result', {
            action: `learning:${item.state === SKILL_STATES.STALE ? 'stale' : 'failure'}`,
            taskId: item.name,
            result: 'success',
          });
        } catch { /* telemetry must never fail a turn */ }
      }
      return out;
    },
    revalidate() {
      return learnedStore.revalidate();
    },
    /**
     * Re-check the sites and APIs the learned procedures depend on.
     * Bounded: at most three origins per skill, one request each, no retries.
     */
    async revalidateExternal() {
      const transitions = await revalidateExternal(learnedStore.list());
      for (const t of transitions) {
        if (!t.changed) continue;
        const skill = learnedStore.get(t.name);
        if (!skill) continue;
        skill.learned.state = SKILL_STATES.STALE;
        skill.learned.staleReason = `external resource changed: ${t.origin}`;
        skill.learned.staleSince = new Date().toISOString();
        learnedStore.persist(skill);
      }
      return transitions;
    },
    store: learnedStore,
  };

  /**
   * Approval policy: `ask` or full trust (`auto`).
   *
   * The stored decision wins over the environment, so a toggle from the phone
   * survives a restart. `MAJIN_V4_APPROVAL_POLICY=auto` lets the owner start in
   * full trust from the setup command without opening the app first.
   */
  const approvalFile = path.join(paths.root, 'approvals.json');
  const envPolicy = String(process.env.MAJIN_V4_APPROVAL_POLICY || '').toLowerCase();
  const initialPolicy = readApprovalPolicy(approvalFile, {
    fallback: envPolicy === APPROVAL_POLICIES.AUTO ? APPROVAL_POLICIES.AUTO : APPROVAL_POLICIES.ASK,
  });
  const approvalsLayer = createPolicyAwareApprovals({
    approvals: new Approvals({ emit: () => {} }),
    policyFile: approvalFile,
    fallback: initialPolicy,
    onAutoApprove: ({ scope }) => {
      // "No prompts" must never mean "no record".
      try {
        audit.recordTelemetry({ event: 'consent', scope, decision: 'auto', mode: 'auto', at: new Date().toISOString() });
      } catch { /* audit failures are reported elsewhere, never here */ }
      try {
        telemetry.append('consent', { scope, decision: 'used', mode: 'auto' });
      } catch { /* optional analytics */ }
    },
  });

  const agent = createAgent({
    config,
    conversations,
    goals,
    tools,
    model,
    telemetry,
    audit,
    approvals: approvalsLayer,
    skills: skillsBridge,
    learning: learningBridge,
    // The model is told where it may look. Without this it only ever tried the
    // workspace, which is why a granted folder was never searched.
    access: () => ({
      workspace: workspaceDir,
      folders: grantedFolders(),
      lanes: ownerMode.activeLanes(),
    }),
  });
  // Mobile connections drop. The journal lets a phone reattach to a turn that
  // kept running instead of losing the work.
  const journal = new TurnJournal();

  // Host capability detection runs at boot: what this machine can actually do,
  // decided by asking, never by assuming. Which lanes are ACTIVE is the owner's
  // decision, persisted in owner-mode.json and changeable from the phone.
  /**
   * Register exactly the lanes the owner currently allows. Called at boot and
   * again after every grant or revoke, so a revocation from the phone takes
   * effect without a restart.
   */
  async function refreshHostTools() {
    if (!hostCaps) {
      try {
        hostCaps = await hostCapabilities();
      } catch (err) {
        hostCaps = { platform: process.platform, error: String(err?.message || err), lanes: {} };
        return;
      }
    }
    const active = ownerMode.activeLanes();
    const registered = [];
    const skipped = [];

    // 1. remove host tools that are no longer allowed
    for (const entry of hostTools.registered) {
      if (!active.includes(entry.lane)) {
        tools.registry.tools.delete(entry.name);
        skipped.push({ lane: entry.lane, tool: entry.name, reason: 'lane is not granted' });
      }
    }
    const stillThere = hostTools.registered.filter((e) => active.includes(e.lane));

    // 2. register the lanes that are allowed and not already present
    const allowed = {};
    for (const [lane, cap] of Object.entries(hostCaps.lanes || {})) {
      allowed[lane] = active.includes(lane) ? cap : { ...cap, available: false, reason: 'not granted by the owner' };
    }
    const partial = registerHostTools(tools.registry, { ...hostCaps, lanes: allowed }, {
      allow: config.platform?.hostToolAllow?.length ? config.platform.hostToolAllow : null,
      workspaceDir: config.workspaceDir,
      cfg: config.channelConfig,
      // V1 tools that need the data dir ask their config for the file path;
      // give them V4's, never V1's, so the two never diverge.
      dataFile: path.join(paths.root, 'config.json'),
      // Nested V1 tool calls (research -> web.search, flows -> any tool) go
      // through the same approval policy as a direct call.
      approvals: agent.approvals,
      session: 'v4',
      // The V1 filesystem lane may touch the workspace plus exactly the folders
      // the owner granted — enforced per call, not just recorded.
      folders: grantedFolders,
    });
    for (const r of partial.registered) {
      if (!stillThere.some((e) => e.name === r.name)) stillThere.push(r);
    }
    skipped.push(...partial.skipped.filter((s) => s.reason !== 'not granted by the owner'));
    // anything not granted still gets a line, but one per lane rather than per tool
    for (const [lane, cap] of Object.entries(hostCaps.lanes || {})) {
      if (!active.includes(lane)) skipped.push({ lane, reason: 'not granted by the owner' });
    }

    // Delegation, standing teams and dependency graphs are V4 engine tools, not
    // V1 modules: they follow the `agent` lane so revoking the lane revokes the
    // capability immediately.
    const engineTools = [agent.delegationTool, ...(agent.orchestrationTools || [])];
    for (const tool of engineTools) {
      if (active.includes('agent')) {
        if (!tools.registry.get(tool.name)) tools.registry.define(tool);
      } else if (tools.registry.get(tool.name)) {
        tools.registry.tools.delete(tool.name);
      }
    }

    hostTools = { registered: stillThere, skipped };
    await refreshMcp();
  }

  const hostReady = refreshHostTools();

  /**
   * MCP servers, loaded from `<data>/v4/mcp.json` when the owner grants the `mcp`
   * lane. Config comes from a file the owner wrote; a model can never name a
   * command to launch.
   */
  const mcpState = { connected: [], failed: [], configErrors: [] };
  async function refreshMcp() {
    for (const entry of mcpState.connected) entry.server.stop();
    for (const entry of tools.registry.list()) {
      if (entry.name.startsWith('mcp_')) tools.registry.tools.delete(entry.name);
    }
    mcpState.connected = [];
    mcpState.failed = [];
    mcpState.configErrors = [];

    if (!ownerMode.activeLanes().includes('mcp')) {
      mcpState.configErrors.push({ name: '-', error: 'the mcp lane is not granted' });
      return;
    }
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(paths.root, 'mcp.json'), 'utf8'));
    } catch {
      mcpState.configErrors.push({ name: '-', error: `no readable mcp.json in ${paths.root}` });
      return;
    }
    const parsed = parseMcpConfig(raw);
    mcpState.configErrors.push(...parsed.errors);
    const { connected, failed } = await connectServers(parsed.servers);
    mcpState.failed.push(...failed);
    for (const entry of connected) {
      const { registered, skipped } = registerMcpTools(tools.registry, entry.server.name, entry.tools, { server: entry.server });
      entry.registered = registered;
      entry.skipped = skipped;
      mcpState.connected.push(entry);
    }
  }

  function mcpView() {
    return {
      connected: mcpState.connected.map((e) => ({
        name: e.server.name,
        tools: e.registered?.map((r) => r.name) || [],
        skipped: e.skipped || [],
        serverInfo: e.server.serverInfo,
      })),
      failed: mcpState.failed,
      configErrors: mcpState.configErrors,
      configPath: path.join(paths.root, 'mcp.json'),
    };
  }

  const kernel = new Kernel({
    features: config.platform?.features || {},
    pluginsEnabled: config.platform?.pluginsEnabled || false,
    allowlist: config.platform?.pluginAllowlist || [],
    isolate: config.platform?.pluginIsolate !== false,
    quarantineDir: config.platform?.pluginQuarantineDir || null,
  });
  // Plugin tools join the same registry the built-ins use, so they inherit
  // schema validation, approval policy and receipts. A plugin that cannot be
  // expressed as a ToolDefinition is reported as failed, never half-wired.
  const kernelReady = kernel.loadPlugins(config.platform?.pluginsDir || paths.plugins).then((results) => {
    for (const cap of kernel.list().filter((c) => c.kind === 'tool')) {
      const impl = kernel.get('tool', cap.name);
      if (!impl?.inputSchema || !impl?.outputSchema) continue;
      try {
        tools.registry.define({
          name: cap.name,
          description: impl.description || `plugin tool ${cap.name}`,
          tier: impl.tier || 'read',
          inputSchema: impl.inputSchema,
          outputSchema: impl.outputSchema,
          execute: impl.execute,
        });
      } catch { /* registry validation is the source of truth; failure is visible in /api/kernel */ }
    }
    return results;
  });

  // A turn named in a query string must belong to this process.
  const limiter = new RateLimiter({
    windowMs: config.limits.rate.windowMs,
    limits: {
      general: config.limits.rate.requests,
      turns: config.limits.rate.turns,
      pairing: config.limits.rate.pairing,
    },
  });

  function sessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.auth.cookieName];
    const session = sessions.verify(token);
    return { token, session };
  }

  function requireSession(req) {
    const { token, session } = sessionFromRequest(req);
    if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Pair this device first.');
    sessions.touch(session);
    return { token, session };
  }

  async function handlePair(req, res) {
    const key = clientKey(req, config);
    limiter.take('pairing', key);
    const body = await readJsonBody(req, 4096);
    const ok = verifyPairing(paths.pairing, secret, String(body.code || ''));
    if (!ok) throw new HttpError(401, 'PAIRING_REJECTED', 'That pairing code is not valid.');
    const { token, session } = sessions.create({ ip: key, userAgent: req.headers['user-agent'] });
    const secure = isSecureRequest(req, config);
    res.setHeader('set-cookie', sessionCookie(config.auth.cookieName, token, {
      secure,
      maxAgeSeconds: Math.floor(config.auth.sessionTtlMs / 1000),
    }));
    sendJson(res, 200, { ok: true, session: { id: `${session.id.slice(0, 6)}…`, expiresAt: new Date(session.expiresAt).toISOString() } });
  }

  function serveStatic(req, res, entry) {
    const file = path.join(UI_DIR, entry.file);
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      fail(res, 404, 'NOT_FOUND', 'Asset not found.');
      return;
    }
    const headers = {
      'content-type': entry.type,
      'cache-control': entry.file === 'sw.js' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };
    if (entry.file === 'sw.js') headers['service-worker-allowed'] = '/';
    res.writeHead(200, headers);
    res.end(body);
  }

  /**
   * Stream a journal turn to an HTTP response. `from` is the last sequence the
   * client already holds, so a reconnect receives only what it missed.
   */
  function pipeTurn(res, turn, { from = 0 } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-majin-turn': turn.id,
    });
    res.write(': connected\n\n');
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const unsubscribe = journal.subscribe(turn, from, (event) => {
      if (closed || res.writableEnded) return;
      if (event.type === '__done') {
        close();
        return;
      }
      try {
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch {
        close();
      }
    });
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
    return { close, turnId: turn.id };
  }

  function startSse(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    const send = (event, data) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    const close = () => {
      closed = true;
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });
    return { send, close };
  }

  async function handleChat(req, res, session) {
    const key = clientKey(req, config);
    limiter.take('turns', key);
    const body = await readJsonBody(req, config.limits.maxBodyBytes);
    const conversationId = body.conversationId ? String(body.conversationId) : null;
    const text = String(body.text ?? '');
    const requestId = body.requestId ? String(body.requestId).slice(0, 80) : null;
    if (!text.trim()) throw new HttpError(400, 'EMPTY_MESSAGE', 'Message is empty.');
    if (text.length > config.limits.maxMessageChars) {
      throw new HttpError(413, 'MESSAGE_TOO_LONG', 'Message is too long.');
    }

    const {turn,finished}=startJournalTurn({conversationId,text,requestId,voiceTurn:body.voiceTurn===true,owner:session.id});
    pipeTurn(res,turn,{from:0});
    await finished;
  }

  function startJournalTurn({conversationId=null,text,requestId=null,voiceTurn=false,owner=null}){
    audit.assertHealthy();
    // The turn becomes a journal entry before the response is written, so the
    // client learns its id (in the `open` event) and can reattach to the very
    // same turn if the connection drops.
    const turn = journal.create({ conversationId: conversationId || 'new' });
    // The abort key must be unique per turn. Keying a *first* message by the
    // literal 'new' meant a second device's first message cancelled the first
    // device's turn. A known conversation still supersedes its own old turn.
    const turnKey = conversationId ? `conv:${conversationId}` : `turn:${turn.id}`;
    const controller = agent.beginTurn(turnKey, { owner });
    journal.append(turn, 'open', {
      at: new Date().toISOString(),
      model: agent.modelInfo,
      turnId: turn.id,
    });

    // Run the agent independently of the response: a dropped socket must not
    // throw away work the user already paid for.
    const finished = agent.runTurn({
      conversationId,
      text,
      voiceTurn,
      requestId,
      signal: controller.signal,
      emit: (type, data) => {journal.append(turn,type,data);heartbeat.observe(type,data,conversationId);},
    }).then((result) => {
      journal.finish(turn, result?.status || 'completed');
      return result;
    }).catch((err) => {
      journal.append(turn, 'error', { message: err?.message || 'turn failed' });
      heartbeat.observe('done',{status:'failed',conversationId});
      journal.finish(turn, 'failed');
      return { status: 'failed' };
    }).finally(() => {
      agent.endTurn(turnKey, controller);
    });

    return {turn,finished,cancel:()=>controller.abort()};
  }

  const notifications=createPushService({root:paths.root,subject:config.publicOrigin,audit});
  const backgroundTasks=createBackgroundTasks({root:paths.root,conversations,startTurn:startJournalTurn,notifications,audit,ready:Promise.all([hostReady,kernelReady]),readSource:async(url)=>{
    const result=await runTool({tool:'web_fetch',input:{url,extract:'json',maxChars:1000000}},{registry:tools.registry,approvals:agent.approvals,timeoutMs:30000});
    if(!result.ok||result.data?.meta?.truncated)throw Error('Source response failed or was incomplete');
    const text=result.data?.result;
    if(typeof text!=='string'||!text.includes('\n\n'))throw Error('Source returned no JSON document');
    return JSON.parse(text.slice(text.indexOf('\n\n')+2));
  }});
  for(const tool of backgroundTasks.tools)tools.registry.define(tool);
  const heartbeat=createV4Heartbeat({root:paths.root,conversations,notifications,audit});

  const routes = {
    'GET /api/heartbeat':async(req,res)=>{requireSession(req);sendJson(res,200,{ok:true,...heartbeat.view()});},
    'POST /api/heartbeat':async(req,res)=>{
      requireSession(req);assertCsrfHeader(req);limiter.take('general',clientKey(req,config));
      const body=await readJsonBody(req,4096);
      try{sendJson(res,200,{ok:true,result:await heartbeat.manage(body)});}catch(error){throw new HttpError(400,'HEARTBEAT_ACTION',error.message);}
    },
    'GET /api/audit':async(req,res)=>{requireSession(req);sendJson(res,200,audit.status());},
    'POST /api/audit':async(req,res)=>{
      requireSession(req);assertCsrfHeader(req);limiter.take('general',clientKey(req,config));
      const body=await readJsonBody(req,4096);
      if(body.action==='initialize'||body.action==='anchor')sendJson(res,200,{ok:true,anchor:audit.checkpoint({initialize:body.action==='initialize'})});
      else if(body.action==='export')sendJson(res,200,{ok:true,...audit.exportPublic()});
      else throw new HttpError(400,'AUDIT_ACTION','Unknown audit action');
    },
    'GET /api/push':async(req,res)=>{requireSession(req);sendJson(res,200,{ok:true,...notifications.view()});},
    'POST /api/push':async(req,res)=>{
      const {session}=requireSession(req);assertCsrfHeader(req);limiter.take('general',clientKey(req,config));
      const body=await readJsonBody(req,16384);
      try{
        if(body.action==='subscribe')sendJson(res,200,{ok:true,...notifications.subscribe(body.subscription,session.id)});
        else if(body.action==='unsubscribe'){notifications.unsubscribe(String(body.endpoint||''),session.id);sendJson(res,200,{ok:true});}
        else if(body.action==='test'){
          const conv=conversations.create({title:'Notification test',titlePolicy:'manual'});
          const id=`test:${crypto.randomUUID()}`;
          notifications.enqueue({id,conversationId:conv.id});await notifications.flush();sendJson(res,200,{ok:true,id,note:'Push-service acceptance is not physical device receipt.'});
        }else throw Error('Unknown notification action');
      }catch(error){throw new HttpError(400,'PUSH_ACTION',error.message);}
    },
    'GET /api/tasks': async(req,res)=>{
      requireSession(req);sendJson(res,200,{ok:true,tasks:backgroundTasks.list()});
    },
    'POST /api/tasks': async(req,res)=>{
      requireSession(req);assertCsrfHeader(req);limiter.take('general',clientKey(req,config));
      const body=await readJsonBody(req,config.limits.maxBodyBytes);
      try{sendJson(res,200,{ok:true,task:await backgroundTasks.manage(body)});}catch(error){throw new HttpError(400,'TASK_ACTION',error.message);}
    },
    'GET /api/health': async (req, res) => {
      sendJson(res, 200, {
        ok: true,
        app: 'majin',
        version: config.version,
        ready: true,
        setupRequired: !pairingExists(paths.pairing),
        time: new Date().toISOString(),
      });
    },

    'GET /api/me': async (req, res) => {
      const { session } = sessionFromRequest(req);
      if (!session) {
        sendJson(res, 200, { ok: true, authenticated: false });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        authenticated: true,
        session: { createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString() },
      });
    },

    'POST /api/auth/pair': handlePair,

    'POST /api/auth/logout': async (req, res) => {
      const { token, session } = sessionFromRequest(req);
      if (session) agent.cancelOwnedBy(session.id);
      if (token) sessions.revokeByToken(token);
      res.setHeader('set-cookie', clearCookie(config.auth.cookieName, { secure: isSecureRequest(req, config) }));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/voice/transcribe': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      limiter.take('general', clientKey(req, config));
      const command = sttTemplateFromEnv();
      if (!command) throw new HttpError(503, 'STT_NOT_CONFIGURED', 'Server speech recognition is not configured.');
      if (routes.sttBusy) throw new HttpError(429, 'STT_BUSY', 'Speech recognition is busy; try again.');
      routes.sttBusy = true;
      let dir;
      try {
        const body = await readJsonBody(req, 6 * 1024 * 1024);
        const type = String(body.type || '').split(';')[0].trim().toLowerCase();
        const extensions = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
        if (!extensions[type]) throw new HttpError(415, 'AUDIO_TYPE', 'Use MP4/AAC, WebM, Ogg or WAV audio.');
        if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new HttpError(400, 'AUDIO_DATA', 'Invalid base64 audio.');
        const audio = Buffer.from(body.data, 'base64');
        if (!audio.length || audio.length > 4 * 1024 * 1024) throw new HttpError(413, 'AUDIO_SIZE', 'Audio must be between 1 byte and 4 MiB.');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-stt-'));
        protectAuditFile(dir);
        const file = path.join(dir, `capture.${extensions[type]}`);
        fs.writeFileSync(file, audio, { mode: 0o600, flag: 'wx' });
        const result = await transcribe({ audioPath: file, command });
        // Never expose a local path/command, or call a fixture a real recognizer.
        sendJson(res, result.ok ? 200 : 422, {
          ok: result.ok, transcript: result.transcript, language: result.language, provider: result.provider,
          synthetic: result.synthetic === true, elapsedMs: result.elapsedMs,
          ...(!result.ok ? { error: { code: result.errorClass || 'NO_SPEECH', message: 'No speech could be transcribed. Try again.' } } : {}),
        });
      } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        routes.sttBusy = false;
      }
    },

    'POST /api/voice/speak': async (req, res) => {
      const { session } = requireSession(req);
      assertCsrfHeader(req);
      void session;
      limiter.take('turns', clientKey(req, config));
      const body = await readJsonBody(req, 16 * 1024);
      const text = String(body.text || '').trim();
      if (!text) throw new HttpError(400, 'EMPTY_TEXT', 'text is required.');
      if (text.length > 1500) throw new HttpError(413, 'TEXT_TOO_LONG', 'text is limited to 1500 characters.');
      if (body.stream === true) {
        if (!voiceCapabilities().streamingTts.available) throw new HttpError(503, 'VOICE_STREAM_DISABLED', 'Streaming narrator is not configured.');
        if (text.length > 700) throw new HttpError(413, 'TEXT_TOO_LONG', 'Streaming text is limited to 700 characters.');
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', disconnected);
        try {
          const upstream = await localNarratorStream({ text, signal: controller.signal });
          res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-majin-tts-provider': 'kokoro-onnx', 'x-majin-tts-synthetic': 'false' });
          await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
        } finally { controller.abort(); res.off('close', disconnected); }
        return;
      }
      const mode = VOICE_MODES.includes(body.mode) ? body.mode : 'auto';
      const result = await synthesize({
        text,
        mode,
        voice: body.voice ? String(body.voice).slice(0, 64) : null,
        approvals: agent.approvals,
        dir: path.join(paths.root, 'voice'),
      });

      if (!result.ok) {
        const status = result.pendingConsent ? 409 : 502;
        sendJson(res, status, {
          ok: false,
          provider: result.provider,
          error: {
            code: result.pendingConsent ? 'CONSENT_REQUIRED' : (result.errorClass || 'tts_failed'),
            message: result.pendingConsent
              ? 'External voice synthesis needs a consent record for scope voice:external.'
              : (result.message || 'speech synthesis failed'),
          },
        });
        return;
      }

      const audio = fs.readFileSync(result.audioPath);
      try {
        fs.unlinkSync(result.audioPath);
      } catch { /* temp file cleanup is best effort */ }
      res.writeHead(200, {
        'content-type': result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        'cache-control': 'no-store',
        'x-majin-tts-provider': result.provider,
        'x-majin-tts-verified': String(result.verified),
        'x-majin-tts-synthetic': String(result.synthetic),
        'content-length': String(audio.length),
      });
      res.end(audio);
    },

    'GET /api/voice': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, {
        ok: true,
        modes: VOICE_MODES,
        default: 'auto',
        // The browser engine is what the phone actually uses today.
        clientEngine: 'SpeechSynthesis + MediaRecorder/server STT (iOS), SpeechRecognition fallback',
        serverSide: {
          ...voiceCapabilities(),
          note: 'Buffer is a deterministic offline provider that proves the pipeline, not a voice.',
        },
      });
    },

    'GET /api/uploads': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, { ok: true, uploads: uploads.list(), maxBytes: MAX_UPLOAD_BYTES });
    },

    'POST /api/upload': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      limiter.take('general', clientKey(req, config));
      const body = await readJsonBody(req, MAX_UPLOAD_BYTES * 2);
      try {
        const stored = uploads.save({ name: body.name, type: body.type, data: body.data });
        sendJson(res, 201, { ok: true, upload: stored });
      } catch (err) {
        if (err instanceof UploadError) throw new HttpError(err.status, err.code, err.message);
        throw err;
      }
    },

    'DELETE /api/uploads': async (req, res, url) => {
      requireSession(req);
      assertCsrfHeader(req);
      const name = String(url.searchParams.get('name') || '');
      const found = uploads.resolve(name);
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'No such file.');
      try {
        fs.unlinkSync(found.path);
      } catch {
        throw new HttpError(500, 'DELETE_FAILED', 'The file could not be removed.');
      }
      sendJson(res, 200, { ok: true, removed: found.name });
    },

    'GET /api/mcp': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, { ok: true, mcp: mcpView() });
    },

    'GET /api/teams': async (req, res, url) => {
      requireSession(req);
      const name = url.searchParams.get('team');
      try {
        const { describeTeam } = await import('./teams.js');
        const { TeamStore } = await import('../core/teams.js');
        if (!name) {
          const store = new TeamStore({ workspaceDir: config.workspaceDir });
          sendJson(res, 200, { ok: true, teams: store.listTeams() });
          return;
        }
        sendJson(res, 200, { ok: true, ...describeTeam({ workspaceDir: config.workspaceDir, team: name }) });
      } catch (err) {
        throw new HttpError(400, 'TEAM_ERROR', String(err?.message || err));
      }
    },

    /**
     * What MAJIN has learned, with the evidence behind each procedure.
     * Read-only: promotion happens in the agent, from verified execution.
     */
    /**
     * Approval policy: `ask` (a held tool waits) or `auto` (full trust).
     *
     * GET is what the app shows. POST is the owner's decision, and it takes
     * effect on the next tool call rather than at the next boot.
     */
    'GET /api/approvals': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, {
        ok: true,
        policy: approvalsLayer.policy,
        policies: Object.values(APPROVAL_POLICIES),
        note: approvalsLayer.policy === APPROVAL_POLICIES.AUTO
          ? 'Full trust: every tool in a granted lane runs without a prompt. Each call is still audited.'
          : 'Held tools wait for your approval.',
      });
    },

    'POST /api/approvals': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096);
      const wanted = String(body.policy || '').toLowerCase();
      try {
        const saved = approvalsLayer.set(wanted);
        sendJson(res, 200, {
          ok: true,
          policy: saved,
          note: saved === APPROVAL_POLICIES.AUTO
            ? 'Full trust is on. MAJIN will not ask before using a tool you have granted.'
            : 'MAJIN will ask before a held tool runs.',
        });
      } catch (err) {
        if (err instanceof ApprovalPolicyError) throw new HttpError(400, err.code, err.message);
        throw err;
      }
    },

    'GET /api/learning': async (req, res, url) => {
      requireSession(req);
      // The host registers its lanes asynchronously; asking before that finishes
      // would report every learned skill as "unavailable".
      await hostReady;
      // Comparison with the current environment is cheap and makes STALE visible
      // immediately after a tool or lane change.
      const transitions = url.searchParams.get('revalidate') === '1' ? learnedStore.revalidate() : [];
      const skills = learnedStore.list();
      sendJson(res, 200, {
        ok: true,
        schema: LEARNING_SCHEMA,
        environment: fingerprintNow(),
        transitions,
        skills: describeLearned(skills.filter((s) => usableNow(s))),
        // Skills that exist but are not offered, with the reason.
        withheld: skills.filter((s) => !usableNow(s)).map((s) => ({
          name: s.name,
          state: s.learned.state,
          reason: 'its required lanes or tools are not available right now',
        })),
        note: 'A skill is only created from a goal that completed with an independently verified receipt.',
      });
    },

    /**
     * Re-check the sites and APIs learned procedures depend on.
     * Explicit POST: it makes bounded outbound requests, so it is never a side
     * effect of a GET.
     */
    'POST /api/learning/revalidate': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const transitions = await learningBridge.revalidateExternal();
      sendJson(res, 200, { ok: true, checked: transitions.length, transitions });
    },

    'GET /api/skills': async (req, res) => {
      requireSession(req);
      const view = skillsNow();
      sendJson(res, 200, {
        ok: true,
        ...describeSkills({
          skills: view.all,
          errors: view.errors,
          grantedLanes: view.grantedLanes,
          availableTools: view.availableTools,
        }),
        usable: view.usable.map((s) => s.name),
      });
    },

    'GET /api/owner-mode': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, { ok: true, ownerMode: ownerMode.view() });
    },

    'POST /api/owner-mode': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 8192);
      try {
        let view;
        if (body.action === 'grant') {
          view = ownerMode.grant({
            lanes: Array.isArray(body.lanes) ? body.lanes : [],
            folders: Array.isArray(body.folders) ? body.folders : [],
            reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
          });
        } else if (body.action === 'revoke') {
          view = ownerMode.revoke({
            lanes: Array.isArray(body.lanes) ? body.lanes : null,
            folders: Array.isArray(body.folders) ? body.folders : null,
            reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
          });
        } else {
          throw new HttpError(400, 'UNKNOWN_ACTION', 'action must be "grant" or "revoke"');
        }
        // A permission change must take effect on the next call, not the next boot.
        await refreshHostTools();
        const active = ownerMode.activeLanes();
        sendJson(res, 200, {
          ok: true,
          ownerMode: view,
          enabled: active.length > 0,
          registered: hostTools.registered.length,
        });
      } catch (err) {
        if (err instanceof OwnerModeError) throw new HttpError(err.status, err.code, err.message);
        throw err;
      }
    },

    'GET /api/capabilities': async (req, res) => {
      requireSession(req);
      await hostReady;
      sendJson(res, 200, {
        ok: true,
        host: hostCaps ? describeCapabilities(hostCaps) : { platform: process.platform, lanes: {} },
        ownerMode: ownerMode.view(),
        mcp: mcpView(),
        tools: {
          enabled: ownerMode.enabled(),
          registered: hostTools.registered,
          skipped: hostTools.skipped,
        },
        note: 'A tool listed here still refuses at call time if the host changed under it.',
      });
    },

    'GET /api/kernel': async (req, res) => {
      requireSession(req);
      await kernelReady;
      sendJson(res, 200, { ok: true, ...kernel.summary() });
    },

    'GET /api/models': async (req, res, url) => {
      requireSession(req);
      if (url.searchParams.get('refresh') === '1') {
        limiter.take('general', clientKey(req, config), 2);
        // Live discovery uses V1's catalog implementation; failures are
        // reported per provider and never break the listing.
        await refreshAllCatalogs({ home: paths.home, env: process.env });
      }
      const catalogue = discoverModels({ home: paths.home, env: process.env });
      const selection = publicModelSelection({ home: paths.home });
      sendJson(res, 200, {
        ok: true,
        ...catalogue,
        configuredDefault: catalogue.current,
        current: selection.modelId,
        selection,
        // A listed model is not proof of inference; the flag says so.
        caveat: t('model.caveat'),
      });
    },

    'POST /api/model': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096);
      const modelId = body.modelId == null ? null : String(body.modelId);
      const selection = selectCanonicalModel({ home: paths.home, modelId, expectedVersion: body.expectedVersion, authorizePotentialCost: body.authorizePotentialCost, base: config.model });
      sendJson(res, 200, { ok: true, modelId: selection.modelId, selection, info: model.infoFor(selection.modelId) });
    },

    'GET /api/state': async (req, res) => {
      requireSession(req);
      const catalogue = discoverModels({ home: paths.home, env: process.env });
      sendJson(res, 200, {
        ok: true,
        version: config.version,
        model: agent.modelInfo,
        models: {
          count: catalogue.models.length,
          configured: catalogue.models.filter((m) => m.configured).length,
          verified: catalogue.liveVerifiedCount,
          source: catalogue.source,
          current: publicModelSelection({ home: paths.home }).modelId,
        },
        policy: approvalsLayer.policy,
        workspace: { label: 'arbetsyta', files: listWorkspace(tools.root) },
        conversations: conversations.list().slice(0, 30),
        goals: goals.list().slice(-10).reverse(),
        caps: {
          voice: true,
          voiceEngine: 'browser',
          streaming: true,
          // The real registry, not a remembered list: this field used to name
          // five workspace tools long after the host lanes existed.
          tools: tools.registry.list().map((t) => t.name),
          toolCount: tools.registry.list().length,
          folders: ownerMode.folders(),
        },
      });
    },

    'POST /api/chat': async (req, res) => {
      const { session } = requireSession(req);
      assertCsrfHeader(req);
      await handleChat(req, res, session);
    },

    'GET /api/chat/stream': async (req, res, url) => {
      requireSession(req);
      const turnId = String(url.searchParams.get('turnId') || '');
      const from = Number(url.searchParams.get('from') || 0) || 0;
      const turn = journal.get(turnId);
      if (!turn) throw new HttpError(404, 'TURN_NOT_FOUND', 'That turn is no longer buffered.');
      pipeTurn(res, turn, { from });
    },

    'POST /api/cancel': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096);
      // Accept either: the conversation (superseding its current turn) or the
      // turn id from the `open` event, which is the only handle a client has
      // while its very first message is still running.
      const conversationId = body.conversationId ? String(body.conversationId) : '';
      const turnId = body.turnId ? String(body.turnId) : '';
      // `&&`/`||` here would leak '' or '' instead of false; the API promises a boolean.
      let cancelled = false;
      if (turnId) cancelled = agent.cancel(`turn:${turnId}`);
      if (!cancelled && conversationId) cancelled = agent.cancel(`conv:${conversationId}`);
      sendJson(res, 200, { ok: true, cancelled });
    },

    'POST /api/goal/resume': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096);
      const goalId = String(body.goalId || '');
      if (!goalId) throw new HttpError(400, 'GOAL_ID_REQUIRED', 'goalId is required.');
      // The goal does not carry its conversation (the V2 Goal schema is fixed),
      // so resolve it the way the data already allows: the message that
      // references it. Without this the resume left no trace in history.
      const conversationId = body.conversationId
        ? String(body.conversationId)
        : conversations.findByGoal(goalId)?.id || null;

      const sse = startSse(res);
      try {
        const result = await agent.resumeGoal({
          goalId,
          conversationId,
          emit: (type, data) => {sse.send(type,data);heartbeat.observe(type,data,conversationId);},
        });
        sse.send('resume_result', { status: result.status, missing: result.missing || [], results: result.results });
      } catch (err) {
        sse.send('error', { message: err.message || 'resume failed', code: err.code || null });
      } finally {
        sse.close();
      }
    },

    'POST /api/approve': async (req, res) => {
      const { session } = requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096);
      const conversationId = String(body.conversationId || '');
      const sse = startSse(res);
      try {
        await agent.resolveApproval({
          conversationId,
          owner: session.id,
          approve: body.approve === true,
          emit: (type, data) => {sse.send(type,data);heartbeat.observe(type,data,conversationId);},
        });
      } catch (err) {
        sse.send('error', { message: err.message || 'approval failed' });
      } finally {
        sse.close();
      }
    },

    /**
     * The conversation list every device reads.
     *
     *   ?view=active|archived|all   (default active)
     *   ?q=text                     searches titles AND transcript text
     *   ?since=<ISO>                only what changed after this timestamp
     *
     * `deleted` carries tombstones so a second device drops a chat that was
     * deleted elsewhere instead of showing a row that no longer opens.
     */
    'GET /api/conversations': async (req, res, url) => {
      requireSession(req);
      const view = ['active', 'archived', 'all'].includes(url.searchParams.get('view'))
        ? url.searchParams.get('view')
        : 'active';
      const q = String(url.searchParams.get('q') || '').slice(0, 200);
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw && Number.isFinite(Date.parse(sinceRaw)) ? new Date(Date.parse(sinceRaw)).toISOString() : null;
      sendJson(res, 200, {
        ok: true,
        view,
        conversations: conversations.list({ view, q, since }),
        deleted: conversations.tombstones(),
        serverTime: new Date().toISOString(),
      });
    },

    'POST /api/conversations': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 4096).catch(() => ({}));
      const conv = conversations.create({
        title: typeof body.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, 80)
          : 'Ny konversation',
        titlePolicy: typeof body.title === 'string' && body.title.trim() ? 'manual' : 'fallback',
      });
      sendJson(res, 201, { ok: true, conversation: { id: conv.id, title: conv.title, modelId: conv.modelId || null } });
    },

    /** Rename or archive. Archive is reversible; delete is a different route. */
    'PATCH /api/conversations': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 8192);
      const id = String(body.id || '');
      if (!id) throw new HttpError(400, 'ID_REQUIRED', 'id is required.');
      try {
        let conv;
        if (typeof body.title === 'string') {
          conv = conversations.rename(id, body.title);
        } else if (typeof body.archived === 'boolean') {
          conv = conversations.setArchived(id, body.archived);
        } else {
          throw new HttpError(400, 'NOTHING_TO_CHANGE', 'Send title or archived.');
        }
        sendJson(res, 200, {
          ok: true,
          conversation: {
            id: conv.id,
            title: conv.title,
            titlePolicy: conv.titlePolicy,
            archivedAt: conv.archivedAt || null,
            updatedAt: conv.updatedAt,
            version: conv.version,
          },
        });
      } catch (err) {
        if (err?.code === 'INVALID_TITLE') throw new HttpError(400, err.code, err.message);
        if (err?.code === 'NOT_FOUND') throw new HttpError(404, err.code, err.message);
        throw err;
      }
    },

    /**
     * Delete is permanent, so it needs an explicit `confirm`.
     *
     * An active turn is work in progress: deleting under it would let a tool
     * finish and write into a conversation that no longer exists. Unless the
     * caller asks to stop it, the delete is refused with 409 and the number of
     * running turns, so the phone can ask "stop it and delete?".
     */
    'DELETE /api/conversations': async (req, res, url) => {
      requireSession(req);
      assertCsrfHeader(req);
      const id = url.searchParams.get('id') || '';
      if (url.searchParams.get('confirm') !== '1') {
        throw new HttpError(400, 'CONFIRM_REQUIRED', 'Permanent deletion requires confirm=1.');
      }
      const running = agent.isRunning(`conv:${id}`);
      if (running && url.searchParams.get('cancel') !== '1') {
        throw new HttpError(409, 'TURN_RUNNING', 'A task is still running in this conversation. Cancel it and delete, or wait.');
      }
      const cancelled = running ? agent.cancel(`conv:${id}`) : false;
      const removed = conversations.remove(id);
      if (!removed) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found.');
      sendJson(res, 200, { ok: true, removed, cancelled });
    },

    /**
     * Import earlier MAJIN history (V1 transcripts) through the SAME store.
     * Dry run by default: nothing is written until the owner has seen the plan.
     */
    'POST /api/conversations/import': async (req, res) => {
      requireSession(req);
      assertCsrfHeader(req);
      const body = await readJsonBody(req, 8192).catch(() => ({}));
      const source = String(body.source || 'v1');
      if (source !== 'v1') {
        throw new HttpError(400, 'UNKNOWN_SOURCE', 'Only the V1 transcript store can be imported; V2 kept goals and V3 kept a single deliverable, neither has a chat log.');
      }
      const plan = planV1Import({
        sessionsDir: path.join(paths.home, 'sessions'),
        conversations,
      });
      if (plan.error) throw new HttpError(404, 'NO_SOURCE', plan.error);
      if (body.dryRun !== false) {
        sendJson(res, 200, {
          ok: true,
          dryRun: true,
          plan: {
            found: plan.found,
            create: plan.create.map((c) => ({ chatId: c.chatId, title: c.title, messages: c.messages.length, archived: Boolean(c.archivedAt) })),
            merge: plan.merge,
            skip: plan.skip,
            malformed: plan.malformed,
            unreadable: plan.unreadable,
          },
        });
        return;
      }
      const result = applyV1Import({ plan, conversations });
      sendJson(res, 200, { ok: true, dryRun: false, result });
    },

    'GET /api/conversation': async (req, res, url) => {
      requireSession(req);
      const conv = conversations.get(url.searchParams.get('id') || '');
      if (!conv) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found.');
      sendJson(res, 200, {
        ok: true,
        conversation: {
          id: conv.id,
          title: conv.title,
          titlePolicy: conv.titlePolicy || 'fallback',
          archivedAt: conv.archivedAt || null,
          modelId: conv.modelId || null,
          version: conv.version,
          updatedAt: conv.updatedAt,
          messages: conv.messages,
          goals: goalsIn(conv),
          pendingApproval: conv.pendingApproval ? { tool: conv.pendingApproval.tool, scope: conv.pendingApproval.scope } : null,
        },
      });
    },

    'GET /api/goal': async (req, res, url) => {
      requireSession(req);
      const goal = goals.get(url.searchParams.get('id') || '');
      if (!goal) throw new HttpError(404, 'NOT_FOUND', 'Goal not found.');
      sendJson(res, 200, { ok: true, goal: publicGoal(goal) });
    },

    'GET /api/sessions': async (req, res) => {
      requireSession(req);
      sendJson(res, 200, { ok: true, sessions: sessions.list() });
    },
  };

  /** Goal ids referenced by a conversation's messages, with live state. */
  function goalsIn(conv) {
    const ids = [...new Set(conv.messages.map((m) => m.meta?.goalId).filter(Boolean))];
    return ids
      .map((id) => goals.get(id))
      .filter(Boolean)
      .map((g) => ({
        id: g.id,
        state: g.state,
        objective: g.objective,
          // Reuse durable goal receipts for every client. Do not expose raw
          // tool output or inputs just to rebuild the conversation transcript.
          receipts: g.receipts.filter((r) => typeof r.action === 'string' && r.action.startsWith('tool:')).map((r) => ({
            id: r.id, action: r.action, target: r.target, result: r.result,
            verified: r.verified === true, errorClass: r.errorClass || null, at: r.at,
          })),
        ...(g.revisionOf ? { revisionOf: g.revisionOf, revision: g.revision } : {}),
      }));
  }

  function listWorkspace(root) {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).slice(0, 50).map((e) => e.name);
    } catch {
      return [];
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      const hostname = assertHostAllowed(req, config);
      assertOriginAllowed(req, config, hostname);
      res.setHeader('x-majin-version', config.version);
      for (const [k, v] of Object.entries(securityHeaders(config))) res.setHeader(k, v);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        serveStatic(req, res, STATIC[url.pathname]);
        return;
      }

      // Serving a stored file needs a path parameter, which the exact-match
      // route table cannot express. Handled here so the security headers come
      // from one place (serveHeadersFor) and never from a caller's guess.
      if (req.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
        const { session } = sessionFromRequest(req);
        if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Pair this device first.');
        const raw = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
        const found = uploads.resolve(raw);
        if (!found) throw new HttpError(404, 'NOT_FOUND', 'No such file.');
        const type = typeForName(found.name);
        const headers = serveHeadersFor(found.name, type);
        res.writeHead(200, { ...headers, 'content-length': String(found.bytes) });
        fs.createReadStream(found.path).pipe(res);
        return;
      }

      const key = `${req.method} ${url.pathname}`;
      const route = routes[key];
      if (!route) {
        if (url.pathname.startsWith('/api/')) fail(res, 404, 'NOT_FOUND', 'Unknown API route.');
        else fail(res, 404, 'NOT_FOUND', 'Not found.');
        return;
      }

      if (req.method !== 'GET') limiter.take('general', clientKey(req, config));
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch { /* already gone */ }
        return;
      }
      if (err instanceof HttpError) {
        const headers = err.meta?.retryAfter ? { 'retry-after': String(err.meta.retryAfter) } : {};
        if (err.status === 401) headers['www-authenticate'] = 'Pairing';
        fail(res, err.status, err.code, err.message, headers);
        return;
      }
      fail(res, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
    }
  });

  // Workers are killed when the listener closes, so a stopped host leaves no
  // orphaned plugin processes behind.
  server.on('close', () => {
    heartbeat.stop();
    notifications.stop();
    backgroundTasks.stop();
    kernel.shutdownWorkers();
    // MCP children are processes too: closing the host must not leave them.
    for (const entry of mcpState.connected) entry.server.stop();
    mcpState.connected = [];
  });
  server.once('listening',()=>{notifications.start();heartbeat.start();void Promise.all([hostReady,kernelReady]).then(()=>backgroundTasks.start()).catch(()=>backgroundTasks.stop());});

  return {
    server,
    context: {
      config, sessions, conversations, goals, tools, model, agent, kernel, kernelReady, reconciled,
      pairingFresh, backgroundTasks, audit, heartbeat,
      // Exposed so a test (and the phone) can inspect what was learned without
      // going through the model.
      learning: learningBridge,
      learnedStore,
      ownerMode,
    },
  };
}

export async function startV4Server({ config }) {
  const { server, context } = createV4Server({ config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${address.port}`;
  return { server, context, url, port: address.port };
}
