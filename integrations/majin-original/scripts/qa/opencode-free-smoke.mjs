/**
 * MAJIN provider acceptance against OpenCode Go subscription endpoint.
 * Maximum two tiny calls to one allowlisted model, no Ollama, no key output.
 */
import assert from 'node:assert/strict';
import { openaiOnce } from '../../src/core/provider/openai.js';

const key = process.env.OPENCODE_API_KEY;
if (!key) throw new Error('OPENCODE_API_KEY secret not configured');
const root = 'https://opencode.ai/zen/go/v1';
const allowed = ['glm-5.3-flash']; // OpenCode listed: $0.15/M input, $0.50/M output
const report = { provider: 'OpenCode Go', billing: 'Go subscription only; 2 tiny requests', passed: [], failed: [], blocked: [], model: null };
function record(kind, step, reason) {
  report[kind].push({ step, ...(reason ? { reason: String(reason).replaceAll(key, '[REDACTED]').slice(0, 300) } : {}) });
  console.log(kind.toUpperCase() + ': ' + step + (reason ? ' (' + String(reason).replaceAll(key, '[REDACTED]').slice(0, 180) + ')' : ''));
}
try {
  const catalog = await fetch(root + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12000) });
  if (!catalog.ok) throw new Error('model catalog HTTP ' + catalog.status);
  const json = await catalog.json();
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const names = list.map(x => typeof x === 'string' ? x : x.id || x.name);
  const chosen = allowed.find(x => names.includes(x));
  if (!chosen) {
    record('blocked', 'low-cost model discovery', 'Approved cheap model missing from live catalog; no inference request sent');
    process.exitCode = 2;
  } else {
    assert.equal(chosen, 'glm-5.3-flash');
    report.model = chosen;
    record('passed', 'catalog lists allowlisted low-cost model ' + chosen);
    const route = { apiKey: key, baseUrl: root, endpoint: root + '/chat/completions', model: chosen, extraHeaders: { 'x-opencode-session': 'majin-qa-' + process.env.GITHUB_RUN_ID, 'user-agent': 'majin-coding-agent/1.0', 'x-opencode-client': 'majin' } };
    const result = await openaiOnce({ route, messages: [{ role: 'user', content: 'Reply exactly MAJIN_OK' }], maxTokens: 600, temperature: 0 });
    assert.ok(result.text && result.text.trim().length > 0, 'empty model response');
    record('passed', 'MAJIN openaiOnce produced real low-cost-model completion');
    const tools = [{ name: 'qa_echo', description: 'Return the provided text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
    const answer = await openaiOnce({ route, messages: [{ role: 'user', content: 'Use the qa_echo tool with text set to MAJIN_TOOL_OK. Do not answer in plain text.' }], tools, maxTokens: 650, temperature: 0 });
    if (answer.toolCalls.some(x => x.name === 'qa_echo')) record('passed', 'MAJIN tool-call parsing from real low-cost model');
    else { record('failed', 'MAJIN tool-call parsing', 'Model did not call the provided tool'); process.exitCode = 1; }
  }
} catch (e) {
  const msg = String(e?.message || e).replaceAll(key, '[REDACTED]');
  const isBlocked = /FreeTierError|free tier can only be used|HTTP 402|HTTP 403|HTTP 429|401:|403:|402:|429:/.test(msg);
  record(isBlocked ? 'blocked' : 'failed', 'OpenCode Go inference', msg);
  process.exitCode = isBlocked ? 2 : 1;
}
console.log('RESULT ' + JSON.stringify(report));
