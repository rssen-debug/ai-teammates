#!/usr/bin/env node
/**
 * Opt-in black-box evaluation against the currently configured model.
 * Unlike scripts/bench.mjs, this does not script provider answers. It tests
 * whether the selected model actually uses MAJIN's constrained file tools.
 * It is opt-in, isolated to a temporary MAJIN_HOME, and refuses OpenCode/Qwen routes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

export function resolveConfigPath(env = process.env, root = ROOT) {
  const expand = (value) => String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
  if (env.MAJIN_CONFIG) return path.resolve(expand(env.MAJIN_CONFIG));
  if (env.MAJIN_HOME) return path.join(path.resolve(expand(env.MAJIN_HOME)), 'config.json');
  const devConfig = path.join(root, 'majin.config.json');
  if (fs.existsSync(devConfig)) return devConfig;
  const home = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MAJIN')
    : path.join(os.homedir(), '.majin');
  return path.join(home, 'config.json');
}

export function assertSafeRoutes(config) {
  const providers = config?.providers || {};
  const routes = config?.models?.routes || {};
  for (const [job, ref] of Object.entries(routes)) {
    const [providerName, ...modelParts] = String(ref).split('/');
    const provider = providers[providerName] || {};
    const identity = [job, ref, providerName, provider.label, modelParts.join('/')].filter(Boolean).join(' ');
    if (/open[\s_-]*code|qwen/i.test(identity)) {
      throw new Error(`Live eval refused: the configured ${job} route matches OpenCode/Qwen. This eval must not use that model.`);
    }
  }
}

function opaqueToken() {
  return `MAJIN-${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8).toUpperCase()).join('-')}`;
}

async function main() {
  if (has('--help')) {
    process.stdout.write('Usage: npm run eval:live -- --yes\n\nRuns two real-provider tool-use scenarios (up to 8 model steps each) in an isolated temporary workspace. May incur provider charges. Refuses OpenCode/Qwen routes.\n');
    return;
  }
  if (!has('--yes')) throw new Error('This makes real model calls and may cost money. Re-run explicitly with: npm run eval:live -- --yes');

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) throw new Error(`No MAJIN config found at ${configPath}. Configure MAJIN first; no files were changed.`);
  const source = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assertSafeRoutes(source);

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-live-eval-'));
  let rt;
  try {
    const isolatedConfig = {
      ...source,
      workspace: path.join(tempHome, 'workspace'),
      tools: { ...(source.tools || {}), allow: ['fs.read', 'fs.write', 'fs.list'] },
      guard: { ...(source.guard || {}), mode: 'off' },
      moa: { ...(source.moa || {}), policy: 'off' },
      routing: { ...(source.routing || {}), llmTiebreak: false, escalateAfterErrors: 10 },
      agent: { ...(source.agent || {}), maxSteps: 8, maxTokens: 1800, retries: 0, stepJob: 'same' },
    };
    const isolatedConfigPath = path.join(tempHome, 'config.json');
    fs.writeFileSync(isolatedConfigPath, `${JSON.stringify(isolatedConfig, null, 2)}\n`, { mode: 0o600 });
    process.env.MAJIN_HOME = tempHome;
    process.env.MAJIN_CONFIG = isolatedConfigPath;
    process.env.MAJIN_WORKSPACE = isolatedConfig.workspace;

    const { createRuntime } = await import('../src/core/runtime.js');
    rt = await createRuntime({ channels: false, scheduler: false });
    const { routeFor } = await import('../src/core/router.js');
    const liveRoutes = ['tasks', 'final'].map((job) => routeFor(rt.cfg, job));
    if (liveRoutes.some((route) => !route || route.kind === 'mock' || !route.apiKey)) {
      throw new Error('Live eval refused: the active tasks/final route is demo, mock, or missing a key. Configure a real provider first.');
    }
    assertSafeRoutes({
      ...source,
      models: { ...(source.models || {}), routes: { ...(source.models?.routes || {}), tasks: liveRoutes[0].ref, final: liveRoutes[1].ref } },
      providers: { ...(source.providers || {}), ...Object.fromEntries(liveRoutes.map((route) => [route.providerName, { ...(source.providers?.[route.providerName] || {}), label: route.label }])) },
    });
    fs.mkdirSync(isolatedConfig.workspace, { recursive: true });

    const results = [];
    const run = async ({ name, input, check }) => {
      const events = [];
      const result = await rt.agent.turn({
        input,
        session: `live-eval-${name}`,
        onEvent: (event) => events.push(event),
      });
      const toolResults = events.filter((event) => event.type === 'tool_result');
      const steps = events.filter((event) => event.type === 'step').map((event) => ({ job: event.job, model: event.model }));
      const verdict = check({ result, toolResults, events });
      const allSelectedRoutesAreLive = steps.length > 0 && steps.every((step) => {
        const route = rt.cfg.resolveModel(step.model, step.job);
        return route.kind !== 'mock' && Boolean(route.apiKey);
      });
      results.push({
        name,
        pass: verdict.pass && allSelectedRoutesAreLive,
        checks: { ...verdict.checks, allSelectedRoutesAreLive },
        steps: result.steps,
        tools: toolResults.map((event) => ({ name: event.tool, ok: event.ok, error: event.error?.code || null })),
        route: steps,
        answer: String(result.text || '').slice(0, 500),
      });
    };

    const readToken = opaqueToken();
    const readFile = `eval-read-${Date.now()}.txt`;
    fs.writeFileSync(path.join(isolatedConfig.workspace, readFile), `private test marker: ${readToken}\n`, { mode: 0o600 });
    await run({
      name: 'read-and-report',
      input: `Read ${readFile} and report the exact private test marker from it. Do not guess.`,
      check: ({ result, toolResults }) => {
        const read = toolResults.find((event) => event.tool === 'fs.read' && event.ok);
        const hasToken = String(result.text || '').includes(readToken);
        return { pass: Boolean(read && hasToken), checks: { readToolSucceeded: Boolean(read), exactMarkerReported: hasToken } };
      },
    });

    const writeToken = opaqueToken();
    const writeFile = `eval-write-${Date.now()}.txt`;
    await run({
      name: 'write-read-verify',
      input: `Create ${writeFile} containing exactly this line: ${writeToken}. Then read the file back to verify it. Reply with the marker only if the read-back matches.`,
      check: ({ result, toolResults }) => {
        const wrote = toolResults.some((event) => event.tool === 'fs.write' && event.ok);
        const read = toolResults.some((event) => event.tool === 'fs.read' && event.ok);
        const abs = path.join(isolatedConfig.workspace, writeFile);
        const fileMatches = fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').trim() === writeToken;
        const answerMatches = String(result.text || '').includes(writeToken);
        return { pass: Boolean(wrote && read && fileMatches && answerMatches), checks: { writeToolSucceeded: wrote, readBackSucceeded: read, fileMatchesExactly: fileMatches, markerReported: answerMatches } };
      },
    });

    const usage = rt.usage.summary();
    const report = {
      kind: 'live-provider-agent-eval',
      at: new Date().toISOString(),
      providerCallsWereLive: results.length > 0 && results.every((item) => item.checks.allSelectedRoutesAreLive),
      usage: { requests: usage.requests || 0, tokens: usage.tokens || 0, costUsd: +(usage.costUsd || 0).toFixed(4) },
      modelRoutes: [...new Set(results.flatMap((item) => item.route.map((route) => route.model).filter(Boolean)))],
      passed: results.filter((item) => item.pass).length,
      total: results.length,
      pass: results.length > 0 && results.every((item) => item.pass),
      scenarios: results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await rt?.shutdown?.().catch(() => {});
    fs.rmSync(tempHome, { recursive: true, force: true });
    delete process.env.MAJIN_HOME;
    delete process.env.MAJIN_CONFIG;
    delete process.env.MAJIN_WORKSPACE;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Live eval not run: ${error.message}\n`);
    process.exitCode = 2;
  });
}
