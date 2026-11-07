/**
 * MAJIN V4 — model layer.
 *
 * Real providers ride the proven V1 transport (`src/core/provider/chat.js`):
 * one request path, three dialects, SSE streaming, retry/backoff, honest error
 * classification and cost accounting. V4 contributes only route construction.
 *
 * With no configured route the app runs a deterministic demo brain. It is not
 * a language model and says so everywhere: `demo: true` in every response,
 * a visible badge in the UI, and a capability list it cannot exceed.
 */
import { complete as v1Complete } from '../core/provider/chat.js';
import { safeFileName } from './tools.js';
import { resolveRouteForModel, routeUnavailableReason, recordLiveResult } from './models.js';
import { readModelSelection, assertModelBillingAuthorized } from './model-selection.js';
import { t } from './ui/strings.js';

export const DEMO_MODEL = 'demo-brain';

function routeFor(config) {
  const m = config.model;
  if (!m || m.kind === 'demo') return null;
  const baseUrl = String(m.baseUrl || '').replace(/\/+$/, '');
  const endpoint = m.kind === 'anthropic'
    ? (baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`)
    : (baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`);
  return {
    kind: m.kind,
    providerName: m.providerName,
    label: m.label,
    baseUrl,
    endpoint,
    apiKey: m.apiKey,
    model: m.model,
    extraHeaders: m.extraHeaders || null,
    maxTokens: m.maxTokens || 2048,
    temperature: Number.isFinite(m.temperature) ? m.temperature : 0.4,
  };
}

export function modelInfo(config) {
  const route = routeFor(config);
  if (!route) {
    return { demo: true, provider: 'demo', model: DEMO_MODEL, label: 'Demo — ingen modell ansluten' };
  }
  return { demo: false, provider: route.providerName, model: route.model, label: `${route.label} · ${route.model}` };
}

/* ------------------------------------------------------------------ demo -- */

const SV = /\b(och|att|är|jag|du|det|en|ett|med|för|kan|vill|skriv|skapa|fil|filen|mapp|hitta|tack|hej)\b|[åäö]/i;

function looksSwedish(text) {
  return SV.test(text);
}

function pickFileName(text) {
  const m = text.match(/([\wåäöÅÄÖ .-]{1,80}\.[A-Za-z0-9]{1,8})/);
  return m ? m[1].trim().replace(/^["'“”]|["'“”]$/g, '') : null;
}

function parseWriteIntent(text) {
  const m = text.match(/(?:skriv|skapa|spara|write|create|save)[\s\S]*?(?:file|fil(?:en)?)\b\s*[:\-]?\s*["'“]?([^"'”\n]+?\.[A-Za-z0-9]{1,8})["'”]?[\s\S]*?(?:innehåll(?:et)?|content|text(?:en)?|med|with)\s*[:\-]?\s*([\s\S]+)/i);
  if (!m) return null;
  const fileName = m[1].trim().replace(/^(en|ett|a|the)\s+/i, '');
  const content = m[2]
    .replace(/^\s*[:\-]\s*/, '')
    .replace(/^(innehåll(et)?|content|text(en)?)\s*[:\-]\s*/i, '')
    .trim();
  if (!fileName || !content) return null;
  return { fileName, content };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamDemo(text, onEvent) {
  const words = text.split(/(\s+)/).filter(Boolean);
  let buffer = '';
  return (async () => {
    for (const w of words) {
      buffer += w;
      if (buffer.length >= 10 || w.includes('\n')) {
        onEvent?.({ type: 'delta', text: buffer });
        buffer = '';
        await sleep(8);
      }
    }
    if (buffer) onEvent?.({ type: 'delta', text: buffer });
  })();
}

async function demoBrain({ messages, workspaceDir, onEvent }) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const sv = looksSwedish(text);

  if (lastTool) {
    let payload = null;
    try {
      payload = JSON.parse(lastTool.content);
    } catch { /* keep null */ }
    const vars = {
      name: payload?.data?.fileName,
      bytes: payload?.data?.bytes,
      hash: String(payload?.data?.sha256 || '').slice(0, 12),
      error: payload?.error || 'tool rejected',
    };
    const answer = payload?.ok
      ? t(sv ? 'demo.doneSv' : 'demo.doneEn', vars)
      : t(sv ? 'demo.failSv' : 'demo.failEn', vars);
    await streamDemo(answer, onEvent);
    return { text: answer, toolCalls: [], usage: { input: 0, output: 0, reported: false } };
  }

  const write = parseWriteIntent(text);
  if (write) {
    try {
      safeFileName(write.fileName);
    } catch (err) {
      const answer = t(sv ? 'demo.badNameSv' : 'demo.badNameEn', { error: err.message });
      await streamDemo(answer, onEvent);
      // An actionable request that was refused is not a completed task.
      return {
        text: answer,
        toolCalls: [],
        refused: { reason: err.message, code: 'INVALID_FILENAME' },
        usage: { input: 0, output: 0, reported: false },
      };
    }
    onEvent?.({ type: 'tool', name: 'workspace_write' });
    return {
      text: '',
      toolCalls: [{ id: `call_demo_${Date.now().toString(36)}`, name: 'workspace_write', argsJson: JSON.stringify(write) }],
      usage: { input: 0, output: 0, reported: false },
    };
  }

  if (/\b(lista|list|visa)\b[\s\S]*\b(filer|filerna|files|workspace|arbetsyta)\b/i.test(text)) {
    onEvent?.({ type: 'tool', name: 'workspace_list' });
    return {
      text: '',
      toolCalls: [{ id: `call_demo_${Date.now().toString(36)}`, name: 'workspace_list', argsJson: '{}' }],
      usage: { input: 0, output: 0, reported: false },
    };
  }

  const answer = t(sv ? 'demo.introSv' : 'demo.introEn');
  await streamDemo(answer, onEvent);
  return { text: answer, toolCalls: [], usage: { input: 0, output: 0, reported: false } };
}

/* ---------------------------------------------------------------- public -- */

/**
 * chat({messages, tools, signal, onEvent}) -> {text, toolCalls, usage, model, demo}
 * onEvent: {type:'delta',text} | {type:'tool',name} | {type:'thinking',text}
 */
export function createModelClient(config, { workspaceDir } = {}) {
  const defaultRoute = routeFor(config);

  /** Resolve a catalog model id to a route; null when not authorised. */
  function routeForModel(modelId) {
    const selection = readModelSelection({ home: config.paths.home });
    if (selection.persisted) modelId = selection.modelId;
    if (!modelId) return defaultRoute;
    return resolveRouteForModel({
      home: config.paths.home,
      env: process.env,
      modelId,
      base: defaultRoute,
    });
  }

  function infoFor(modelId) {
    const route = routeForModel(modelId);
    if (!route) {
      const selection = readModelSelection({ home: config.paths.home });
      return selection.persisted ? { demo: false, provider: 'unavailable', model: selection.modelId, label: 'Selected model unavailable' } : modelInfo(config);
    }
    return { demo: false, provider: route.providerName, model: route.model, label: `${route.label} · ${route.model}` };
  }

  return {
    get info() { return infoFor(null); },
    infoFor,
    routeForModel,
    async chat({ messages, tools = [], signal, onEvent, modelId = null }) {
      const route = routeForModel(modelId);
      const selection = readModelSelection({ home: config.paths.home });
      const requestedId = selection.persisted ? selection.modelId : modelId;
      if (requestedId && !route) {
        const reason = routeUnavailableReason({ home: config.paths.home, env: process.env, modelId: requestedId, base: defaultRoute });
        throw Object.assign(new Error(`Selected model is unavailable. ${reason} No fallback was attempted.`), { code: 'MODEL_UNAVAILABLE', reason });
      }
      if (route && requestedId) assertModelBillingAuthorized({ home: config.paths.home, modelId: requestedId, base: defaultRoute });
      const demo = !route;
      if (demo) {
        const res = await demoBrain({
          messages,
          workspaceDir: workspaceDir || config.workspaceDir,
          onEvent: signal?.aborted ? () => {} : onEvent,
        });
        return { ...res, provider: 'demo', model: DEMO_MODEL, demo: true, modelId: null };
      }
      let res;
      try {
        res = await v1Complete({
          route,
          messages,
          tools,
          stream: true,
          signal,
          job: 'chat',
          maxTokens: route.maxTokens,
          temperature: route.temperature,
          onEvent,
        });
      } catch (err) {
        recordLiveResult(`${route.providerName}/${route.model}`, { ok: false, errorClass: err?.majin?.kind || 'provider' });
        throw err;
      }
      recordLiveResult(`${route.providerName}/${route.model}`, { ok: true });
      return {
        text: res.text || '',
        toolCalls: res.toolCalls || [],
        usage: res.usage || null,
        stopReason: res.stopReason || 'stop',
        provider: route.providerName,
        model: route.model,
        modelId: `${route.providerName}/${route.model}`,
        demo: false,
        elapsedMs: res.elapsedMs,
      };
    },
  };
}

/** Friendly, honest sentence for a failed model call. */
export function explainModelError(err) {
  if (err?.code === 'MODEL_UNAVAILABLE') {
    const reasonKeys = {
      'no-model': 'model.error.reason.noModel',
      'env-route-unavailable': 'model.error.reason.envUnavailable',
      'env-route-mismatch': 'model.error.reason.envMismatch',
      'config-missing': 'model.error.reason.configMissing',
      'invalid-model-id': 'model.error.reason.invalidId',
      'provider-missing': 'model.error.reason.providerMissing',
      'endpoint-missing': 'model.error.reason.endpointMissing',
      'model-not-listed': 'model.error.reason.modelNotListed',
      'api-key-missing': 'model.error.reason.apiKeyMissing',
      'route-unresolved': 'model.error.reason.unresolved',
    };
    return t('model.error.unavailable', { reason: t(reasonKeys[err.reason] || 'model.error.reason.unresolved') });
  }
  if (err?.majin?.human) return err.majin.human;
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return 'Turn cancelled.';
  const msg = String(err?.message || err || 'unknown error');
  if (/no api key/i.test(msg)) return 'No API key is configured for this provider.';
  return msg;
}
