import fs from 'node:fs';
import path from 'node:path';
import { createV5Server } from '../../src/v5/server.js';
import { complete } from '../../src/core/provider/chat.js';

const dataDir = path.resolve(process.env.MAJIN_LIVE_STATE || '../go-live-private');
const server = createV5Server({ dataDir });
const providers = server.architect.providers;
providers.completeImpl = async options => {
  try { return await complete(options); }
  catch (error) { console.log(JSON.stringify({ upstreamStatus: error.status, upstreamCode: error.code, detail: String(error.message).replaceAll(providers.secrets['opencode-go'] || 'NO_KEY', '[redacted]') })); throw error; }
};
if (process.env.MAJIN_GO_TEST_KEY) await providers.configureProvider({ providerId: 'opencode-go', apiKey: process.env.MAJIN_GO_TEST_KEY });
const catalog = await providers.discoverCatalog('opencode-go', { timeoutMs: 20000 });
console.log(JSON.stringify({ catalogOk: catalog.ok, models: catalog.models, error: catalog.error }));
if (!catalog.ok) process.exitCode = 1;
else {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek-v4-pro'];
  for (const modelId of models) {
    providers.selectModel({ providerId: 'opencode-go', modelId });
    const nonce = `LIVE_${Date.now()}`;
    const filename = `check-${modelId.replace(/[^a-z0-9-]/gi, '_')}.txt`;
    const goal = await server.providerAgent.execute({ goalText: `Test the coding agent file tools. Write exactly ${nonce} to ${filename}, then read it back with fs_read. Answer briefly in Swedish.`,
      criteria: [{ kind: 'file', path: filename, contains: nonce }] });
    const result = { modelId, status: goal.status, tools: goal.tool_results, cost: goal.cost, reply: goal.model_reply, blocker: goal.blocker, verified: goal.verification_evidence.length };
    fs.writeFileSync(path.join(dataDir, `live-result-${modelId}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
