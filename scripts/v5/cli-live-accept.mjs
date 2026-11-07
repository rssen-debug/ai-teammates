/**
 * Installed-CLI live acceptance for MAJIN V5 against OpenCode Go or direct DeepSeek.
 *
 * This is deliberately NOT an in-process provider smoke test. It drives the
 * shipped `bin/majin-v5.mjs` as child processes: live catalog discovery,
 * explicit model selection from that catalog, then a bare natural-language
 * goal (no owner --criteria JSON). The real model must register a concrete
 * file criterion with goal_criteria, use the file tools, and the host must
 * independently verify the resulting file before COMPLETED is accepted.
 *
 * Model fallback is bounded and fully reported: unless MAJIN_LIVE_MODEL pins
 * one model, up to MAJIN_LIVE_MAX_ATTEMPTS catalog models are tried in a
 * fixed preference order, each in a fresh temporary data dir, until one
 * attempt passes EVERY check. A pinned model is never silently substituted.
 * Every attempt (model, stage, error, checks) is disclosed in the output;
 * `verified` is true only when one complete attempt actually passed.
 *
 * The API key is referenced only by environment-variable name
 * (--api-key-env). It is never placed in argv, printed, or written by this
 * script. The installed CLI stores it in its normal private provider state
 * inside a temporary directory; this script deletes those secret files and,
 * by default, removes the whole temporary tree when the run ends.
 *
 * MAJIN_LIVE_PROVIDER selects opencode-go (default) or deepseek.
 * MAJIN_LIVE_BASE_URL may point the selected provider configuration
 * at a compatible gateway (used by the local plumbing tests with a fake
 * endpoint). A run against anything other than the selected provider’s official service
 * proves only the script/CLI plumbing, never live-account acceptance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/majin-v5.mjs', import.meta.url));
const providerId = process.env.MAJIN_LIVE_PROVIDER || 'opencode-go';
const keyEnv = process.env.MAJIN_LIVE_KEY_ENV || (providerId === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENCODE_API_KEY');
const apiKey = process.env[keyEnv] || '';
const requestedModel = String(process.env.MAJIN_LIVE_MODEL || '').trim();
const baseUrl = String(process.env.MAJIN_LIVE_BASE_URL || '').trim();
const runTimeoutMs = Number(process.env.MAJIN_LIVE_TIMEOUT_MS) > 0 ? Number(process.env.MAJIN_LIVE_TIMEOUT_MS) : 300000;
const totalBudgetMs = Number(process.env.MAJIN_LIVE_TOTAL_TIMEOUT_MS) > 0 ? Number(process.env.MAJIN_LIVE_TOTAL_TIMEOUT_MS) : 900000;
const maxAttempts = Math.min(5, Math.max(1, Math.trunc(Number(process.env.MAJIN_LIVE_MAX_ATTEMPTS) || 3)));
const keepRoot = process.env.MAJIN_LIVE_KEEP === '1';

function scrub(text) {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  out = out.replace(/"maskedKey"\s*:\s*"[^"]*"/g, '"maskedKey":"[redacted]"');
  out = out.replace(/("(?:apiKey|api_key|accessToken|access_token|token|secret)":\s*")[^"]+/gi, '$1[redacted]');
  return out;
}

function fail(stage, message, extra = {}) {
  const error = new Error(scrub(message));
  error.stage = stage;
  Object.assign(error, extra);
  throw error;
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  } catch { /* process already exited */ }
}

function runCli(args, { root, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        MAJIN_HOME: path.join(root, 'majin-home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function parseJsonOutput(result, stage) {
  const stdout = String(result.stdout || '');
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) {
    fail(stage, `expected JSON output from installed CLI (exit ${result.status})`, {
      stdoutTail: scrub(stdout.slice(-6000)),
      stderrTail: scrub(String(result.stderr || '').slice(-6000)),
    });
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    return fail(stage, `installed CLI returned invalid JSON: ${error.message}`, {
      stdoutTail: scrub(stdout.slice(-6000)),
      stderrTail: scrub(String(result.stderr || '').slice(-6000)),
    });
  }
}

function requireCliOk(result, stage) {
  if (result.status === 0) return result;
  return fail(stage, `installed CLI step failed with exit ${result.status}`, {
    stdoutTail: scrub(String(result.stdout || '').slice(-6000)),
    stderrTail: scrub(String(result.stderr || '').slice(-6000)),
  });
}

function candidateModels(models) {
  const ids = models.map((model) => typeof model === 'string' ? model : model?.id).filter(Boolean);
  if (requestedModel) {
    if (!ids.includes(requestedModel)) {
      fail('model-select', `MAJIN_LIVE_MODEL=${requestedModel} was not present in the live ${providerId} catalog (${ids.length} models)`);
    }
    return [requestedModel];
  }
  const preferred = ['glm-5.3-flash', 'deepseek-v4-pro', 'qwen3.8-flash', 'grok-4.6'];
  const ordered = preferred.filter((candidate) => ids.includes(candidate));
  const fallback = ids.find((id) => /deepseek|qwen|glm|grok/i.test(id) && !ordered.includes(id));
  if (fallback) ordered.push(fallback);
  if (!ordered.length) fail('model-select', `no supported live-acceptance model found in catalog (${ids.length} models)`);
  return ordered.slice(0, maxAttempts);
}

async function configureAttempt(root, dataDir) {
  const configure = requireCliOk(await runCli([
    'model', 'configure',
    '--provider', providerId,
    '--api-key-env', keyEnv,
    ...(baseUrl ? ['--base-url', baseUrl] : []),
    '--discover',
    '--data-dir', dataDir,
    '--timeout-ms', '30000',
    '--json',
  ], { root, timeoutMs: 90000 }), 'model-configure');
  const configured = parseJsonOutput(configure, 'model-configure');
  const discovery = configured.discovery || {};
  if (discovery.ok !== true || !Array.isArray(discovery.models) || !discovery.models.length) {
    fail('model-configure', `live catalog discovery did not return models: ${JSON.stringify(discovery.error || discovery).slice(0, 1000)}`);
  }
  return discovery;
}

async function attemptGoal({ root, modelId, catalogModels }) {
  const dataDir = path.join(root, 'data');
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  await configureAttempt(root, dataDir);
  requireCliOk(await runCli([
    'model', 'select', modelId,
    '--provider', providerId,
    '--require-discovered',
    '--data-dir', dataDir,
    '--json',
  ], { root, timeoutMs: 60000 }), 'model-select');

  const nonce = `MAJIN_LIVE_CLI_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const goalText = `Create a text file named live-proof.txt containing exactly ${nonce}. Check that the saved file contains the requested text and tell me the result.`;
  const run = await runCli([
    'run', goalText,
    '--data-dir', dataDir,
    '--lanes', 'files',
    '--max-rounds', '8',
  ], { root, timeoutMs: runTimeoutMs });

  const logs = requireCliOk(await runCli(['logs', '--data-dir', dataDir, '--json'], { root, timeoutMs: 60000 }), 'logs');
  const parsedLogs = parseJsonOutput(logs, 'logs');
  const goal = parsedLogs.goal || parsedLogs;
  const proofPath = path.join(workspace, 'live-proof.txt');
  const proof = fs.existsSync(proofPath) ? fs.readFileSync(proofPath) : null;
  const toolNames = (goal.tool_results || []).map((row) => row.tool).filter(Boolean);
  const checks = {
    cliExitZero: run.status === 0,
    statusCompleted: goal.status === 'COMPLETED',
    criteriaSourceModel: goal.criteria_source === 'model',
    verificationEvidence: Array.isArray(goal.verification_evidence) && goal.verification_evidence.length >= 1,
    fileContainsNonce: Boolean(proof && proof.toString('utf8').trim() === nonce),
    usedGoalCriteria: toolNames.includes('goal_criteria'),
    usedFileWrite: toolNames.includes('fs_write'),
    modelCalled: Number(goal.cost?.modelCalls || 0) > 0,
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failedChecks.length) {
    fail('installed-cli-goal', `live installed-CLI goal did not prove completion; failed checks: ${failedChecks.join(', ')}`, {
      checks,
      goalStatus: goal.status || null,
      criteriaSource: goal.criteria_source || null,
      blocker: scrub(goal.blocker || ''),
      stdoutTail: scrub(String(run.stdout || '').slice(-6000)),
      stderrTail: scrub(String(run.stderr || '').slice(-6000)),
    });
  }

  return {
    ok: true,
    verified: true,
    provider: providerId,
    modelId,
    catalogModels,
    baseUrlOverride: Boolean(baseUrl),
    status: goal.status,
    criteriaSource: goal.criteria_source,
    verificationEvidence: goal.verification_evidence.length,
    tools: toolNames,
    modelCalls: goal.cost?.modelCalls || 0,
    inputTokens: goal.cost?.inputTokens || 0,
    outputTokens: goal.cost?.outputTokens || 0,
    fileSha256: createHash('sha256').update(proof).digest('hex'),
    nonce,
    checks,
  };
}

async function main() {
  if (!['opencode-go', 'deepseek'].includes(providerId)) {
    console.log(JSON.stringify({ ok: false, verified: false, stage: 'config', error: 'Unsupported MAJIN_LIVE_PROVIDER; use opencode-go or deepseek' }));
    process.exitCode = 2;
    return;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    console.log(JSON.stringify({ ok: false, verified: false, stage: 'credential', error: 'MAJIN_LIVE_KEY_ENV must be an environment variable name' }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!apiKey) {
    console.log(JSON.stringify({
      ok: false,
      verified: false,
      stage: 'credential',
      error: `NOT VERIFIED: ${keyEnv} is not set; no live ${providerId} request was attempted.`,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (baseUrl) {
    let parsed = null;
    try { parsed = new URL(baseUrl); } catch { /* handled below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      console.log(JSON.stringify({ ok: false, verified: false, stage: 'config', error: 'MAJIN_LIVE_BASE_URL must be a valid http(s) URL without credentials' }, null, 2));
      process.exitCode = 2;
      return;
    }
  }

  const startedAt = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-cli-live-'));
  const prepareRoot = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      fs.mkdirSync(path.join(dir, 'AppData', 'Local'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'AppData', 'Roaming'), { recursive: true });
    }
  };

  const attemptRoots = [];
  const attempts = [];
  let summary;
  let lastError = null;
  try {
    // Discovery pass only selects the ordered candidate list from the live
    // catalog; each attempt still configures its own fresh data dir.
    const discoveryRoot = path.join(root, 'discovery');
    prepareRoot(discoveryRoot);
    attemptRoots.push(discoveryRoot);
    const discovery = await configureAttempt(discoveryRoot, path.join(discoveryRoot, 'data'));
    const candidates = candidateModels(discovery.models);

    for (const [index, modelId] of candidates.entries()) {
      if (index > 0 && Date.now() - startedAt > totalBudgetMs - 60000) {
        attempts.push({ modelId, ok: false, stage: 'budget', error: 'total live-acceptance time budget exhausted before this attempt' });
        continue;
      }
      const attemptRoot = path.join(root, `attempt-${index + 1}`);
      prepareRoot(attemptRoot);
      attemptRoots.push(attemptRoot);
      try {
        summary = await attemptGoal({ root: attemptRoot, modelId, catalogModels: discovery.models.length });
        attempts.push({ modelId, ok: true });
        break;
      } catch (error) {
        lastError = error;
        attempts.push({
          modelId,
          ok: false,
          stage: error.stage || 'live-acceptance',
          error: scrub(error.message || error),
          ...(error.checks ? { checks: error.checks } : {}),
          ...(error.goalStatus ? { goalStatus: error.goalStatus } : {}),
        });
      }
    }
  } finally {
    for (const attemptRoot of attemptRoots) {
      try { fs.rmSync(path.join(attemptRoot, 'data', 'provider-secrets.json'), { force: true }); } catch { /* best-effort secret cleanup */ }
    }
    if (!keepRoot) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* CI workspace is ephemeral */ }
    }
  }

  if (!summary) {
    if (lastError) {
      lastError.attempts = attempts;
      throw lastError;
    }
    fail('installed-cli-goal', 'no live-acceptance attempt produced a result', { attempts });
  }
  summary.attempts = attempts;
  if (keepRoot) summary.keptRoot = root;
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    verified: false,
    stage: error.stage || 'live-acceptance',
    error: scrub(error.message || error),
    ...(error.attempts ? { attempts: error.attempts } : {}),
    ...(error.checks ? { checks: error.checks } : {}),
    ...(error.goalStatus ? { goalStatus: error.goalStatus } : {}),
    ...(error.criteriaSource ? { criteriaSource: error.criteriaSource } : {}),
    ...(error.blocker ? { blocker: error.blocker } : {}),
    ...(error.stdoutTail ? { stdoutTail: error.stdoutTail } : {}),
    ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
  }, null, 2));
  process.exitCode = 1;
}
