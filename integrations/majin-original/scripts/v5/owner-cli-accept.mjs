#!/usr/bin/env node
// Test the installed CLI with the owner's saved Go or DeepSeek model and credential.
// The credential stays local; the existing acceptance runner uses isolated
// temporary state and never prints it or puts it in command-line arguments.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderManager } from '../../src/v5/providers.js';
import { resolveV5DataDir } from './desktop-host.mjs';
const pm = new ProviderManager({ dataDir: resolveV5DataDir() });
const id = pm.state.activeProvider;
if (!['opencode-go', 'deepseek'].includes(id) || !pm.state.activeModelId || !pm.secrets[id]) {
  console.error('NOT VERIFIED: configure an OpenCode Go or DeepSeek model and credential in MAJIN before running this acceptance.');
  process.exit(2);
}
const child = spawn(process.execPath, [fileURLToPath(new URL('./cli-live-accept.mjs', import.meta.url))], {
  stdio: 'inherit', shell: false,
  env: { ...process.env, MAJIN_OWNER_ACCEPT_KEY: pm.secrets[id], MAJIN_LIVE_KEY_ENV: 'MAJIN_OWNER_ACCEPT_KEY',
    MAJIN_LIVE_PROVIDER: id,
    MAJIN_LIVE_MODEL: pm.state.activeModelId, MAJIN_LIVE_MAX_ATTEMPTS: '1',
    MAJIN_LIVE_BASE_URL: pm.state.providers[id].baseUrl,
    MAJIN_LIVE_KEEP: '0' },
});
child.on('error', () => { console.error('Could not start the local CLI acceptance runner.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
