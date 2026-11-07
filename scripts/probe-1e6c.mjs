#!/usr/bin/env node
/* 1E/6C live probe: two-provider support + per-provider quality/cost.
   Exercises MAJIN's own router -> complete() path against a LOCAL Ollama
   server (free, no key) and records a verdict JSON. No cloud credits used. */
import { complete } from '../src/core/provider/chat.js';
import { load } from '../src/core/config.js';
import { routeFor } from '../src/core/router.js';

const probe = {
  schema: 'majin.probe-1e6c.v1',
  ts: new Date().toISOString(),
  ollama: { reachable: false, modelsListed: [], models: {} },
  completeThroughRouter: null,
  secondProviderAutoHandoffPriorRun: null,
  costSummary: {},
  verdict: null,
};

const cfg = await load();

// (1) Ollama reachability + model list via the OpenAI-compat endpoint the preset points at
try {
  const res = await fetch('http://127.0.0.1:11434/v1/models', { headers: { Authorization: 'Bearer ollama' } });
  const j = await res.json();
  probe.ollama.reachable = true;
  probe.ollama.modelsListed = (j.data || []).map(m => m.id);
} catch (e) {
  probe.ollama.error = String(e.message || e);
}

// (2) A REAL completion through MAJIN's own routeFor -> complete chain (router's actual path)
const PROMPT = 'Name the capital of Sweden. Reply with one word only.';
if (probe.ollama.reachable) {
  const route = routeFor(cfg, 'chat'); // chat is routed to ollama in the probe config
  const t0 = Date.now(); console.error("t=0 dispatching complete() at", new Date().toISOString());
  try {
    const res = await complete({
      route,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [], maxTokens: 24, temperature: 0, job: "chat", retries: 0, signal: AbortSignal.timeout(110000),
    });
    probe.completeThroughRouter = {
      ok: true,
      provider: route.providerName,
      model: route.model,
      elapsedMs: Date.now() - t0,
      answer: (res.text || res.content || '').slice(0, 120),
      usage: res.usage || null,
      costUsd: (res.usage && res.usage.costUsd) ?? null,
    };
    probe.costSummary['ollama/' + route.model] = { costUsd: probe.completeThroughRouter.costUsd, elapsedMs: probe.completeThroughRouter.elapsedMs, answerOk: /stockholm/i.test(String(probe.completeThroughRouter.answer)) };
  } catch (e) {
    probe.completeThroughRouter = { ok: false, provider: route.providerName, model: route.model, error: String(e.message || e).slice(0, 300) };
  }
}

// (3) prior-run handoff artifact (written by the live `majin send` earlier)
try {
  const fs = await import('node:fs');
  const h = JSON.parse(fs.readFileSync(process.env.HOME + '/.majin/sessions/cli.handoff.json', 'utf8'));
  probe.secondProviderAutoHandoffPriorRun = { from: h.from, to: h.to, goal: h.goal, ts: h.ts, consumed: h.consumed };
} catch { probe.secondProviderAutoHandoffPriorRun = { found: false }; }

// (4) cost table entry for the cloud free lane (no live call — no key allowed)
probe.costSummary['opencode/longcat-2.5-preview-free'] = { costUsd: 0, liveCall: false, note: 'no credential in sandbox; pricing listed as $0 in config' };

const handoffProven = !!(probe.secondProviderAutoHandoffPriorRun && probe.secondProviderAutoHandoffPriorRun.from && probe.secondProviderAutoHandoffPriorRun.to && probe.secondProviderAutoHandoffPriorRun.from !== probe.secondProviderAutoHandoffPriorRun.to);
probe.verdict = {
  secondProviderSupported: probe.ollama.reachable && !!probe.completeThroughRouter?.ok,
  autoHandoffObserved: handoffProven,
  localInferenceCostUsd: 0,
  limitations: [
    'cloud second lane (opencode) cannot live-complete in sandbox: no credential issued; handoff observed from a prior live run journal only',
  ],
};
console.log(JSON.stringify(probe, null, 2));
