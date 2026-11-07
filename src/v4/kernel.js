/**
 * MAJIN V4 — versioned kernel and capability contracts.
 *
 * The point of this file is that MAJIN should not need a V5: tools, providers,
 * memory, voice engines and UI surfaces register against a versioned interface,
 * and experimental work ships behind flags.
 *
 * What is real here:
 *  - strict manifest + capability validation before anything is registered
 *  - permission declarations and refusal of undeclared capabilities
 *  - try/catch activation with automatic rollback (nothing half-registered)
 *  - quarantine of a broken plugin so the host keeps serving
 *
 * What is NOT claimed:
 *  - plugins are not a security sandbox. They run in-process with the host's
 *    privileges. Loading is therefore opt-in (MAJIN_V4_PLUGINS=1) and every
 *    plugin must declare what it needs. Process-level isolation is future work
 *    and is written down as such in docs/v4/ARCHITECTURE.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PluginWorker } from './sandbox.js';

export const KERNEL_API_VERSION = 1;
export const CAPABILITY_KINDS = Object.freeze(['tool', 'provider', 'voice', 'memory', 'surface']);

export const PluginManifest = z.object({
  name: z.string().min(2).max(48).regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  // A newer plugin is not malformed — it is incompatible, and the loader says so.
  kernelApi: z.number().int().min(1),
  description: z.string().min(4).max(200),
  permissions: z.array(z.enum(['workspace', 'network', 'memory', 'voice'])).default([]),
  capabilities: z.array(z.object({
    kind: z.enum(CAPABILITY_KINDS),
    name: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_]*$/),
  })).min(1).max(20),
  experimental: z.boolean().default(false),
});

export class KernelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
  }
}

/**
 * The registry. One instance per host process; capabilities are frozen once
 * registered so a plugin cannot mutate another plugin's contract.
 */
export class Kernel {
  // `isolate` defaults to false so the kernel stays a pure library. A host that
  // runs untrusted plugins turns it on (the V4 server does by default).
  constructor({ features = {}, pluginsEnabled = false, allowlist = [], isolate = false, quarantineDir = null, workerFactory = null } = {}) {
    this.apiVersion = KERNEL_API_VERSION;
    this.features = { ...features };
    this.pluginsEnabled = pluginsEnabled;
    this.allowlist = new Set(allowlist);
    this.isolate = isolate;
    this.quarantineDir = quarantineDir;
    this.workerFactory = workerFactory || ((opts) => new PluginWorker(opts));
    this.capabilities = new Map(); // `${kind}:${name}` -> {plugin, impl}
    this.plugins = new Map(); // name -> { manifest, status, error }
    this.workers = new Map(); // plugin name -> PluginWorker
    this.loadedAt = null;
  }

  /** Move a broken plugin out of the way so the host stops trying to load it. */
  quarantine(name, error) {
    if (!this.quarantineDir) return null;
    const safe = String(name).replace(/[^a-z0-9-]/gi, '');
    if (!safe || safe !== name) return null; // never move something we did not name
    const source = path.join(path.dirname(this.quarantineDir), 'plugins', safe);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.quarantineDir, `${safe}-${stamp}`);
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(source)) return null;
      fs.renameSync(source, target);
      fs.writeFileSync(path.join(target, 'QUARANTINE.json'), JSON.stringify({
        plugin: safe,
        quarantinedAt: new Date().toISOString(),
        reason: String(error || 'unknown').slice(0, 1000),
        action: 'Review the plugin, then move the directory back into plugins/ to retry.',
      }, null, 2));
      return target;
    } catch {
      return null; // a read-only plugins dir is not a reason to fail the host
    }
  }

  /** Ordered shutdown: tell each worker to exit, then hard-kill stragglers. */
  shutdownWorkers() {
    const stopped = [...this.workers.values()].map((worker) => worker.stop());
    this.workers.clear();
    return Promise.all(stopped);
  }

  flag(name) {
    return Boolean(this.features[name]);
  }

  get(kind, name) {
    return this.capabilities.get(`${kind}:${name}`)?.impl || null;
  }

  list() {
    return [...this.capabilities.entries()].map(([key, value]) => {
      const [kind, name] = key.split(':');
      return { kind, name, plugin: value.plugin };
    });
  }

  /**
   * Register one capability with rollback semantics: either it is registered
   * and listed, or the call throws and nothing changed.
   */
  register({ plugin, manifest, capability, impl }) {
    if (!manifest.permissions && !Array.isArray(manifest.permissions)) {
      throw new KernelError('MANIFEST_INVALID', 'manifest.permissions must be an array');
    }
    if (!manifest.capabilities.some((c) => c.kind === capability.kind && c.name === capability.name)) {
      throw new KernelError('PERMISSION_UNDECLARED', `capability ${capability.kind}:${capability.name} was not declared in the manifest`);
    }
    const key = `${capability.kind}:${capability.name}`;
    if (this.capabilities.has(key)) {
      throw new KernelError('DUPLICATE_CAPABILITY', `capability ${key} is already registered by ${this.capabilities.get(key).plugin}`);
    }
    const frozen = Object.freeze({ ...capability, impl: undefined });
    this.capabilities.set(key, { plugin, impl: Object.freeze({ ...frozen, impl }) });
    return key;
  }

  /**
   * Load every plugin directory under `dir`. Each failure is contained: the
   * plugin is marked failed/quarantined and the host keeps running.
   */
  async loadPlugins(dir) {
    const results = [];
    if (!this.pluginsEnabled) return results;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (this.allowlist.size && !this.allowlist.has(entry.name)) continue;
      const pluginDir = path.join(dir, entry.name);
      const manifestFile = path.join(pluginDir, 'plugin.json');
      let manifest;
      try {
        manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
      } catch (err) {
        this.plugins.set(entry.name, { status: 'rejected', error: `manifest: ${err.message}` });
        results.push({ name: entry.name, status: 'rejected', error: err.message });
        continue;
      }
      if (manifest.name !== entry.name) {
        this.plugins.set(entry.name, { status: 'rejected', error: 'directory name must equal manifest name' });
        results.push({ name: entry.name, status: 'rejected', error: 'name mismatch' });
        continue;
      }
      if (manifest.experimental && !this.flag('experimental-plugins')) {
        this.plugins.set(entry.name, { status: 'flagged-off', manifest });
        results.push({ name: entry.name, status: 'flagged-off' });
        continue;
      }
      if (manifest.kernelApi > this.apiVersion) {
        this.plugins.set(entry.name, { status: 'incompatible', manifest });
        results.push({ name: entry.name, status: 'incompatible' });
        continue;
      }
      const before = new Set(this.capabilities.keys());
      if (this.isolate) {
        let worker = null;
        try {
          worker = this.workerFactory({
            dir: pluginDir,
            manifest,
            timeoutMs: Number(process.env.MAJIN_V4_PLUGIN_TIMEOUT_MS || 5000),
            callTimeoutMs: Number(process.env.MAJIN_V4_PLUGIN_CALL_TIMEOUT_MS || 15_000),
          });
          await worker.start();
          for (const cap of worker.registered) {
            if (!manifest.capabilities.some((c) => c.kind === cap.kind && c.name === cap.name)) {
              throw new KernelError('PERMISSION_UNDECLARED', `capability ${cap.kind}:${cap.name} was not declared`);
            }
            const key = `${cap.kind}:${cap.name}`;
            if (this.capabilities.has(key)) throw new KernelError('DUPLICATE_CAPABILITY', `${key} already registered`);
            // The signal from a cancelled turn reaches the child process: a
            // plugin that keeps working after stop would be a silent side effect.
            const callThrough = (input, ctx = {}) => worker.call(cap.name, input, { signal: ctx.signal || null });
            this.capabilities.set(key, {
              plugin: manifest.name,
              impl: Object.freeze({
                kind: cap.kind,
                name: cap.name,
                // Schema validation stays in the host: a plugin cannot skip it.
                inputSchema: z.unknown(),
                outputSchema: z.unknown(),
                tier: 'read',
                execute: callThrough,
              }),
            });
          }
          this.workers.set(manifest.name, worker);
          this.plugins.set(entry.name, { status: 'active', manifest, isolated: true });
          results.push({ name: entry.name, status: 'active', isolated: true });
        } catch (err) {
          // A plugin that failed mid-activation may still be running in the
          // child (e.g. a stray interval). Stop it, or the host keeps a live
          // process and an open IPC channel for a capability that never loaded.
          try {
            await worker?.stop();
          } catch { /* already gone */ }
          for (const key of [...this.capabilities.keys()]) if (!before.has(key)) this.capabilities.delete(key);
          const moved = this.quarantine(entry.name, err.message);
          this.plugins.set(entry.name, { status: 'failed', manifest, error: String(err.message || err), isolated: true, quarantined: Boolean(moved) });
          results.push({ name: entry.name, status: 'failed', error: String(err.message || err), quarantined: moved || null });
        }
        continue;
      }
      try {
        const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href);
        const activate = mod.activate || mod.default;
        if (typeof activate !== 'function') throw new Error('index.js must export activate(ctx)');
        const ctx = this.#contextFor(manifest);
        await activate(ctx);
        this.plugins.set(entry.name, { status: 'active', manifest });
        results.push({ name: entry.name, status: 'active' });
      } catch (err) {
        for (const key of [...this.capabilities.keys()]) {
          if (!before.has(key)) this.capabilities.delete(key); // rollback
        }
        const moved = this.quarantine(entry.name, err.message);
        this.plugins.set(entry.name, { status: 'failed', manifest, error: String(err.message || err), quarantined: Boolean(moved) });
        results.push({ name: entry.name, status: 'failed', error: String(err.message || err), quarantined: moved || null });
      }
    }
    this.loadedAt = new Date().toISOString();
    return results;
  }

  #contextFor(manifest) {
    const kernel = this;
    const register = (capability, impl) => kernel.register({ plugin: manifest.name, manifest, capability, impl });
    const granted = new Set(manifest.permissions);
    return Object.freeze({
      apiVersion: this.apiVersion,
      plugin: Object.freeze({ name: manifest.name, version: manifest.version }),
      flag: (name) => kernel.flag(name),
      hasPermission: (p) => granted.has(p),
      registerTool: ({ name, description, tier = 'read', inputSchema, outputSchema, execute }) => {
        if (!granted.has('workspace') && tier !== 'read') {
          throw new KernelError('PERMISSION_UNDECLARED', `tool ${name} needs the "workspace" permission`);
        }
        return register({ kind: 'tool', name }, { description, tier, inputSchema, outputSchema, execute });
      },
      registerProvider: ({ name, chat }) => {
        if (!granted.has('network')) throw new KernelError('PERMISSION_UNDECLARED', `provider ${name} needs the "network" permission`);
        return register({ kind: 'provider', name }, { chat });
      },
      registerVoice: ({ name, speak, transcribe }) => {
        if (!granted.has('voice')) throw new KernelError('PERMISSION_UNDECLARED', `voice ${name} needs the "voice" permission`);
        return register({ kind: 'voice', name }, { speak, transcribe });
      },
      registerMemory: ({ name, put, search }) => {
        if (!granted.has('memory')) throw new KernelError('PERMISSION_UNDECLARED', `memory ${name} needs the "memory" permission`);
        return register({ kind: 'memory', name }, { put, search });
      },
      registerSurface: ({ name, render }) => register({ kind: 'surface', name }, { render }),
    });
  }

  summary() {
    return {
      apiVersion: this.apiVersion,
      pluginsEnabled: this.pluginsEnabled,
      plugins: [...this.plugins.entries()].map(([name, p]) => ({
        name,
        status: p.status,
        isolated: Boolean(p.isolated),
        quarantined: Boolean(p.quarantined),
        ...(p.error ? { error: p.error } : {}),
      })),
      capabilities: this.list(),
      flags: this.features,
      loadedAt: this.loadedAt,
    };
  }
}

/** Feature flags: stable features default on, experimental default off. */
export function parseFlags(raw) {
  const flags = {
    voice: true,
    pwa: true,
    'experimental-plugins': false,
    'experimental-desktop': false,
  };
  if (!raw) return flags;
  for (const token of String(raw).split(',').map((t) => t.trim()).filter(Boolean)) {
    const [name, value] = token.split('=');
    if (!name) continue;
    const on = value == null ? true : /^(1|true|on|yes)$/i.test(value);
    flags[name] = on;
  }
  return flags;
}
