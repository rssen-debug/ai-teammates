/**
 * MAJIN V6 — optional private telemetry sync without the GitHub CLI.
 *
 * Uses the GitHub REST API directly. Before every upload it asks GitHub
 * whether the repository is private; anything other than an explicit
 * `private: true` answer refuses the upload. Payloads pass through a hard
 * privacy gate that rejects secrets, verification links and personal content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertSyncSafe } from './redact.js';
import { loadOwnerToken } from './secrets.js';

const API = 'https://api.github.com';

export function loadSyncConfig({ env = process.env, tokenFile = null } = {}) {
  const repo = env.MAJIN_V6_SYNC_REPO || 'rssen-debug/majin2026';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, repo: null, error: { code: 'SYNC_REPO_INVALID', reason: 'Sync repository must be owner/name' } };
  }
  if (!/^rssen-debug\//i.test(repo)) {
    return {
      ok: false, repo,
      error: { code: 'SYNC_REPO_NOT_PRIVATE_CANDIDATE', reason: 'V6 telemetry sync is restricted to the owner account namespace; use the private repository rssen-debug/majin2026' },
    };
  }
  const token = loadOwnerToken({
    envNames: ['MAJIN_V6_SYNC_TOKEN'], file: tokenFile || env.MAJIN_V6_SYNC_TOKEN_FILE || null,
  });
  if (!token.ok) return { ok: false, repo, error: token.error };
  return { ok: true, repo, token: token.token, tokenSource: token.source, branch: env.MAJIN_V6_SYNC_BRANCH || null };
}

async function gh({ token, method = 'GET', route, body = null, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'MAJIN-V6-telemetry',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  let json = null;
  try { json = await response.json(); } catch { /* some responses are empty */ }
  return { status: response.status, ok: response.ok, json };
}

export async function verifyPrivateRepo({ token, repo, fetchImpl = globalThis.fetch }) {
  const result = await gh({ token, route: `/repos/${repo}`, fetchImpl });
  if (result.status === 401 || result.status === 403) {
    return { ok: false, error: { code: 'SYNC_AUTH_FAILED', reason: `GitHub authentication failed (HTTP ${result.status})` } };
  }
  if (result.status === 404) {
    return { ok: false, error: { code: 'SYNC_REPO_NOT_ACCESSIBLE', reason: 'Repository not found or not accessible with the supplied token; refusing to upload' } };
  }
  if (!result.ok) {
    return { ok: false, error: { code: 'SYNC_REPO_CHECK_FAILED', reason: `GitHub returned HTTP ${result.status}` } };
  }
  const fullName = result.json?.full_name;
  if (String(fullName).toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, error: { code: 'SYNC_REPO_MISMATCH', reason: 'GitHub answered for a different repository' } };
  }
  if (result.json?.private !== true) {
    return { ok: false, error: { code: 'SYNC_REPO_NOT_PRIVATE', reason: 'Target repository is not private; refusing to upload telemetry' } };
  }
  return { ok: true, repo: fullName, defaultBranch: result.json?.default_branch || 'main', private: true };
}

export function buildSyncPayload(report) {
  if (!report || typeof report !== 'object') throw new Error('A report object is required');
  const safe = {
    schema: 'majin.v6.telemetry/v1',
    generatedAt: report.generatedAt || new Date().toISOString(),
    engine: {
      state: report.engine?.state || 'UNKNOWN',
    },
    queue: report.queue?.byState || {},
    workers: (report.workers || []).map((worker) => ({
      state: worker.state, ageSeconds: worker.ageSeconds ?? null, lastAction: worker.lastAction || null,
    })),
    activity: (report.activity || []).slice(-40).map((event) => ({ at: event.at, type: event.type, taskId: event.taskId || null })),
    jobs: {
      total: report.jobs?.total || 0,
      byState: report.jobs?.byState || {},
    },
    checks: report.checks || {},
    limitations: report.limitations || [],
  };
  assertSyncSafe(safe);
  return safe;
}

export async function pushTelemetry({
  report, repo, token, fileName = null, dryRun = false, fetchImpl = globalThis.fetch, log = null,
} = {}) {
  const payload = buildSyncPayload(report);
  const target = fileName || `reports/v6-${String(payload.generatedAt).replaceAll(':', '-')}.json`;
  if (dryRun) {
    return { ok: true, dryRun: true, repo, path: target, payload };
  }
  const verified = await verifyPrivateRepo({ token, repo, fetchImpl });
  if (!verified.ok) {
    log?.append('sync.refused', { code: verified.error.code, repo });
    return { ok: false, error: verified.error };
  }
  // A write must confirm the private status in the same session.
  const existing = await gh({ token, route: `/repos/${verified.repo}/contents/${encodeURIComponent(target).replaceAll('%2F', '/')}`, fetchImpl });
  let sha = null;
  let branch = verified.defaultBranch;
  if (existing.status === 200 && existing.json?.sha) sha = existing.json.sha;
  else if (existing.status !== 404) {
    return { ok: false, error: { code: 'SYNC_CONTENTS_READ_FAILED', reason: `Could not inspect target path (HTTP ${existing.status})` } };
  }
  const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8').toString('base64');
  const put = await gh({
    token, method: 'PUT', fetchImpl,
    route: `/repos/${verified.repo}/contents/${encodeURIComponent(target).replaceAll('%2F', '/')}`,
    body: {
      message: `v6 telemetry ${payload.generatedAt}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    },
  });
  if (!put.ok) {
    log?.append('sync.refused', { code: 'SYNC_UPLOAD_FAILED', status: put.status, repo: verified.repo });
    return { ok: false, error: { code: 'SYNC_UPLOAD_FAILED', reason: `GitHub upload failed (HTTP ${put.status})` } };
  }
  log?.append('sync.completed', { repo: verified.repo, path: target, bytes: content.length });
  return { ok: true, repo: verified.repo, path: target, commit: put.json?.commit?.sha || null, bytes: content.length };
}

export function writeLocalReport({ dir, report, stamp = null }) {
  const safe = buildSyncPayload(report);
  const name = `v6-${(stamp || safe.generatedAt).replaceAll(':', '-')}.json`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  return file;
}
