/** The native launcher shows a fresh pairing code locally, never in a log. */
import { loadConfig } from '../../src/v4/config.js';
import { loadSecret, ensurePairing } from '../../src/v4/auth.js';

const config = loadConfig({ argv: process.argv.slice(2) });
const code = ensurePairing(config.paths.pairing, loadSecret(config.paths.secret));
if (code && process.send) await new Promise((resolve, reject) => {
  process.send({ type: 'pairing', code }, (error) => error ? reject(error) : resolve());
});
// The host outlives the native window. Do not retain its parent's IPC pipe.
if (process.connected) process.disconnect();
await import('./supervise.mjs');
