/* 6C: same-task quality/cost through MAJIN's complete() for a named ollama model. */
import { complete } from '../src/core/provider/chat.js';
const model = process.argv[2] || 'smollm2:135m';
const maxTokens = Number(process.argv[3] || 16);
const PROMPT = 'Name the capital of Sweden. Reply with one word only.';
import { load } from '../src/core/config.js';
import { routeFor } from '../src/core/router.js';
const cfg = await load();
const route = { ...routeFor(cfg, 'chat', { model }) , model };
route.maxTokens = maxTokens; route.temperature = 0;
const t0 = Date.now();
try {
  const res = await complete({ route, messages: [{ role: 'user', content: PROMPT }], tools: [], maxTokens, temperature: 0, job: 'chat', retries: 0, signal: AbortSignal.timeout(Number(process.argv[4] || 300000)) });
  console.log(JSON.stringify({ schema: 'majin.probe-6c-model.v1', model, ok: true, elapsedMs: Date.now()-t0, answer: (res.text || res.content || '').slice(0, 400), usage: res.usage, answerOk: /stockholm/i.test((res.text || res.content || '')) }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ schema: 'majin.probe-6c-model.v1', model, ok: false, elapsedMs: Date.now()-t0, error: String(e.message || e).slice(0, 300) }, null, 1));
}
