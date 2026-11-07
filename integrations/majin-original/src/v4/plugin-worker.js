/**
 * MAJIN V4 — plugin worker (child process).
 *
 * Runs ONE plugin in a separate Node process so a crash, a hang or runaway CPU
 * cannot take the host down. The worker has no access to the host's config
 * object, no API keys and no HTTP server: `process.env` is rebuilt from a small
 * allowlist before the plugin is imported.
 *
 * What this is: process isolation with a supervised lifecycle.
 * What this is NOT: a security sandbox. The plugin runs as the same OS user and
 * can still read files that user can read. The real boundary for untrusted code
 * is a separate account or a container — documented, not pretended.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let handlers = new Map();
let failures = 0;

function send(message) {
  if (typeof process.send === 'function') process.send(message);
}

function errorText(err) {
  return String(err?.message || err).slice(0, 500);
}

/** The ctx a plugin sees. Everything is a message to the parent process. */
function makeContext(manifest) {
  const granted = new Set(manifest.permissions || []);
  const register = (kind, name, impl) => {
    if (!manifest.capabilities.some((c) => c.kind === kind && c.name === name)) {
      throw new Error(`capability ${kind}:${name} was not declared in the manifest`);
    }
    if (kind === 'tool' && typeof impl?.execute === 'function') handlers.set(name, impl.execute);
    send({ type: 'register', kind, name, plugin: manifest.name });
    return `${kind}:${name}`;
  };
  const needPermission = (name, permission) => {
    if (!granted.has(permission)) throw new Error(`${name} needs the "${permission}" permission`);
  };

  return Object.freeze({
    apiVersion: 1,
    plugin: Object.freeze({ name: manifest.name, version: manifest.version }),
    flag: () => false, // flags are evaluated by the host before activation
    hasPermission: (p) => granted.has(p),
    registerTool: ({ name, description, tier = 'read', inputSchema = null, outputSchema = null, execute }) => {
      if (tier !== 'read') needPermission(`tool ${name}`, 'workspace');
      if (typeof execute !== 'function') throw new Error(`tool ${name} needs an execute function`);
      return register('tool', name, { description, tier, inputSchema, outputSchema, execute });
    },
    registerProvider: ({ name }) => {
      needPermission(`provider ${name}`, 'network');
      return register('provider', name, null);
    },
    registerVoice: ({ name }) => {
      needPermission(`voice ${name}`, 'voice');
      return register('voice', name, null);
    },
    registerMemory: ({ name }) => {
      needPermission(`memory ${name}`, 'memory');
      return register('memory', name, null);
    },
    registerSurface: ({ name }) => register('surface', name, null),
  });
}

async function main() {
  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'activate') {
      try {
        const entry = path.join(msg.dir, 'index.js');
        const mod = await import(pathToFileURL(entry).href);
        const activate = mod.activate || mod.default;
        if (typeof activate !== 'function') throw new Error('index.js must export activate(ctx)');
        await activate(makeContext(msg.manifest));
        send({ type: 'activated', plugin: msg.manifest.name });
      } catch (err) {
        send({ type: 'activation-failed', error: errorText(err) });
      }
      return;
    }
    if (msg.type === 'call') {
      const fn = handlers.get(msg.name);
      if (!fn) {
        send({ type: 'result', id: msg.id, ok: false, error: `tool ${msg.name} is not registered in this worker` });
        return;
      }
      try {
        const data = await fn(msg.input);
        send({ type: 'result', id: msg.id, ok: true, data });
      } catch (err) {
        failures += 1;
        send({ type: 'result', id: msg.id, ok: false, error: errorText(err), cls: err?.cls || 'UNKNOWN' });
      }
      return;
    }
    if (msg.type === 'shutdown') {
      send({ type: 'bye', failures });
      process.exit(0);
    }
  });

  send({ type: 'ready' });
}

main().catch((err) => {
  send({ type: 'fatal', error: errorText(err) });
  process.exit(1);
});
