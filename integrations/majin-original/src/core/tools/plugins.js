/**
 * User-authored runtime tool plugins. Creation is an exec-risk action, saved
 * plugins are hash-checked at startup, and each plugin tool itself is exec-risk.
 * Plugins run with the MAJIN process' privileges: only install code you trust.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { def } from './registry.js';
import { dirs } from '../paths.js';

const NAME = /^plugin\.[a-z][a-z0-9_-]{1,39}$/;
const MAX_CODE = 16000;

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function manifestFile(dir) {
  return path.join(dir, 'index.json');
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.plugins && typeof parsed.plugins === 'object' ? parsed : { version: 1, plugins: {} };
  } catch {
    return { version: 1, plugins: {} };
  }
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const file = manifestFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function moduleSource({ name, description, params, code }) {
  // Store the body as data and compile it into a function. Importing/reloading a plugin
  // compiles syntax but does not execute the generated body before its exec approval.
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  return `// MAJIN user tool plugin; generated explicitly by majin.plugin.\n` +
    `const body = Buffer.from(${JSON.stringify(encoded)}, 'base64').toString('utf8');\n` +
    `const runBody = new Function('args', 'ctx', \`return (async () => {\\n\${body}\\n})()\`);\n` +
    `export default {\n` +
    `  name: ${JSON.stringify(name)},\n` +
    `  group: 'plugin',\n` +
    `  desc: ${JSON.stringify(description)},\n` +
    `  risk: 'exec',\n` +
    `  params: ${JSON.stringify(params, null, 2)},\n` +
    `  async run(args, ctx) { return runBody(args, ctx); },\n` +
    `};\n`;
}

async function importPlugin(file, expectedHash) {
  const source = await fsp.readFile(file, 'utf8');
  if (hash(source) !== expectedHash) throw new Error('plugin source changed since it was approved; remove and recreate it to load the new code');
  const module = await import(`${pathToFileURL(file).href}?sha=${expectedHash}`);
  const raw = module.default;
  if (!raw || typeof raw.run !== 'function') throw new Error('plugin must export a default tool object with an async run(args, ctx) function');
  if (!NAME.test(raw.name || '') || raw.group !== 'plugin' || raw.risk !== 'exec') throw new Error('plugin metadata failed validation');
  if (!raw.desc || raw.desc.length < 20 || !raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) throw new Error('plugin needs a description and parameter schema');
  return def({ ...raw, required: [] });
}

export async function loadUserPlugins(registry, { dir = dirs.plugins } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of [...registry.tools]) if (tool.group === 'plugin') registry.unregister(tool.name);
  const manifest = readManifest(dir);
  const loaded = [];
  const skipped = [];
  for (const [name, item] of Object.entries(manifest.plugins)) {
    if (!NAME.test(name) || item?.file !== `${name.slice('plugin.'.length)}.mjs` || typeof item.sha256 !== 'string') {
      skipped.push({ name, reason: 'invalid manifest entry' });
      continue;
    }
    try {
      const tool = await importPlugin(path.join(dir, item.file), item.sha256);
      registry.register(tool);
      loaded.push(name);
    } catch (err) {
      skipped.push({ name, reason: err.message });
    }
  }
  return { loaded, skipped };
}

async function createPlugin({ name, description, params, code }, registry, dir) {
  if (!NAME.test(name)) throw new Error('name must start with plugin. and use lowercase letters, digits, _ or - (2–40 chars after the dot)');
  if (registry.has(name)) throw new Error(`tool already exists: ${name}`);
  if (typeof description !== 'string' || description.trim().length < 20) throw new Error('description must be at least 20 characters');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 30) throw new Error('params must be a JSON object with no more than 30 fields');
  for (const [key, spec] of Object.entries(params)) {
    if (!/^[a-zA-Z][\w-]{0,39}$/.test(key) || typeof spec !== 'string' || !spec.trim()) throw new Error(`invalid parameter schema for ${key}`);
  }
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE) throw new Error(`code must be 1–${MAX_CODE} characters`);

  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${name.slice('plugin.'.length)}.mjs`;
  const file = path.join(dir, fileName);
  const source = moduleSource({ name, description: description.trim(), params, code });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, source, { mode: 0o600 });
  await fsp.rename(tmp, file);
  const manifest = readManifest(dir);
  manifest.plugins[name] = { file: fileName, sha256: hash(source), createdAt: new Date().toISOString() };
  writeManifest(dir, manifest);
  try {
    const tool = await importPlugin(file, manifest.plugins[name].sha256);
    registry.register(tool);
  } catch (err) {
    delete manifest.plugins[name];
    writeManifest(dir, manifest);
    await fsp.unlink(file).catch(() => {});
    throw new Error(`plugin validation failed and was rolled back: ${err.message}`);
  }
  return { name, file, sha256: manifest.plugins[name].sha256 };
}

async function removePlugin(name, registry, dir) {
  if (!NAME.test(name)) throw new Error('invalid plugin name');
  const manifest = readManifest(dir);
  const item = manifest.plugins[name];
  if (!item) throw new Error(`no saved plugin named ${name}`);
  delete manifest.plugins[name];
  writeManifest(dir, manifest);
  registry.unregister(name);
  await fsp.unlink(path.join(dir, `${name.slice('plugin.'.length)}.mjs`)).catch(() => {});
  return { name };
}

export const pluginTools = [
  def({
    name: 'majin.plugin',
    group: 'majin',
    risk: 'exec',
    desc: 'Create, list, reload or remove custom MAJIN tools. A created JavaScript plugin runs with MAJIN process privileges, is hash-checked at startup and every invocation requires exec approval in normal guard modes. Use only code the user trusts.',
    params: {
      action: 'string: list | create | reload | remove [list|create|reload|remove]',
      name: 'string: plugin name, e.g. plugin.csv_summary',
      description: 'string?: (optional) what the custom tool does (at least 20 chars; required for create)',
      params: 'object?: (optional) JSON object {} of parameter descriptions, e.g. {"path":"string: input file"}',
      code: 'string?: (optional) JavaScript async function body; parameters are args and ctx; return a result object',
    },
    examples: ['majin.plugin({action:"create",name:"plugin.word_count",description:"Count words in a local text file",params:{path:"string: file path"},code:"const fs = await import(\'node:fs/promises\'); return { result: String((await fs.readFile(args.path, \'utf8\')).trim().split(/\\s+/).length) };"})'],
    async run({ action = 'list', name = '', description = '', params = {}, code = '' }, ctx) {
      const dir = dirs.plugins;
      if (action === 'list') {
        const tools = ctx.registry.list().filter((tool) => tool.group === 'plugin');
        return { result: `${tools.length} custom plugin tool(s):\n${tools.map((tool) => `- ${tool.name}: ${tool.desc}`).join('\n') || '(none)'}\n\nDirectory: ${dir}`, meta: { tools: tools.map((tool) => tool.name), dir }, summary: `${tools.length} custom tools` };
      }
      if (action === 'create') {
        const created = await createPlugin({ name, description, params, code }, ctx.registry, dir);
        ctx.emit?.({ type: 'plugin:created', name: created.name, file: created.file, sha256: created.sha256 });
        return { result: `Created and loaded ${created.name}\nFile: ${created.file}\nSHA-256: ${created.sha256}\nIt is available now; running it will require exec approval. Source is checked against this hash at startup.`, meta: created, summary: `created ${created.name}` };
      }
      if (action === 'reload') {
        const loaded = await loadUserPlugins(ctx.registry, { dir });
        ctx.emit?.({ type: 'plugin:reload', loaded: loaded.loaded, skipped: loaded.skipped });
        return { result: `Loaded ${loaded.loaded.length} plugin(s): ${loaded.loaded.join(', ') || '(none)'}${loaded.skipped.length ? `\nSkipped: ${loaded.skipped.map((x) => `${x.name}: ${x.reason}`).join('; ')}` : ''}`, meta: loaded, summary: `loaded ${loaded.loaded.length} custom tools` };
      }
      if (action === 'remove') {
        const removed = await removePlugin(name, ctx.registry, dir);
        ctx.emit?.({ type: 'plugin:removed', name: removed.name });
        return { result: `Removed ${removed.name}.`, meta: removed, summary: `removed ${removed.name}` };
      }
      return { ok: false, error: { code: 'bad_action', message: `unknown action ${action}`, hint: 'list | create | reload | remove' } };
    },
  }),
];
