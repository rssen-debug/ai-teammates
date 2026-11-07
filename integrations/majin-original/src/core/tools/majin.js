/**
 * MAJIN — agentens egen kontrollpanel.
 * Allt som finns i config filen kan agenten ändra, med validering + backup.
 * Ett enda verktyg (majin.configure) räcker för resten; de andra är genvägar.
 */
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { def } from './registry.js';
import { validatePatch, JOBS } from '../config.js';
import { parseIntent } from '../routes.js';
import { PRESETS, needsKeyFor } from '../presets.js';
import { complete } from '../provider/chat.js';
import { dirs } from '../paths.js';
import { bus } from '../log.js';
import { VERSION } from '../version.js';
import { detect as detectRe } from '../binary/external.js';
import { validateAdapter } from '../adapters.js';

const mask = (v) => (!v ? '' : v.length <= 6 ? '•••' : `${v.slice(0, 3)}…${v.slice(-2)}`);

export const majinTools = [
  def({
    name: 'majin.configure',
    group: 'majin',
    risk: 'write',
    desc: 'Change MAJIN own configuration (routes, moa, providers, channels, guard, agent, tools, ui, budget, persona). A validated JSON patch; an invalid patch is rejected with a reason. Use intent for natural language.',
    params: {
      patch: 'object: JSON patch of the config tree, e.g. {"models":{"routes":{"code":"deepseek/deepseek-v4-pro"}}} (optional)',
      intent: 'string: an instruction in plain language that is translated into a patch, e.g. "use deepseek pro for code always" (optional)',
      dry: 'boolean: show the diff without saving (optional)',
      note: 'string: why the change is made (goes into the log) (optional)',
    },
    examples: ['majin.configure({intent:"use deepseek flash for tasks always"})', 'majin.configure({patch:{moa:{policy:"hard"}}})'],
    async run({ patch = null, intent = '', dry = false, note = '' }, ctx) {
      let payload = patch;
      let notes = [];
      if (intent && (!patch || (typeof patch === 'object' && !Object.keys(patch).length))) {
        const r = parseIntent(intent, ctx.cfg);
        if (!r.matched) return { ok: false, error: { code: 'no_intent', message: `could not translate "${String(intent).slice(0, 80)}" into a config change`, hint: 'use patch with explicit JSON instead' } };
        payload = r.patch;
        notes = r.notes;
      }
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (err) {
          return { ok: false, error: { code: 'bad_json', message: `patch is not json: ${err.message}` } };
        }
      }
      if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) return { ok: false, error: { code: 'empty', message: 'neither patch nor intent produced a change' } };
      const errors = validatePatch(payload, ctx.cfg.data);
      if (errors.length) return { ok: false, error: { code: 'invalid_config', message: errors.map((e) => `${e.path}: ${e.msg}`).join('; '), hint: 'correct format: providers={<name>:{baseUrl,apiKey,kind}}, models.routes={<job>:"provider/model"}' } };
      const applied = ctx.cfg.patch(payload, { dry, source: `tool${note ? `:${note}` : ''}` });
      if (!applied.ok) return { ok: false, error: { code: 'rejected', message: applied.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
      const diff = applied.diff.map((x) => `${dry ? '?' : '✓'} ${x.path}: ${short(x.from)} → ${short(x.to)}`).join('\n');
      return {
        result: `${dry ? 'DRY-RUN' : 'Applied'} (${ctx.cfg.file})${notes.length ? `\nIntent: ${notes.join(', ')}` : ''}\n${diff}\n\nCurrent state:\n${routeLines(ctx)}`,
        meta: { diff: applied.diff, dry, file: ctx.cfg.file },
        summary: `${dry ? 'dry run' : 'saved'} config change (${applied.diff.length} values)`,
      };
    },
  }),

  def({
    name: 'majin.routes',
    group: 'majin',
    risk: 'write',
    desc: 'Model routing: show, set or test the jobs (chat, tasks, tools, code, re, research, plan, analysis, final, summarize, aggregator, router, vision).',
    params: {
      action: 'string: show | set | test | show_all [show|set|test|show_all] (optional)',
      job: 'string: which job (required for set) (optional)',
      model: 'string: "provider/model" (required for set) (optional)',
      all: 'boolean: set the same model for every job (optional)',
      note: 'string: why (optional)',
    },
    examples: ['majin.routes({action:"set",job:"code",model:"deepseek/deepseek-v4-pro"})'],
    async run({ action = 'show', job = '', model = '', all = false, note = '' }, ctx) {
      if (action === 'show_all' || action === 'show') {
        const t = ctx.cfg.routeTable();
        return { result: `Routing (${ctx.cfg.get('moa.policy') === 'always' ? 'MOA: always' : ctx.cfg.get('moa.policy') === 'hard' ? 'MOA: hard jobs' : 'MOA: off'}):\n${t.map((r) => `${r.ready ? '✓' : '·'} ${r.job.padEnd(11)} ${r.ref}${r.ready ? '' : '  ← ingen nyckel'}`).join('\n')}\n\nProvider:\n${providerLines(ctx)}`, meta: { table: t }, summary: `${t.length} routes` };
      }
      if (action === 'set') {
        if (!model) return { ok: false, error: { code: 'no_model', message: 'set model as "provider/model"' } };
        const [pname] = String(model).split('/');
        if (!ctx.cfg.get(`providers.${pname}`)) return { ok: false, error: { code: 'unknown_provider', message: `unknown provider "${pname}"`, hint: `known: ${Object.keys(ctx.cfg.get('providers') || {}).join(', ')} — add it with majin.provider` } };
        const routes = {};
        if (all) for (const j of JOBS) routes[j] = model;
        else {
          if (!job) return { ok: false, error: { code: 'no_job', message: `set a job: ${JOBS.join(', ')}` } };
          routes[job] = model;
        }
        const res = ctx.cfg.patch({ models: { routes } }, { source: `routes:${note || ''}` });
        if (!res.ok) return { ok: false, error: { code: 'invalid', message: res.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
        return { result: `set ${Object.keys(routes).length} route(s) → ${model}\n${routeLines(ctx)}`, summary: `route ${job || 'all'} → ${model}` };
      }
      if (action === 'test') {
        const route = ctx.cfg.resolveModel(model || ctx.cfg.get(`models.routes.${job || 'tasks'}`), job || 'tasks');
        if (route.kind !== 'mock' && !route.apiKey) return { ok: false, error: { code: 'no_key', message: `${route.providerName} has no key` } };
        const t0 = Date.now();
        try {
          const r = await complete({ route, job: 'test', stream: false, maxTokens: 24, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
          return { result: `${route.ref} answered in ${Date.now() - t0}ms: "${(r.text || '').trim().slice(0, 60)}" (tokens ${r.usage.input}/${r.usage.output})`, summary: `${route.ref} OK` };
        } catch (err) {
          return { ok: false, error: { code: 'provider_failed', message: err.message, hint: err.hint || null }, result: `${route.ref} FAILED after ${Date.now() - t0}ms: ${err.message}` };
        }
      }
      return { ok: false, error: { code: 'bad_action', message: `action ${action} does not exist`, hint: 'show | set | test | show_all' } };
    },
  }),

  def({
    name: 'majin.provider',
    group: 'majin',
    risk: 'write',
    desc: 'Manage providers: list | add | remove | test | models (list available models from /models).',
    params: {
      action: 'string: list | add | remove | test | models [list|add|remove|test|models] (optional)',
      name: 'string: provider name (the key in config) (optional)',
      preset: 'string: use a preset (deepseek, openrouter, groq, openai, anthropic, nous, ollama, lmstudio, mock) (optional)',
      baseUrl: 'string: https://… (optional)',
      apiKey: 'string: sk-…  (stored in the config on disk) (optional)',
      env: 'string: instead of a key — store as {env:VAR} (optional)',
      models: 'string: comma separated model names (optional)',
      kind: 'string: openai | anthropic | mock [openai|anthropic|mock] (optional)',
    },
    examples: ['majin.provider({action:"add",name:"deepseek",apiKey:"sk-…"})'],
    async run({ action = 'list', name = '', preset = '', baseUrl = '', apiKey = '', env = '', models = null, kind = '' }, ctx) {
      const providers = { ...ctx.cfg.get('providers') };
      if (action === 'list') {
        return { result: `providers:\n${Object.entries(providers).map(([k, p]) => `  ${k}: ${p.kind || 'openai'} ${p.baseUrl} key=${p.apiKey ? mask(p.apiKey) : 'MISSING'} models=${(p.models || []).join(', ') || '-'}`).join('\n')}\n\npresets: ${Object.keys(PRESETS).join(', ')}`, meta: providers, summary: `${Object.keys(providers).length} providers` };
      }
      if (action === 'models') {
        const p = providers[name];
        if (!p) return { ok: false, error: { code: 'no_provider', message: `unknown provider ${name}` } };
        const { discoverModels } = await import('../provider/catalog.js');
        const { payload, ...catalog } = await discoverModels(p);
        if (!catalog.ok) return { ok: false, error: { code: 'list_failed', message: catalog.error, hint: catalog.hint } };
        ctx.cfg.patch({ providers: { [name]: { models: catalog.models } } });
        const { importPricing } = await import('../pricing.js');
        await importPricing(ctx.cfg, name, payload, { source: name + ':/models' }).catch(() => {});
        return { result: name + ': ' + catalog.count + ' models (all saved)\n' + catalog.models.slice(0, 120).join('\n'), meta: catalog, summary: catalog.count + ' models' };
      }
      if (action === 'add') {
        if (!name) return { ok: false, error: { code: 'no_name', message: 'give a provider name (or pick a preset)', hint: 'majin.provider({action:"add",name:"deepseek",apiKey:"sk-…"})' } };
        const base = PRESETS[preset || name] || {};
        const entry = {
          label: base.label || name,
          kind: kind || base.kind || 'openai',
          baseUrl: baseUrl || base.baseUrl || '',
          apiKey: env ? `{env:${env}}` : apiKey || base.apiKey || '',
          models: models ? String(models).split(',').map((x) => x.trim()).filter(Boolean) : base.models || [],
          /* gateway-presets kan kräva skall-headrar (opencode Go 400:ar utan
             x-opencode-session) — de måste följa med in i config, annars
             sparas en nyckel som aldrig kan svara */
          ...(base.headers ? { headers: base.headers } : {}),
        };
        if (entry.kind !== 'mock' && !entry.baseUrl) return { ok: false, error: { code: 'no_url', message: 'baseUrl is required (or pick a preset)' } };
        // ett tomt nyckelfalt far inte kunna rapporteras som "sparat": en vanlig
        // manniska trycker spara for att det ska bli klart. Lokala servrar
        // (ollama, lmstudio, egen maskin) har ingen nyckel alls.
        if (needsKeyFor(entry, PRESETS[preset || name])) {
          const ku = PRESETS[preset || name]?.keyUrl;
          return {
            ok: false,
            error: { code: 'no_key', message: `no key pasted - ${entry.label || name} needs one`, hint: `${ku ? `Get one at ${ku} and paste it again.` : 'Paste the key from the provider page and try again.'} Nothing was changed.`, needsKey: true },
          };
        }
        const res = ctx.cfg.patch({ providers: { [name]: entry } }, { source: 'provider.add' });
        if (!res.ok) return { ok: false, error: { code: 'invalid', message: res.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
        const routes = { ...(ctx.cfg.get('models.routes') || {}) };
        const first = entry.models[0];
        if (first) {
          for (const j of ['chat', 'tasks', 'tools', 'summarize', 'router', 'vision']) routes[j] = `${name}/${first}`;
          const strong = entry.models.find((m) => /pro|max|think|reason|sonnet|opus|5\.|4\./.test(m)) || first;
          for (const j of ['code', 're', 'analysis', 'plan', 'research', 'final', 'aggregator']) routes[j] = `${name}/${strong}`;
          await ctx.cfg.patch({ models: { routes, provider: name } });
        }
        bus.info('provider.add', { name, kind: entry.kind, baseUrl: entry.baseUrl });
        return { result: `added ${name} (${entry.kind} ${entry.baseUrl}) and routed ${first ? `${entry.models.length} suggestions` : 'no model'} →\n${routeLines(ctx)}\n\nTest it: majin.routes({action:"test",model:"${name}/${first || '?'}"})`, summary: `provider ${name} tillagd` };
      }
      if (action === 'remove') {
        if (!providers[name]) return { ok: false, error: { code: 'no_provider', message: `unknown provider ${name}` } };
        /* merge() is a DEEP merge — it can never drop a nested key by itself.
           The only truthful way to remove a provider is the undefined sentinel,
           which config.merge honours with delete (src/core/config.js). Sending
           "the remaining map" merges straight back over the old data and the
           removed provider silently survives — exactly the bug this fixes. */
        const presets = PRESETS;
        const rest = Object.fromEntries(Object.entries(providers).filter(([n]) => n !== name));
        const isUser = (n) => !(n in presets);
        const hasKey = (pv) => pv.apiKey && !String(pv.apiKey).startsWith('{env:');
        const isLocal = (pv) => /127\.0\.0\.1|localhost|mock:/.test(pv.baseUrl || '');
        const candidates = Object.entries(rest).filter(([n, pv]) => n !== 'demo' && (pv.models || []).length && (isUser(n) || hasKey(pv) || isLocal(pv)));
        const patch = { providers: { [name]: undefined } };
        /* never leave routes pointing at a ghost: repoint to something that
           can actually answer (user provider with a key first, then keyed
           presets, then user/preset locals), or say clearly that setup must
           run again */
        const routes = { ...(ctx.cfg.get('models.routes') || {}) };
        const dangling = Object.entries(routes).filter(([, ref]) => String(ref).startsWith(name + '/'));
        let note = '';
        if (dangling.length) {
          const next = (candidates.find(([n, pv]) => isUser(n) && hasKey(pv))
            || candidates.find(([, pv]) => hasKey(pv))
            || candidates.find(([n, pv]) => isUser(n) && isLocal(pv))
            || candidates.find(([, pv]) => isLocal(pv))
            || [null])[0];
          if (next) {
            const model = rest[next].models[0];
            for (const [j] of dangling) routes[j] = `${next}/${model}`;
            patch.models = { provider: next, routes };
            note = `\nrepointed ${dangling.length} route(s) to ${next}/${model}`;
          } else {
            note = '\nWARNING: your routes pointed at it and nothing is left to fall back to — run the setup wizard again';
          }
        }
        const rr = ctx.cfg.patch(patch, { source: 'provider.remove' });
        if (rr && rr.ok === false) {
          return { ok: false, error: { code: 'config', message: `could not finish removal safely: ${(rr.errors || []).map((e) => e.path + ' ' + e.msg).join('; ') || 'validation failed'} — nothing was changed` } };
        }
        const leftKeys = candidates.map(([n]) => n);
        return { result: 'removed ' + name + '. Providers with keys left: ' + (leftKeys.join(', ') || 'none') + note, summary: 'provider ' + name + ' removed' };
      }

      if (action === 'test') {
        const p = providers[name] || {};
        const route = ctx.cfg.resolveModel(`${name}/${(p.models || ['x'])[0]}`, 'test');
        const t0 = Date.now();
        try {
          const r = await complete({ route, job: 'test', stream: false, maxTokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
          return { result: `${name} OK (${Date.now() - t0}ms): ${(r.text || '').trim().slice(0, 40)}`, summary: `${name} answers` };
        } catch (err) {
          return { ok: false, error: { code: 'provider_failed', message: err.majin?.human || err.message, hint: err.hint, kind: err.majin?.kind }, summary: `${name} does not answer` };
        }
      }
      return { ok: false, error: { code: 'bad_action', message: action } };
    },
  }),

  def({
    name: 'majin.moa',
    group: 'majin',
    risk: 'write',
    desc: 'Mixture-of-Agents: show | on | off | hard (only hard jobs) | set (references/aggregator/width). On by default.',
    params: {
      action: 'string: show | on | off | hard | set [show|on|off|hard|set] (optional)',
      references: 'array: [{"model":"provider/model","temperature":0.3}] (optional)',
      aggregator: 'string: provider/model that aggregates (optional)',
      width: 'number: how many references to run (optional)',
    },
    async run({ action = 'show', references = null, aggregator = '', width = 0 }, ctx) {
      const m = ctx.cfg.get('moa');
      if (action === 'show') {
        return { result: `MOA: ${m.enabled ? 'ON' : 'off'} (policy=${m.policy}, width=${m.width})\nreferences:\n${(m.references || []).map((r, i) => `  ${i + 1}. ${r.model} (temp ${r.temperature ?? '-'})`).join('\n')}\naggregator: ${m.aggregator}\nhard jobs: ${(m.hardJobs || []).join(', ')}\nagreement floor: ${m.disagreementFloor}`, meta: m, summary: `MOA ${m.enabled ? m.policy : 'off'}` };
      }
      if (action === 'on') return done(ctx, { moa: { enabled: true, policy: 'always' } }, 'MOA on — every answer goes through references + aggregator');
      if (action === 'off') return done(ctx, { moa: { enabled: false, policy: 'off' } }, 'MOA av');
      if (action === 'hard') return done(ctx, { moa: { enabled: true, policy: 'hard' } }, 'MOA runs only on hard jobs (re/code/plan/research/final)');
      const patch = { moa: { enabled: true, policy: m.policy === 'off' ? 'always' : m.policy } };
      if (references) patch.moa.references = (Array.isArray(references) ? references : []).map((r) => (typeof r === 'string' ? { model: r } : r));
      if (aggregator) patch.moa.aggregator = aggregator;
      if (width) patch.moa.width = Math.max(1, Math.min(8, Number(width)));
      return done(ctx, patch, `MOA uppdaterad: ${Object.entries(patch.moa).map(([k, v]) => `${k}=${Array.isArray(v) ? v.map((x) => x.model || x).join('|') : v}`).join(', ')}`);
    },
  }),

  def({
    name: 'majin.guard',
    group: 'majin',
    risk: 'write',
    desc: 'The safety glass: status | mode(confirm|strict|off) | allow(tool) | disallow. The agent can NOT approve its own dangerous actions — a human always does that.',
    params: { action: 'string: status | mode | allow | disallow [status|mode|allow|disallow] (optional)', mode: 'string: confirm | strict | off (optional)', tool: 'string: verktygsnamn (optional)' },
    async run({ action = 'status', mode = '', tool = '' }, ctx) {
      const g = ctx.cfg.get('guard');
      if (action === 'status') {
        return {
          result: `guard: ${g.mode}\nautoApprove: ${(g.autoApprove || []).join(', ') || 'none'}\nprotected paths: ${(g.protectedPaths || []).join(', ')}\nask patterns: ${g.askOn.length}\nalways denied: ${g.neverOn.length}\n\napprovals waiting: ${ctx.approvals?.list().length || 0}${(ctx.approvals?.list() || []).map((a) => `\n  ${a.id} ${a.tool} — ${a.reason}`).join('') || ''}`,
          meta: g,
          summary: `guard ${g.mode}`,
        };
      }
      if (action === 'mode') {
        if (!['confirm', 'strict', 'off'].includes(mode)) return { ok: false, error: { code: 'bad_mode', message: 'mode: confirm | strict | off' } };
        return done(ctx, { guard: { mode } }, `guard = ${mode}${mode === 'off' ? ' — now even irreversible actions run without asking' : ''}`);
      }
      if (action === 'allow') {
        const list = [...new Set([...(g.autoApprove || []), tool])].filter(Boolean);
        return done(ctx, { guard: { autoApprove: list } }, `${tool} auto-approved now (${list.length} i listan)`);
      }
      if (action === 'disallow') {
        const list = (g.autoApprove || []).filter((x) => x !== tool);
        return done(ctx, { guard: { autoApprove: list } }, `${tool} requires approval again (${list.length} in the list)`);
      }
      return { ok: false, error: { code: 'bad_action', message: action } };
    },
  }),

  def({
    name: 'majin.memory',
    group: 'majin',
    risk: 'write',
    desc: 'Long-term memory: remember(text) | recall(query) | forget(query) | list | clear. The agent stores preferences, projects and solutions here.',
    params: { action: 'string: remember | recall | forget | list | clear [remember|recall|forget|list|clear] (optional)', text: 'string: vad som ska minnas (optional)', query: 'string: vad du letar efter (optional)', tags: 'array: taggar (optional)' },
    async run({ action = 'list', text = '', query = '', tags = [] }, ctx) {
      const m = ctx.memory;
      if (action === 'remember') {
        if (!text) return { ok: false, error: { code: 'no_text', message: 'text missing' } };
        const r = m.remember(text, Array.isArray(tags) ? tags : [String(tags)]);
        return { result: `${r.ok ? 'saved' : 'could not save'} in memory (${r.count} entries total)${r.replaced ? `\nersatte: ${r.replaced}` : ''}\n${m.facts().slice(0, 8).map((f) => `- ${f}`).join('\n')}`, summary: 'minne uppdaterat' };
      }
      if (action === 'recall') {
        const hits = m.recall(query || text || '', 10);
        return { result: hits.length ? hits.map((h) => `[${h.score.toFixed(2)}] ${h.text}`).join('\n') : `no memories match "${query}"`, meta: { hits: hits.length }, summary: `${hits.length} minnen` };
      }
      if (action === 'forget') return { result: `removed ${(m.forget(query || text || '') || {}).removed} memory lines`, summary: 'forgotten' };
      if (action === 'clear') {
        fs.writeFileSync(m.factsFile, '# Minnen\n\n');
        return { result: 'memory cleared (facts.md). History and logs are kept.', summary: 'memory cleared' };
      }
      const f = m.facts();
      return { result: `${f.length} minnen (${m.dir}):\n${f.slice(0, 40).map((x) => `- ${x}`).join('\n')}\n\nstatistik: ${JSON.stringify(m.stats())}`, meta: m.stats(), summary: `${f.length} minnen` };
    },
  }),

  def({
    name: 'majin.skill',
    group: 'majin',
    risk: 'write',
    desc: 'Learned skills (markdown in data/skills): list | save | read | delete | match. A skill is how a kind of task is done, step by step.',
    params: { action: 'string: list | save | read | delete | match | report | enable [list|save|read|delete|match|report|enable] (optional)', name: 'string: name (optional)', when: 'string: when to use it (optional)', steps: 'string: the steps (markdown) (optional)', tools: 'array: tools it uses (optional)', query: 'string: for match (optional)', ok: 'boolean: did the skill work (report) (optional)', why: 'string: why it failed (report) (optional)' },
    async run({ action = 'list', name = '', when = '', steps = '', tools = '', query = '', ok = null, why = '' }, ctx) {
      const s = ctx.skills;
      if (action === 'report') {
        if (ok === null || ok === undefined) return { ok: false, error: { code: 'incomplete', message: 'name + ok required' } };
        const r = s.recordOutcome(name, { ok: Boolean(ok), why });
        if (!r.ok) return { ok: false, error: { code: 'not_found', message: r.why } };
        return { result: `skill "${name}": fails=${r.fails} streak=${r.streak}${r.disabled ? ' DISABLED (repeat failures — a human can majin.skill action=enable when the world changed)' : ''}`, meta: r, summary: `outcome ${r.disabled ? 'DISABLED' : 'recorded'}` };
      }
      if (action === 'enable') {
        const r = s.enable(name);
        return r.ok ? { result: `skill "${name}" re-enabled`, summary: 'skill enabled' } : { ok: false, error: { code: 'not_found', message: r.why } };
      }
      if (action === 'save') {
        if (!name || !steps) return { ok: false, error: { code: 'incomplete', message: 'name + steps required' } };
        const r = s.save({ name, when, steps, tools });
        return { result: `saved skill "${name}" → ${r.file}`, summary: `skill ${name} saved` };
      }
      if (action === 'delete') {
        try {
          await fsp.unlink(path.join(s.dir, `${name}.md`));
          return { result: `removed ${name}`, summary: `skill ${name} removed` };
        } catch (err) {
          return { ok: false, error: { code: 'delete_failed', message: err.message } };
        }
      }
      if (action === 'read') {
        try {
          return { result: fs.readFileSync(path.join(s.dir, `${name}.md`), 'utf8') };
        } catch {
          return { ok: false, error: { code: 'not_found', message: `ingen ${name}.md` } };
        }
      }
      if (action === 'match') {
        const hits = s.match(query || '', 5);
        /* WAVE 10: a deliberate lookup is a visit — count it on disk (by file
           slug, the same identity prompt() uses). */
        if (hits.length) s.hit(hits.map((h) => String(h.file).replace(/\.md$/, '')));
        return { result: hits.length ? hits.map((h) => `${h.name} (${h.score}) — ${h.when}`).join('\n') : 'no matching skills', meta: { hits: hits.length }, summary: `${hits.length} match` };
      }
      const list = s.list();
      return { result: `${list.length} skills in ${s.dir}:\n${list.map((x) => `- ${x.name}${x.when ? ` — ${x.when}` : ''}${x.tools ? ` [${x.tools}]` : ''}`).join('\n') || '(tom)'}`, meta: { count: list.length }, summary: `${list.length} skills` };
    },
  }),

  def({
    name: 'majin.schedule',
    group: 'majin',
    risk: 'write',
    desc: 'Scheduled work: add | list | remove | run | pause | resume. Requests like "every morning 07:30: do X and send it to telegram" belong here.',
    params: {
      action: 'string: add | list | remove | run | pause | resume [add|list|remove|run|pause|resume] (optional)',
      id: 'string: job id (for remove/pause/run) (optional)',
      when: 'string: "07:30 daily" | "every 30m" | "*/15 * * * *" | "2026-01-01T09:00" (optional)',
      task: 'string: what to run (the whole prompt) (optional)',
      readOnly: 'boolean: the job may only read; every tool that changes state is refused (optional)',
      deliver: 'string: telegram | whatsapp | silent (where the answer goes) (optional)',
      model: 'string: optional route for the job',
    },
    examples: ['majin.schedule({action:"add",when:"07:30 daily",task:"Short morning report: weather, my tickets, new security advisories. Deliver to telegram"})'],
    async run({ action = 'list', id = '', when = '', task = '', deliver = 'silent', model = '', readOnly = null }, ctx) {
      const sch = ctx.scheduler;
      if (!sch) return { ok: false, error: { code: 'no_scheduler', message: 'the scheduler is not running (server mode required)' } };
      if (action === 'add') {
        if (!when || !task) return { ok: false, error: { code: 'incomplete', message: 'when + task required' } };
        try {
          const job = sch.add({ when, task, deliver, model, name: id, readOnly });
          return { result: `schemalade "${job.name}" (${job.when}) → ${job.nextRun} (next: ${job.nextRunHuman})\nid=${job.id} deliver=${job.deliver}`, meta: job, summary: `jobb ${job.name} schemalagt` };
        } catch (err) {
          return { ok: false, error: { code: 'bad_schedule', message: err.message, hint: 'example: "07:30 daily", "every 30m", "*/15 * * * *"' } };
        }
      }
      if (action === 'remove') return { result: sch.remove(id) ? `removed ${id}` : `did not find ${id}`, summary: 'job removed' };
      if (action === 'pause' || action === 'resume') return { result: sch.setPaused(id, action === 'pause') ? `${action}d ${id}` : `did not find ${id}` };
      if (action === 'run') {
        const r = await sch.runNow(id);
        return r?.error ? { ok: false, error: { code: 'run_failed', message: r.error } } : { result: `ran ${id}: ${String(r.text).slice(0, 2000)}`, summary: `job ${id} ran` };
      }
      const jobs = sch.list();
      return { result: `${jobs.length} schemalagda jobb (enabled=${sch.enabled}):\n${jobs.map((j) => `- ${j.id} "${j.name}" ${j.when}${j.paused ? ' [PAUSAD]' : ''}\n    next: ${j.nextRun || '?'} | last: ${j.lastRun || 'aldrig'} ${j.lastStatus || ''}\n    uppgift: ${String(j.task).slice(0, 100)}`).join('\n') || '(none)'}`, meta: { jobs }, summary: `${jobs.length} jobb` };
    },
  }),

  def({
    name: 'majin.channel',
    group: 'majin',
    risk: 'write',
    desc: 'Channels: status | telegram | whatsapp | send | pair. Sets bot keys, links devices and sends messages.',
    params: {
      action: 'string: status | telegram | whatsapp | send | pair | unpair [status|telegram|whatsapp|send|pair|unpair] (optional)',
      token: 'string: Telegram bot-token (123456:ABC…) (optional)',
      transport: 'string: baileys | cloud (WhatsApp) [baileys|cloud] (optional)',
      phoneNumberId: 'string: WhatsApp Cloud API phone-number-id (optional)',
      accessToken: 'string: WhatsApp Cloud API token (optional)',
      verifyToken: 'string: optional secret for webhook verification',
      to: 'string: dit (chat-id eller telefonnummer) (optional)',
      text: 'string: the message body (optional)',
      channel: 'string: telegram | whatsapp (optional)',
      enable: 'boolean: start/stop the channel (optional)',
    },
    examples: ['majin.channel({action:"telegram",token:"123:ABC",enable:true})'],
    async run({ action = 'status', token = '', transport = '', phoneNumberId = '', accessToken = '', verifyToken = '', to = '', text = '', channel = '', enable = null }, ctx) {
      const ch = ctx.channels;
      if (action === 'status') {
        const s = ch?.status?.() || {};
        return {
          result: `channels\n${Object.entries(s).map(([k, v]) => `${v.online ? '✓' : '·'} ${k}: ${v.state}${v.detail ? ` — ${v.detail}` : ''}`).join('\n') || '(none)'}\n\nwhatsapp transport: ${ctx.cfg.get('channels.whatsapp.transport')}\ntelegram allowed chats: ${(ctx.cfg.get('channels.telegram.allowedChatIds') || []).join(', ') || '(none — pair first)'}\nwebhook for WhatsApp Cloud: http://<your-ip>:${ctx.cfg.get('server.port')}/whatsapp (verify-token = ${ctx.cfg.get('channels.whatsapp.cloud.verifyToken') || 'inte satt'})`,
          meta: s,
          summary: Object.entries(s).map(([k, v]) => `${k}:${v.state}`).join(' ') || 'inga kanaler',
        };
      }
      if (action === 'telegram') {
        const patch = { channels: { telegram: { enabled: enable !== false } } };
        if (token) patch.channels.telegram.botToken = token;
        const res = ctx.cfg.patch(patch, { source: 'channel.telegram' });
        if (!res.ok) return { ok: false, error: { code: 'invalid', message: res.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
        const ok = await ch?.telegram?.start?.();
        const me = await ch?.telegram?.getMe?.();
        return { result: ok ? `telegram went down (@${me?.username || me?.first_name}) — send "/start ${ch?.telegram?.pairingCode || ''}" to the bot to pair this chat` : `saved, but polling could not start: ${ch?.telegram?.lastError || 'unknown error'}`, summary: ok ? 'telegram connected' : 'telegram error' };
      }
      if (action === 'whatsapp') {
        const patch = { channels: { whatsapp: { enabled: enable !== false, transport: transport || ctx.cfg.get('channels.whatsapp.transport') || 'baileys' } } };
        if (accessToken) patch.channels.whatsapp.cloud = { ...(ctx.cfg.get('channels.whatsapp.cloud') || {}), accessToken };
        if (phoneNumberId) patch.channels.whatsapp.cloud = { ...(ctx.cfg.get('channels.whatsapp.cloud') || {}), phoneNumberId };
        if (verifyToken) patch.channels.whatsapp.cloud = { ...(ctx.cfg.get('channels.whatsapp.cloud') || {}), verifyToken };
        const res = ctx.cfg.patch(patch, { source: 'channel.whatsapp' });
        if (!res.ok) return { ok: false, error: { code: 'invalid', message: res.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
        const ok = await ch?.whatsapp?.start?.();
        const qr = ch?.whatsapp?.qr?.() || null;
        return {
          result: `${ok ? 'whatsapp started' : 'whatsapp could not start'} (transport ${patch.channels.whatsapp.transport})${qr ? `\nQR to scan (link code): ${qr}` : ''}${!ok && !qr ? `\n${ch?.whatsapp?.lastError || 'unknown error — check that optionalDependencies are installed (npm i)'}` : ''}`,
          meta: { qr, transport: patch.channels.whatsapp.transport },
          summary: ok ? 'whatsapp started' : 'whatsapp stoppad',
        };
      }
      if (action === 'send') {
        const target = to || (channel === 'whatsapp' ? undefined : ctx.cfg.get('channels.telegram.allowedChatIds')?.[0]);
        if (!text) return { ok: false, error: { code: 'no_text', message: 'text missing' } };
        if (!target) return { ok: false, error: { code: 'no_target', message: 'set a target (chat id or phone number)' } };
        const r = await ch?.send?.(channel || 'telegram', target, text);
        return r?.ok ? { result: `sent to ${channel || 'telegram'}:${target}`, summary: 'message sent' } : { ok: false, error: { code: 'send_failed', message: r?.error || 'no channel active' } };
      }
      if (action === 'pair') {
        const code = ch?.pair?.(channel || 'telegram', to);
        return { result: code ? `pairing code ${code} — the user sends "pair ${code}" till botten` : 'pairing is not supported for that channel' };
      }
      if (action === 'unpair') {
        const list = (ctx.cfg.get('channels.telegram.allowedChatIds') || []).filter((x) => String(x) !== String(to));
        ctx.cfg.patch({ channels: { telegram: { allowedChatIds: list } } });
        return { result: `removed ${to} from the allow list (${list.length} left)` };
      }
      return { ok: false, error: { code: 'bad_action', message: action } };
    },
  }),

  def({
    name: 'majin.status',
    group: 'majin',
    risk: 'read',
    desc: 'Full status: config, routes, MOA, channels, external RE tools, budget, memory, skills, jobs, log path. Use it when the user asks "how are you doing?".',
    params: { verbose: 'boolean: med allt (optional)' },
    async run({ verbose = false }, ctx) {
      const cfg = ctx.cfg;
      const re = await detectRe({}).catch(() => ({}));
      const u = ctx.usage?.summary?.() || {};
      const out = {
        version: VERSION,
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        uptimeS: Math.round(process.uptime()),
        pid: process.pid,
        workspace: cfg.get('workspace'),
        config: cfg.file,
        dataDir: dirs.root,
        providers: ctx.statusProviders(),
        routes: Object.fromEntries(cfg.routeTable().map((r) => [r.job, `${r.ref}${r.ready ? '' : ' (no key)'}`])),
        moa: cfg.get('moa'),
        guard: { mode: cfg.get('guard.mode'), autoApprove: cfg.get('guard.autoApprove') },
        tools: { total: ctx.registry.tools.length, groups: Object.keys(ctx.registry.groups()).length, filter: cfg.get('tools.allow') },
        channels: ctx.channels?.status?.() || {},
        reTools: Object.fromEntries(Object.entries(re).map(([k, v]) => [k, v.available ? v.path : 'missing'])),
        memory: ctx.memory?.stats?.(),
        skills: ctx.skills?.list?.().length,
        schedule: { jobs: ctx.scheduler?.list?.().length ?? 0, enabled: ctx.scheduler?.enabled },
        usage: u,
        approvals: (ctx.approvals?.list?.() || []).map((a) => ({ id: a.id, tool: a.tool, reason: a.reason })),
      };
      if (!verbose) {
        for (const k of ['moa', 'tools', 'reTools', 'memory']) delete out[k];
      }
      return { result: JSON.stringify(out, null, 1), meta: out, summary: `routes ${Object.keys(out.routes).length} · uppgick ${out.channels ? Object.values(out.channels).filter((c) => c.online).length : 0} kanaler · ${out.usage.requests || 0} anrop ${out.usage.costUsd || 0} USD` };
    },
  }),

  def({
    name: 'majin.doctor',
    group: 'majin',
    risk: 'read',
    desc: 'Health check, human style: every capability gets OK / why-not / how-to-fix. Use it when something feels off, before the user asks you to guess. No network calls — it reads config and reports, then points at the exact tool or card that fixes each problem.',
    params: {},
    examples: ['majin.doctor({})'],
    async run(_args, ctx) {
      const cfg = ctx.cfg;
      const lines = [];
      const status = cfg.providerStatus();
      const ready = status.filter((p) => p.ready && p.kind !== 'mock');
      const routes = cfg.routeTable();
      /* 1) AI key: the one thing everything hangs on */
      if (ready.length) {
        lines.push(`OK    ai-key    ${ready.length} provider(s) can answer (${ready.map((p) => p.name).join(', ')})`);
      } else {
        lines.push('FIX   ai-key    no real provider has a key — MAJIN can only fake answers. Fix: paste a key in the wizard (», » model chip) or majin.provider({action:"add",name:"deepseek",apiKey:"sk-…"})');
      }
      /* 2) routes must land on providers that can ANSWER */
      const names = new Set(ready.map((p) => p.name));
      const dead = routes.filter((r) => !names.has(r.ref.split('/')[0]) && !String(r.ref).startsWith('demo/'));
      if (!dead.length) lines.push(`OK    routes    all ${routes.length} routes point at providers that can answer`);
      else lines.push(`FIX   routes    ${dead.length} route(s) point at a provider with no working key (${dead.slice(0, 4).map((r) => r.job + '→' + r.ref).join(', ')}). Fix: open the model chip and pick one model — every route follows it.`);
      /* 3) single-model sanity: MOA must be a choice, not an accident */
      const policy = cfg.get('moa.policy');
      if (policy === 'off') lines.push('OK    moa      off — one model, no hidden multi-call cost');
      else lines.push(`NOTE  moa      policy '${policy}' — every answer calls several models (costs multiply). If that was not your idea: MOA chip in the header, or majin.moa({action:"off"}).`);
      /* 4) memory + scheduler exist at all */
      const memCount = ctx.memory?.stats?.()?.lines;
      lines.push(memCount !== undefined ? `OK    memory    ${memCount} stored line(s)` : 'NOTE  memory    memory service not attached in this context — restart the app if it stays away');
      /* 5) channels (optional by design) */
      const ch = ctx.channels?.status?.() || {};
      const on = Object.entries(ch).filter(([, v]) => v && v.online).map(([k]) => k);
      lines.push(on.length ? `OK    channels  ${on.join(', ')} online` : 'OK    channels  none configured (optional — desktop always works)');
      /* 6) guard mode */
      const mode = cfg.get('guard.mode');
      lines.push(`OK    guard     mode '${mode}'`);
      const broken = lines.filter((l) => l.startsWith('FIX')).length;
      const verdict = broken === 0 ? 'HEALTHY — every checked piece is in place.' : (broken === 1 ? 'ONE THING needs attention — see the FIX line.' : `${broken} things need attention — see the FIX lines.`);
      return { result: verdict + '\n\n' + lines.join('\n'), meta: { verdict, broken, lines }, summary: verdict };
    },
  }),

  def({
    name: 'majin.selftest',
    group: 'majin',
    risk: 'read',
    desc: 'Diagnostics: provider keys, one real minimal call per provider, the tool registry, an RE check on its own binary, channel status, port, writability. Run this when something behaves oddly.',
    params: { level: 'string: quick | full [quick|full] (optional)' },
    async run({ level = 'quick' }, ctx) {
      const out = [];
      // ok=null betyder "kan inte testa / inte konfigurerad" — inte ett fel, så en ny
      // installation ser grön ut i stället för två skräckfyllda rader.
      const push = (ok, label, detail = '') => out.push(`${ok === null ? 'ℹ' : ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
      try {
        fs.accessSync(ctx.cfg.file, fs.constants.R_OK | fs.constants.W_OK);
        push(true, 'config writable', ctx.cfg.file);
      } catch (e) {
        push(false, 'config writable', e.message);
      }
      const routes = ctx.cfg.routeTable();
      const ready = routes.filter((r) => r.ready);
      push(ready.length > 0, 'providers with a key', ready.map((r) => r.provider).filter(unique).join(', ') || 'NONE — add a key');
      if (level === 'full' && ready.length) {
        for (const p of [...new Set(ready.map((r) => r.provider))]) {
          const route = ctx.cfg.resolveModel(ctx.cfg.get('models.routes.tasks').startsWith(`${p}/`) ? ctx.cfg.get('models.routes.tasks') : `${p}/${(ctx.cfg.get(`providers.${p}.models`) || [])[0]}`, 'test');
          const t0 = Date.now();
          try {
            const r = await complete({ route, job: 'selftest', stream: false, maxTokens: 12, temperature: 0, messages: [{ role: 'user', content: 'Reply exactly: OK' }] });
            push(true, `call ${route.ref}`, `${Date.now() - t0}ms "${(r.text || '').trim().slice(0, 20)}"`);
          } catch (err) {
            push(false, `call ${route.ref}`, `${String(err.message).slice(0, 120)}`);
          }
        }
      }
      const n = ctx.registry.tools.length;
      push(n > 20, 'tool registry', `${n} tools, all on (filter: ${ctx.cfg.get('tools.allow') === '*' ? 'off' : 'on'})`);
      try {
        const self = fs.readFileSync(process.execPath);
        const { analyze } = await import('../binary/index.js');
        const r = analyze(self.subarray(0, 4_000_000), { name: 'node', rules: [] });
        push(true, 'RE engine', `read node (${r.kind}, ${r.sections?.length || 0} sections, ${r.importCount || 0} imports)`);
      } catch (err) {
        push(false, 'RE engine', err.message);
      }
      const re = await detectRe({}).catch(() => ({}));
      push(true, 'external RE tools', Object.values(re).filter((v) => v.available).map((v) => v.label.split(' ')[0]).join(', ') || 'none (all optional)');
      try {
        const { listRules } = await import('../binary/yara.js');
        const rules = typeof listRules === 'function' ? listRules(ctx.cfg) : null;
        push(true, 'yara rules', rules ? `${rules.length} rule file(s)` : 'built-in rules');
      } catch {
        push(true, 'yara rules', 'built-in rules');
      }
      // Kanaler: okonfigurerade är inte fel — de är avstängda. Ett fel som aldrig
      // kan åtgärdas av användaren gör att varje ny installation ser trasig ut.
      const st = ctx.channels?.status?.() || {};
      for (const [k, v] of Object.entries(st)) {
        if (!v || typeof v !== 'object') continue;
        if (v.online) push(true, `channel ${k}`, v.state || 'online');
        else if (v.state === 'error') push(false, `channel ${k}`, v.lastError || 'error');
        else push(null, `channel ${k}`, `${v.state || 'off'}${v.lastError ? ` — ${v.lastError}` : ''}${v.hint ? ` · ${v.hint}` : ''}`);
      }
      const port = ctx.cfg.get('server.port');
      const tokenSet = Boolean(ctx.cfg.get('server.token'));
      push(true, 'ui port', `http://127.0.0.1:${port} (${tokenSet ? 'token set, redacted here' : 'NO TOKEN — anyone on the LAN can drive MAJIN'})`);
      push(ctx.cfg.get('server.allowRemote') !== true, 'remote bind', `host ${ctx.cfg.get('server.host')} · allowRemote ${ctx.cfg.get('server.allowRemote') ? 'ON' : 'off'}`);
      try {
        fs.mkdirSync(ctx.cfg.get('workspace'), { recursive: true });
        fs.accessSync(ctx.cfg.get('workspace'), fs.constants.W_OK);
        push(true, 'workspace writable', ctx.cfg.get('workspace'));
      } catch (e) {
        push(false, 'workspace writable', e.message);
      }
      const fails = out.filter((l) => l.startsWith('✗')).length;
      const skips = out.filter((l) => l.startsWith('ℹ')).length;
      return { result: `selftest ${level} (${fails} errors${skips ? `, ${skips} skipped` : ''}):\n${out.join('\n')}`, ok: fails === 0, meta: { fails, skipped: skips }, summary: fails ? `${fails} selftest errors` : 'all green' };
    },
  }),

  def({
    name: 'majin.tools',
    group: 'majin',
    risk: 'read',
    desc: 'List every tool with its description and risk level. All of them are always on — there is no off switch.',
    params: { group: 'string: filter by group (optional)', describe: 'string: tool name for the full description (optional)' },
    async run({ group = '', describe = '' }, ctx) {
      if (describe) {
        const t = ctx.registry.byName.get(describe);
        if (!t) return { ok: false, error: { code: 'no_tool', message: `no tool ${describe}`, hint: ctx.registry.list().map((x) => x.name).slice(0, 20).join(', ') } };
        return { result: `${t.name} [${t.risk}] — ${t.desc}\nparametrar:\n${JSON.stringify(t.parameters, null, 1)}${t.examples?.length ? `\n\nexempel:\n${t.examples.join('\n')}` : ''}`, summary: t.name };
      }
      const groups = ctx.registry.groups();
      const body = Object.entries(groups)
        .filter(([g]) => !group || g.includes(group))
        .map(([g, list]) => `${g} (${list.length}):\n${list.map((t) => `  ${t.name.padEnd(18)} ${t.risk.padEnd(12)} ${t.desc.split('. ')[0].slice(0, 110)}`).join('\n')}`)
        .join('\n\n');
      return { result: `${ctx.registry.tools.length} tools, all enabled:\n\n${body}`, meta: { total: ctx.registry.tools.length, groups: Object.keys(groups).length }, summary: `${ctx.registry.tools.length} tools` };
    },
  }),

  def({
    name: 'majin.backup',
    group: 'majin',
    risk: 'write',
    desc: 'Export/import everything MAJIN knows (config, memory, skills, schedules) as a tar.gz in workspace/backups.',
    params: { action: 'string: export | list | restore [export|list|restore] (optional)', file: 'string: archive to restore (optional)' },
    async run({ action = 'list', file }, ctx) {
      const dir = path.join(ctx.cfg.get('workspace'), 'backups');
      await fsp.mkdir(dir, { recursive: true });
      if (action === 'list') {
        const items = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.startsWith('majin-backup'));
        return { result: `${items.length} backuper i ${dir}\n${items.map((i) => `- ${i}`).join('\n') || '(none)'}`, meta: { dir, items }, summary: `${items.length} backuper` };
      }
      const { spawnSync } = await import('node:child_process');
      const stamp = new Date().toISOString().replace(/[:.]/g, '');
      if (action === 'export') {
        const out = path.join(dir, `majin-backup-${stamp}.tar.gz`);
        const roots = [ctx.cfg.file, dirs.memory, dirs.skills, dirs.plugins, dirs.sessions, dirs.rules].filter((p) => fs.existsSync(p));
        const r = spawnSync('tar', ['-czf', out, '-C', dirs.root, ...roots.map((p) => path.relative(dirs.root, p))], { encoding: 'utf8' });
        if (r.status !== 0) return { ok: false, error: { code: 'tar_failed', message: r.stderr || 'tar is not installed' } };
        return { result: `backupeade ${roots.length} delar → ${out} (${fs.statSync(out).size} byte)`, summary: 'backup klar' };
      }
      const src = file ? path.resolve(file) : null;
      if (!src || !fs.existsSync(src)) return { ok: false, error: { code: 'no_archive', message: 'set file to point at a backup' } };
      const r = spawnSync('tar', ['-xzf', src, '-C', dirs.root], { encoding: 'utf8' });
      if (r.status !== 0) return { ok: false, error: { code: 'restore_failed', message: r.stderr || 'unknown error' } };
      return { result: `restored from ${src}. Restart MAJIN for the config to take full effect.`, summary: 'restore done' };
    },
  }),

  def({
    name: 'majin.ui',
    group: 'majin',
    risk: 'read',
    desc: 'Open the UI: on Windows a dedicated Edge/Chrome app window. action=open | theme | voice.',
    params: { action: 'string: open | theme | voice | wake [open|theme|voice|wake] (optional)', theme: 'string: jarvis | arc | minimal (optional)', voice: 'boolean: tts on/off (optional)', wake: 'boolean: wake word on/off (optional)' },
    async run({ action = 'open', theme = '', voice = null, wake = '' }, ctx) {
      if (action !== 'open') {
        const ui = { ...(ctx.cfg.get('ui') || {}) };
        if (theme) ui.theme = theme;
        if (voice !== undefined) ui.voice = Boolean(voice);
        if (wake !== undefined) ui.wake = Boolean(wake);
        ctx.cfg.patch({ ui });
        return { result: `ui: ${Object.entries(ui).map(([k, v]) => `${k}=${v}`).join(', ')}`, summary: 'ui updated' };
      }
      const url = `http://127.0.0.1:${ctx.cfg.get('server.port')}/?token=${ctx.cfg.get('server.token')}`;
      const { spawn } = await import('node:child_process');
      const isWin = process.platform === 'win32';
      const candidates = isWin
        ? [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'chrome.exe']
        : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'xdg-open'];
      for (const c of candidates) {
        try {
          const args = c.endsWith('xdg-open') ? [url] : [`--app=${url}`, '--window-size=1280,860', '--user-data-dir=' + path.join(dirs.cache, 'browser')];
          const child = spawn(c, args, { detached: true, stdio: 'ignore', windowsHide: false });
          child.unref();
          return { result: ` opened ${c} → ${url}`, summary: 'ui opened' };
        } catch {
          /* next candidate */
        }
      }
      return { ok: false, error: { code: 'no_browser', message: 'found no browser', hint: `open ${url} manually` } };
    },
  }),

  def({
    name: 'majin.control',
    group: 'majin',
    risk: 'write',
    desc: 'Control the agent itself: restart | stop | pause | resume | clear (session) | sessions | history.',
    params: { action: 'string: restart | stop | pause | resume | clear | sessions | history [restart|stop|pause|resume|clear|sessions|history] (optional)', session: 'string: session (default active) (optional)', limit: 'number: lines for history (optional)' },
    async run({ action = 'sessions', session = 'desktop', limit = 40 }, ctx) {
      if (action === 'sessions') {
        const list = await fsp.readdir(dirs.sessions).catch(() => []);
        return { result: list.map((f) => `- ${f.replace(/\.jsonl$/, '')} (${fs.statSync(path.join(dirs.sessions, f)).size} bytes)`).join('\n') || '(no sessions)', meta: { list }, summary: `${list.length} sessions` };
      }
      if (action === 'history') {
        const file = path.join(dirs.sessions, `${session}.jsonl`);
        try {
          const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-Number(limit));
          return { result: lines.map((l) => {
            const o = JSON.parse(l);
            return `${o.ts?.slice(11, 19) || ''} ${o.role}: ${String(o.content).replace(/\s+/g, ' ').slice(0, 160)}`;
          }).join('\n'), summary: `${lines.length} history lines` };
        } catch {
          return { ok: false, error: { code: 'no_history', message: `no history for ${session}` } };
        }
      }
      if (action === 'clear') {
        await fsp.rm(path.join(dirs.sessions, `${session}.jsonl`), { force: true });
        return { result: `cleared session ${session} (memory and skills are kept)`, summary: 'session cleared' };
      }
      if (action === 'pause') {
        ctx.pause();
        return { result: 'paused — I will not take new turns until you say resume', summary: 'paused' };
      }
      if (action === 'resume') {
        ctx.resume();
        return { result: 'resumed', summary: 'resumed' };
      }
      if (action === 'restart' || action === 'stop') {
        bus.warn('agent.self', { action });
        setTimeout(() => process.exit(action === 'restart' ? 75 : 0), 400).unref?.();
        return { result: action === 'restart' ? 'restarting now (majin start --window will bring it back if a launcher is used)' : 'shutting down', summary: action };
      }
      return { ok: false, error: { code: 'bad_action', message: action } };
    },
  }),

  def({
    name: 'majin.dataset',
    group: 'majin',
    risk: 'write',
    desc:
      'Local trajectory recording used to make MAJIN better. OFF by default, redacted on write, stored next to the config, '
    + 'and never uploaded — exporting is a deliberate command you run.',
    params: {
      action: 'string: status | on | off | stats | list | export | purge | rate (optional)',
      query: 'string: which turn to rate (empty = the newest) (optional)',
      score: 'number: 1 or -1 for rate (optional)',
      id: 'string: record id for purge (optional)',
      before: 'string: purge everything older than this ISO date (optional)',
      clean: 'boolean: export metadata only, no question or answer text (optional)',
      limit: 'number: how many records to list (default 8) (optional)',
    },
    examples: ['majin.dataset({action:"stats"})', 'majin.dataset({action:"export",clean:true})', 'majin.dataset({action:"on"})'],
    async run({ action = 'status', query = '', score = 1, id = null, before = null, clean = false, limit = 8 }, ctx) {
      const ds = ctx.dataset;
      if (!ds) return { ok: false, error: { code: 'no_dataset', message: 'the dataset module is not wired into this build' } };
      if (action === 'on' || action === 'off') {
        const r = ctx.cfg.patch({ dataset: { capture: action === 'on' } }, { source: `tool:majin.dataset:${action}` });
        if (!r.ok) return { ok: false, error: { code: 'invalid_config', message: (r.errors || []).map((e) => `${e.path}: ${e.msg}`).join('; ') } };
        return {
          result:
            `dataset capture ${action === 'on' ? 'ON' : 'OFF'} — ${action === 'on' ? `writing to ${ds.file()} after redaction; nothing leaves this machine unless you export it` : 'nothing new is recorded; existing records stay on disk'}`,
          summary: `capture ${action === 'on' ? 'on' : 'off'}`,
          meta: { capture: action === 'on', file: ds.file() },
        };
      }
      if (action === 'upload') return { ok: false, error: { code: 'upload_disabled', message: 'MAJIN has no upload path at all — export the file yourself if you want to share it' } };
      if (action === 'stats') {
        const st = ds.stats();
        return {
          result: `records: ${st.records} · ${Math.round(st.bytes / 1024)} kB · rated ${st.rated}${st.avgRating == null ? '' : ` (avg ${st.avgRating})`} · avg tool calls ${st.avgToolCalls ?? 0} · errors ${st.errors}\nfile: ${st.file}\ncapture: ${ds.on ? 'on' : 'off (this is why it is empty)'}\ndays: ${st.days.join(', ') || '—'}`,
          meta: st,
          summary: `${st.records} records`,
        };
      }
      if (action === 'list') {
        const rows = ds.read().slice(-Math.max(1, Number(limit) || 8)).reverse();
        if (!rows.length) return { result: 'no records yet — capture is ' + (ds.on ? 'on but nothing has been asked of me' : 'off'), meta: { count: 0 } };
        return {
          result: rows.map((r) => `${r.id}  ${r.at}  ${r.rating == null ? ' unrated' : ` ${r.rating > 0 ? '👍' : '👎'}`}  ${String(r.instruction).slice(0, 70).replace(/\n/g, ' ')}`).join('\n'),
          meta: { count: rows.length, ids: rows.map((r) => r.id) },
          summary: `${rows.length} records`,
        };
      }
      if (action === 'export') {
        const r = ds.export({ clean: Boolean(clean) });
        return r.ok
          ? { result: `exported ${r.records} records → ${r.file} (${Math.round(r.bytes / 1024)} kB, JSONL)${clean ? ' — metadata only, no question/answer text' : ''}\nReview it before you send it anywhere: it is redacted, not guaranteed anonymous.`, meta: r, summary: `export ${r.records} records` }
          : { ok: false, error: { code: 'export_failed', message: r.error } };
      }
      if (action === 'purge') {
        const r = ds.purge({ id, before, all: !id && !before });
        return r.ok ? { result: `removed ${r.removed} records, ${r.left} left in ${ds.file()}`, meta: r, summary: `purged ${r.removed}` } : { ok: false, error: { code: 'bad_request', message: r.error } };
      }
      if (action === 'rate') {
        const r = ds.rate(query, Number(score) || 0);
        return r.ok ? { result: `rated ${r.id} as ${r.rating > 0 ? 'good' : 'bad'}`, meta: r } : { ok: false, error: { code: 'not_found', message: r.error } };
      }
      return { ok: false, error: { code: 'bad_action', message: `${action} — use status|on|off|stats|list|export|purge|rate` } };
    },
  }),

  def({
    name: 'majin.adapter',
    group: 'majin',
    risk: 'write',
    desc: 'Safe external adapters (Del 7B): validate | create | list | remove. An adapter is a DECLARATIVE http-json descriptor (no code, https only, permission class read | external-write | external-post); an invalid adapter is never written to disk.',
    params: {
      action: 'string: validate | create | list | remove | call | enable',
      spec: 'object: {name, kind:"http-json", baseUrl, permission, headers, mapping, timeoutMs, rate:{maxPerHour}}',
      name: 'string: adapter name (for remove | call | enable)',
      params: 'object: request payload for call (params for GET, json body for POST). optional [call only]',
      approved: 'boolean: only ever true after the HUMAN said yes — required for external-write/external-post. optional [call only]',
    },
    async run({ action = 'list', spec = null, name = '', params = {}, approved = false }, ctx) {
      const a = ctx.adapters;
      if (!a) return { ok: false, error: { code: 'no_adapters', message: 'adapter store missing' } };
      if (action === 'validate') {
        const issues = validateAdapter(spec || {});
        return { result: issues.length ? `INVALID:\n- ${issues.join('\n- ')}` : 'valid', meta: { issues, valid: !issues.length }, summary: issues.length ? `${issues.length} issue(s)` : 'valid' };
      }
      if (action === 'create') {
        const r = a.create(spec || {});
        if (!r.ok) return { ok: false, error: { code: 'invalid_adapter', message: `refused — adapter is NEVER written when it fails validation:\n- ${(r.issues || []).join('\n- ')}`, hint: 'fix the spec; close adapters are validated hard' } };
        return { result: `adapter \"${r.adapter.name}\" created (${r.adapter.permission}, ${r.adapter.baseUrl})`, meta: { adapter: r.adapter }, summary: 'adapter created' };
      }
      if (action === 'remove') {
        const r = a.remove(name);
        return r.ok ? { result: `removed ${name}`, summary: 'adapter removed' } : { ok: false, error: { code: 'not_found', message: r.why } };
      }
      if (action === 'enable') {
        const r = a.enable(name);
        return r.ok ? { result: `adapter "${name}" re-enabled (failure counters cleared)`, summary: 'adapter enabled' } : { ok: false, error: { code: 'not_found', message: r.why } };
      }
      if (action === 'call') {
        const r = await a.call(name, { params: params && typeof params === 'object' ? params : {}, approved: Boolean(approved), approvals: ctx.approvals, session: ctx.session });
        if (!r.ok) return r;
        return { result: JSON.stringify(r.rows, null, 1).slice(0, 10000), meta: { adapter: r.adapter, status: r.status, rows: r.rows.length, method: r.method }, summary: `${r.rows.length} rows from ${name}` };
      }
      const list = a.list();
      return { result: `${list.length} adapters in ${a.dir}:\n${list.map((x) => `- ${x.name} [${x.permission}] ${x.baseUrl}`).join('\n') || '(none)'}`, meta: { count: list.length }, summary: `${list.length} adapters` };
    },
  }),
];

function done(ctx, patch, msg) {
  const res = ctx.cfg.patch(patch, { source: 'tool' });
  if (!res.ok) return { ok: false, error: { code: 'invalid', message: res.errors.map((e) => `${e.path}: ${e.msg}`).join('; ') } };
  bus.info('config.changed', { patch, notes: msg });
  return { result: `${msg}\nDiff:\n${res.diff.map((d) => `  ${d.path}: ${short(d.from)} → ${short(d.to)}`).join('\n')}`, meta: { diff: res.diff }, summary: msg.slice(0, 80) };
}

export function routeLines(ctx) {
  return ctx.cfg
    .routeTable()
    .map((r) => `  ${r.job.padEnd(11)} ${r.ref}${r.ready ? '' : '   ← ingen nyckel'}`)
    .join('\n');
}

function providerLines(ctx) {
  return ctx.cfg
    .providerStatus()
    .map((p) => `  ${p.ready ? '✓' : '·'} ${p.name.padEnd(12)} ${p.kind.padEnd(8)} ${p.baseUrl || '-'} ${p.ready ? '' : '(NO KEY)'}`)
    .join('\n');
}

function short(v) {
  const s = typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? '—');
  return s.length > 60 ? `${s.slice(0, 57)}…` : s || '—';
}

function unique(x, i, a) {
  return a.indexOf(x) === i;
}
