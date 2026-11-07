/**
 * MAJIN — natural-language self-config.
 * "använd deepseek pro för kod alltid och deepseek flash för tasks"
 *  → en riktig config-patch, validerad, med diff. Ingen meny behövs.
 * Det här är genvägen som körs FÖRE modellen: deterministic, gratis, och den
 * fungerar även med en liten modell. Modellen får ändå skriva patch direkt.
 */
import { PRESETS } from './presets.js';
import { JOBS, DEFAULTS, getPath } from './config.js';

const JOB_WORDS = [
  { job: 're', words: ['reverse', 're', 'reversing', 'binär', 'binar', 'binary', 'ghidra', 'ida', 'rizin', 'malware', 'virus', 'dump', 'exploit', 'packer', 'apk', 'pe', 'elf'] },
  { job: 'code', words: ['kod', 'code', 'coding', 'program', 'programming', 'utveckling', 'dev', 'bygg', 'build', 'compile', 'refactor', 'bugg', 'bug', 'fix', 'test', 'python', 'javascript', 'typescript', 'js', 'ts', 'api'] },
  { job: 'tasks', words: ['tasks', 'task', 'jobb', 'uppgifter', 'uppgift', 'gör', 'automation', 'batch', 'filer', 'mappar', 'pyssel', 'småjobb', 'tools', 'verktyg'] },
  { job: 'chat', words: ['chat', 'chatt', 'prata', 'svara', 'smalltalk', 'lätt', 'enkla', 'snabb'] },
  { job: 'final', words: ['slutsvar', 'final', 'svaret', 'svar', 'answer', 'syntes'] },
  { job: 'plan', words: ['plan', 'planering', 'planera', 'arkitektur', 'design', 'structure'] },
  { job: 'research', words: ['research', 'undersök', 'sök', 'search', 'web', 'webb', 'källor', 'nyheter'] },
  { job: 'summarize', words: ['sammanfatt', 'summera', 'summarize', 'kompakt', 'brief', 'klipp'] },
  { job: 'aggregator', words: ['moa', 'aggregator', 'aggregera', 'samla', 'mixture'] },
  { job: 'vision', words: ['bild', 'vision', 'skärm', 'screenshot', 'foto', 'image'] },
  { job: 'router', words: ['router', 'klassificera', 'routing'] },
  { job: 'analysis', words: ['analys', 'analysera', 'rapport', 'jämför', 'jamfor', 'statistik', 'mät', 'mat', 'report'] },
  { job: 'tools', words: ['verktyg', 'tools', 'kör', 'exekvera', 'shell', 'terminal'] },
];

const JOB_ALIASES = {
  analys: 'analysis',
  analyse: 'analysis',
  analyser: 'analysis',
  programmering: 'code',
  småjobb: 'tasks',
  allt: '*',
  allting: '*',
  alla: '*',
  everything: '*',
  programming: 'code',
  automation: 'tasks',
};

function flatten(list) {
  const out = [];
  for (const e of list) {
    if (typeof e === 'string') out.push(e);
    else if (Array.isArray(e)) out.push(...e);
  }
  return out;
}

const WORD_TO_JOB = new Map();
for (const entry of flatten([JOB_WORDS, Object.entries(JOB_ALIASES).map(([w, job]) => [{ job, words: [w] }])])) {
  for (const w of entry.words || []) WORD_TO_JOB.set(String(w).toLowerCase(), entry.job);
}
for (const j of JOBS) WORD_TO_JOB.set(j, j);

/** Find "deepseek pro" → deepseek/deepseek-v4-pro style refs from free text. */
export function findModelRefs(text, cfg) {
  const s = String(text).toLowerCase();
  const out = [];
  const get = (key) => (cfg && typeof cfg.get === 'function' ? cfg.get(key) : getPath(DEFAULTS, key));
  const providers = Object.keys(get('providers') || {});
  const known = [];
  for (const p of [...providers, ...Object.keys(PRESETS)]) {
    const preset = PRESETS[p];
    const cfgProvider = get(`providers.${p}`) || {};
    for (const m of [...(cfgProvider.models || []), ...(preset?.models || [])]) {
      if (!known.includes(m)) known.push(m);
    }
  }
  const push = (provider, model) => {
    if (!out.some((o) => o.ref === `${provider}/${model}`)) out.push({ provider, model, ref: `${provider}/${model}` });
  };

  const re = new RegExp(`\\b(${[...providers, ...Object.keys(PRESETS)].join('|')})\\b`, 'g');
  let m;
  const providerHits = [];
  while ((m = re.exec(s))) if (!providerHits.includes(m[1])) providerHits.push(m[1]);

  /* "openrouter/deepseek/foo" är exakt angivet — låt inte gissningar addera fel ref. */
  const slashed = /\b([a-z0-9][a-z0-9._+-]*)\/([a-z0-9][a-z0-9./_-]*)/g;
  let sl;
  let slashedOnly = false;
  while ((sl = slashed.exec(s))) {
    if (!providers.includes(sl[1])) continue;
    push(sl[1], sl[2].replace(/[.,;:]$/, ''));
    slashedOnly = true;
  }
  if (slashedOnly) return out;

  const flavor = {
    pro: /(^|[^a-z])(pro\b|tung|strong|smart|klok|max|reasoner|thinking)/,
    flash: /(flash|snabb|billig|cheap|litet|mini|turbo|fast|lätt|lett)/,
  };

  for (const explicit of s.match(/\b[a-z0-9][a-z0-9._-]*(?:-[a-z0-9._-]+)+\b/g) || []) {
    for (const p of providerHits.length ? providerHits : providers) {
      const cfgP = get(`providers.${p}`) || {};
      const preset = PRESETS[p] || {};
      const models = [...(cfgP.models || []), ...(preset.models || [])];
      for (const model of models) {
        const bare = model.includes('/') ? model.split('/').pop() : model;
        if (explicit === model || explicit === bare || model.endsWith(explicit) || explicit.endsWith(bare)) push(p, model);
      }
    }
  }
  for (const p of providerHits) {
    const cfgP = get(`providers.${p}`) || {};
    const preset = PRESETS[p] || {};
    const models = [...new Set([...(cfgP.models || []), ...(preset.models || [])])];
    if (!models.length) continue;
    for (const [key, rx] of Object.entries(flavor)) {
      if (!rx.test(s)) continue;
      const hit = models.find((model) => {
        const bare = (model.includes('/') ? model.split('/').pop() : model).toLowerCase();
        return key === 'pro' ? /pro|max|reason|think|strong/.test(bare) : /flash|mini|turbo|fast|lite|small/.test(bare);
      });
      if (hit) push(p, hit);
    }
    if (!out.some((o) => o.provider === p)) push(p, models[0]);
  }
  return out;
}

function jobForWord(word) {
  const w = String(word || '').toLowerCase().replace(/[.,;:!?]/g, '');
  return WORD_TO_JOB.get(w) || (JOBS.includes(w) ? w : null);
}

/**
 * @returns {{ok:boolean, patch:object, notes:string[], matched:boolean}}
 */
export function parseIntent(text, cfg) {
  const s = String(text || '');
  const low = s.toLowerCase();
  const patch = {};
  const notes = [];
  let matched = false;
  let m;

  /* 1) API key: "here is my key sk-…", "set the deepseek key to sk-…".
     Kravet på avstånd (<= 40 tecken mellan avsiktsordet och nyckeln) är hela poängen: en
     användare som klistrar in en logg eller frågar om en fil som råkar nämna en nyckel får
     inte sin config överskriven. */
  const keyHit =
    /(?:nyckel|key|token|apikey|api_key)[\s,:=-]{0,8}(?:är|is|:|=)[\s,:=-]{0,8}[`'"]?((?:sk|pk|ghp|xoxb|nanogpt|AIza)[-\w]{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})[`'"]?/i.exec(s) ||
    /\b(?:set|sätt|use|använd|byta?ter|here|här|save|spara)\b[^.\n]{0,40}?((?:sk|pk)-[A-Za-z0-9_-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/i.exec(s) ||
    /* bara nyckeln i meddelandet = entydig avsikt, inget att misstolka */
    /^\s*[`'"]?((?:sk|pk)-[A-Za-z0-9_-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})[`'"]?\s*$/.exec(s);  // a message that is only a key
  if (keyHit) {
    const hit = /(kilo(?:code)?|deepseek|openrouter|groq|anthropic|openai|gemini|nous|ollama|lmstudio|portal)[^\w]?/i.exec(s)?.[1];
    // "kilo" is how people write it; the preset is named kilocode
    const provider = (hit ? (hit.toLowerCase() === 'kilo' ? 'kilocode' : hit.toLowerCase()) : null) || cfg.get('models.provider') || 'deepseek';
    patch.providers = patch.providers || {};
    patch.providers[provider] = { apiKey: keyHit[1] };
    notes.push(`saved the key as provider "${provider}"`);
    matched = true;
  }

  /* 2) base url for a provider */
  const urlHit = /(https?:\/\/[^\s"'`]+)[^\w]*(?:är|:|=)?[^\w]*(baseurl|base url|url|endpoint)/i.exec(s) || /(?:baseurl|base url|endpoint)\s*(?:är|:|=)?\s*(https?:\/\/[^\s"'`]+)/i.exec(s);
  if (urlHit) {
    const url = urlHit[1] || urlHit[2];
    const provider = /(deepseek|openrouter|groq|anthropic|openai|gemini|ollama|lmstudio|vllm|custom|lokal)[^\w]?/i.exec(s)?.[1];
    if (provider) {
      patch.providers = { ...(patch.providers || {}), [provider]: { baseUrl: url.replace(/[.,;]$/, '') } };
      notes.push(`set the baseUrl for ${provider}`);
      matched = true;
    }
  }

  /* 3) "använd <modell> för <jobb> [alltid]" */
  const refs = findModelRefs(s, cfg);
  const jobsFromPhrase = (phrase) =>
    phrase
      .split(/[\s,]+/)
      .map(jobForWord)
      .filter(Boolean);

  const clauses = String(s)
    .split(/\s*(?:[,;]|\s+och\s+|\s+and\s+|\n|\s+\+\s+)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const assignRe =
    /(?:(?:använd|anvand|use|sätt|satt|set|kör|kor|byt till|change to|gå över till|gar over till)\s+)?((?:[a-z0-9][a-z0-9._-]*\s+)?[a-z0-9._/-]{2,})\s+(?:för|for|till|på|pa|som)\s+([a-zåäö_,\s-]{2,60}?)(?:\s+(?:alltid|permanent|nu och framåt|fran och med nu|forever|always))?\s*[.!?]?\s*$/i;
  for (const clause of clauses) {
    const m = assignRe.exec(clause);
    if (!m) continue;
    const jobWords = jobsFromPhrase(m[2]);
    if (!jobWords.length) continue;
    const localRefs = findModelRefs(clause, cfg);
    const modelPhrase = m[1].toLowerCase();
    const ref = explicitRef(modelPhrase, cfg) || pickRef(localRefs, modelPhrase);
    if (!ref) continue;
    patch.models = patch.models || {};
    patch.models.routes = patch.models.routes || {};
    for (const job of jobWords) {
      if (job === '*') {
        for (const j of JOBS) patch.models.routes[j] = ref.ref;
        notes.push(`pointed all ${JOBS.length} jobs at ${ref.ref}`);
      } else {
        patch.models.routes[job] = ref.ref;
        notes.push(`${job} → ${ref.ref}`);
      }
    }
    matched = true;
  }

  /* 3a) "kör allt med X" / "använd bara X" → alla jobb */
  const allRe = /(?:kör|använd|use|byt till|sätt|set)\s+(?:hela |allt |only |bara )?(?:allt|everything|allt ihop)?\s*(?:med|with|→)\s*([a-z0-9._/-]*(?:[a-z0-9._-]+\s+)?[a-z0-9._/-]{3,})\s*(?:alltid)?\s*$/i;
  const allM = allRe.exec(s);
  if (allM && !patch.models?.routes) {
    const ref = explicitRef(allM[1], cfg) || pickRef(findModelRefs(s, cfg), allM[1]);
    if (ref) {
      patch.models = { routes: {} };
      for (const j of JOBS) patch.models.routes[j] = ref.ref;
      notes.push(`all ${JOBS.length} jobs → ${ref.ref}`);
      matched = true;
    }
  }

  /* 3b) "byt provider till X" / "kör bara X" */
  const provOnly = /(?:byt|kör|använd|gå över till|växla)\s+(?:hela |allt )?(?:provider|leverantör|modellen?)\s*(?:till|til|→|to)?\s*([a-z0-9._-]+)/i.exec(s);
  if (provOnly && !patch.models?.routes) {
    const name = provOnly[1].toLowerCase();
    if ((cfg.get('providers') || {})[name] || PRESETS[name]) {
      patch.models = { provider: name };
      notes.push(`default-provider = ${name}`);
      matched = true;
    }
  }

  /* 4) villkorsregel: "om X → använd Y"  */
  const condRe = /(?:om |när |if |when )([^\s][^?]{3,80}?)\s*(?:→|->|ska|skall|använd|use)\s+((?:[a-z0-9._-]+\s+)?[a-z0-9._/-]{3,})\s*(?:alltid)?\s*$/gim;
  while ((m = condRe.exec(s))) {
    const cond = m[1].trim().replace(/[.,]$/, '');
    const ref = explicitRef(m[2], cfg) || refs.find((r) => m[2].toLowerCase().includes(r.model.toLowerCase())) || refs.find((r) => m[2].toLowerCase().includes(r.provider));
    if (!ref || !cond) continue;
    const words = cond.split(/\s+/).filter((w) => w.length > 2);
    const pattern = `/(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/i`;
    const job = jobsFromPhrase(cond)[0] || (ref.provider === 'deepseek' && /re|bin|exe|malware/i.test(cond) ? 're' : 'code');
    patch.routing = patch.routing || {};
    patch.routing.rules = [
      ...existingRules(cfg),
      ...(patch.routing.rules || []),
      { id: `auto-${Date.now().toString(36)}`, match: pattern, job, note: `"${cond}" → ${ref.ref}`, model: ref.ref },
    ];
    notes.push(`rule: ${pattern} → ${ref.ref}`);
    matched = true;
  }

  /* 5) MOA */
  if (/\bmoa\b|mix(tur|a) of agents|mixture|mångmodell|flera modeller parallellt/i.test(s)) {
    const off = /\b(stäng av| slå av|ta bort|avaktivera|disable|turn off|off)\b/i.test(s);
    const hard = /\b(bara svåra|endast svåra|smart|bar vid svåra|hard)\b/i.test(s);
    patch.moa = { enabled: !off, policy: off ? 'off' : hard ? 'hard' : 'always' };
    const widthHit = /\bmoa\b[^\d]*?(\d)\s*(modeller|referenser|refs|stycken|styck)?/i.exec(s);
    if (widthHit) {
      const w = Number(widthHit[1]);
      if (w >= 2 && w <= 8) {
        patch.moa.width = w;
        notes.push(`width ${w}`);
      }
    }
    notes.push(off ? 'MOA off' : hard ? 'MOA on for hard jobs' : 'MOA on for everything');
    matched = true;
  }
  const widthOnly = /^(?:(?:run|use|set|go with|switch to|try|kör|använd|sätt|slå på)\s+)?(?:with\s+|med\s+)?(\d)\s*(?:references?|refs?|referenser?|models?\b(?:\s+in\s+parallel)?|modeller\b(?:\s+parallellt)?)/i.exec(s);
  if (widthOnly) {
    const w = Number(widthOnly[1]);
    if (w >= 2 && w <= 8) {
      patch.moa = { ...(patch.moa || {}), enabled: true, policy: patch.moa?.policy || 'always', width: w };
      notes.push(`width ${w}`);
      matched = true;
    }
  }
  const refs2 = /referens(?:er|model|modeller)?\s*(?:är|:|=)?\s*([a-z0-9./_,\s-]+)/i.exec(s);
  if (refs2) {
    const list = refs2[1]
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length >= 2) {
      patch.moa = { ...(patch.moa || {}), enabled: true, policy: patch.moa?.policy || 'always', references: list.map((r) => ({ model: normalizeRef(r, cfg) })) };
      notes.push(`references: ${list.join(', ')}`);
      matched = true;
    }
  }

  /* 6) Guard */
  if (/alltid på|utan att fråga|fråga inte|inget bekräfta|no confirm|auto-?approve|kör på direkt|run without asking|stop asking|no questions|full ?auto|just do it/i.test(s)) {
    patch.guard = { mode: 'off' };
    notes.push('guard off — everything runs straight away');
    matched = true;
  } else if (/bekr[aä]fta allt|alltid bekr[aä]ftelse|fr[aä]ga varje g[aä]ng|strict mode|var strikt|ingen auto|confirm everything|be strict|ask before every|treat everything as dangerous|confirm all dangerous|confirm every thing/i.test(s)) {
    patch.guard = { mode: 'strict' };
    notes.push('guard strict — anything that can do damage is confirmed');
    matched = true;
  } else if (/fråga innan (radera|farliga|destructive)|confirm mode|sitt på bekräfta|confirm destructive|ask before deleting|ask for approval/i.test(s)) {
    patch.guard = { mode: 'confirm' };
    notes.push('guard on for destructive things');
    matched = true;
  } else if (/\bguard\s*(på|off|av|till)?\s*(confirm|strict|off)\b/i.test(s)) {
    const mode = /off|av\b/i.test(s) ? 'off' : /strict/i.test(s) ? 'strict' : 'confirm';
    patch.guard = { mode };
    notes.push(`guard ${mode}`);
    matched = true;
  }

  /* 7) personlighet / stil */
  const style = /\b(?:var|vær|bli|svara|uppträd|uppträda|prata|för|be|become|act|reply|answer|talk|write|speak)\b[\s,:]+(?:mer|lite|more|less|a bit|please)?[\s,]*(kortare|kort|längre|longer|mer direkt|direkt|rakt\s+på\s+sak|straight(?:\s+to\s+the\s+point)?|mindre fluff|mindre noise|less fluff|concise|short|rolig|fyntig|allvarlig|seriös|teknisk|technical|enkel|simple|på svenska|svenska|på engelska|engelska|in english|in swedish)/i.exec(s);
  if (style) {
    const w = style[1].toLowerCase();
    const add = /rakt p.{0,4}sak|straight/.test(w) ? 'No preamble, no summary — the thing first.' : /kort|concise|short/.test(w) ? 'Be extremely short: one or two lines before the next action.' : /direkt|immediate/.test(w) ? 'No preamble, no summary, just the answer.' : /teknisk|technical/.test(w) ? 'Answer like an engineer: exact numbers, paths, commands.' : /svensk|swedish/.test(w) ? 'Always reply in Swedish.' : /engelsk|english/.test(w) ? 'Always reply in English.' : 'Explain a bit more when it helps.';
    patch.persona = { style: `${cfg.get('persona.style') || ''} ${add}`.trim() };
    notes.push('persona updated');
    matched = true;
  }

  /* 8) max steg / budget */
  const stepHit = /\b(?:max|högst|limit|maximum|at most|no more than|up to)\s+(\d{1,3})\s*(?:steg|steps|tool calls|tool calls per turn|verktyg)\b/i.exec(s);
  if (stepHit) {
    patch.agent = { maxSteps: Math.max(1, Math.min(200, Number(stepHit[1]))) };
    notes.push(`maxSteps=${patch.agent.maxSteps}`);
    matched = true;
  }
  const budgetHit = /\bbudget\b[^\d]*(\d+(?:[.,]\d+)?)\s*(?:kr|sek|usd|\$|dollar|euro|€)/i.exec(s);
  if (budgetHit) {
    const usd = Number(budgetHit[1].replace(',', '.'));
    patch.budget = { mode: 'cap', monthlyUsd: usd };
    notes.push(`budget ${usd} USD per month`);
    matched = true;
  }
  if (/spara inga (loggar|minnen)|glöm allt|minne av|don'?t (store|save|keep) (any )?(memor|minnen)|no memor|stop remembering|forget everything|memory off/i.test(s)) {
    patch.memory = { auto: false };
    notes.push('auto-memory off');
    matched = true;
  }

  /* 9) learning from runs — samma form som minnet: en flagga, reversibel, inget lämnar maskinen */
  const OFF = /\b(stop|don'?t|do\s+not|dont|never|turn off|disable|sluta|avsluta)\b/i;
  const OBJECT = /\b(runs?|turns?|trajector\w*|sessions?|dataset|training data|träningsdata|körningar|svar)\b/i;
  const ON = (/\b(learn|train|record|capture|save|collect)\b[^.!?]{0,28}\b(runs?|turns?|trajector\w*|sessions?|data)\b/.test(s) && OBJECT.test(s)
    && /\b(my|our|majin'?s|dataset|training)\b/i.test(s))
    || /\bdataset (on|enable|mode)\b/.test(s) || /lär (dig|av)|samla (tränings|träningsdata)/i.test(s);
  const OFF_HIT = (/\b(stop|don'?t|do\s+not|dont|never|turn off|disable|sluta|avsluta)\b[^.!?]{0,28}\b(learn|record\w*|captur\w*|collect\w*|train\w*|sav\w*)\b/.test(s)
    || /\bdataset (off|disable)\b/i.test(s)
    || /ingen träningsdata|sluta (lära|spela in|logga)/i.test(s)) && OBJECT.test(s);
  if (OFF_HIT) {
    patch.dataset = { capture: false };
    notes.push('dataset capture OFF — nothing new is recorded');
    matched = true;
  } else if (ON && !OFF.test(s)) {
    patch.dataset = { capture: true };
    notes.push('dataset capture ON — stored locally after redaction, export by hand, never uploaded');
    matched = true;
  }

  if (!matched) return { ok: false, matched: false, patch: {}, notes: [] };
  return { ok: true, matched: true, patch, notes };
}

/** Only keep the JSON part of stored rules — compiled RegExps never go back in. */
function existingRules(cfg) {
  return (cfg.get('routing.rules') || []).map(({ re, ...r }) => r);
}

/** "deepseek flash" / "claude-sonnet-5" / "groq" → the intended provider/model. */
function pickRef(list, phrase) {
  const p = String(phrase || '').toLowerCase();
  if (!list.length) return null;
  const exact = list.find((r) => p.includes(r.model.toLowerCase()) || p.includes(r.ref.toLowerCase()));
  if (exact) return exact;
  const wantsFlash = /flash|mini|turbo|lit|lätt|lett|snabb|fast|cheap|billig|small|3b|7b|8b/.test(p);
  const wantsPro = /pro\b|max|reason|think|tung|strong|smart|klok/.test(p);
  const score = (r) => {
    const bare = (r.model.includes('/') ? r.model.split('/').pop() : r.model).toLowerCase();
    let s = 0;
    if (wantsFlash && /flash|mini|turbo|lite|fast|small/.test(bare)) s += 3;
    if (wantsPro && /pro|max|reason|think|strong|opus/.test(bare)) s += 3;
    if (p.includes(r.provider)) s += 1;
    return s;
  };
  const ranked = [...list].sort((a, b) => score(b) - score(a));
  return score(ranked[0]) > 0 ? ranked[0] : list[0];
}

/** "openrouter/deepseek/foo" är exakt — gissa inte, ta det rakt. */
function explicitRef(phrase, cfg) {
  const t = String(phrase || '').toLowerCase().trim().replace(/^[`'"]+|[`'".,;:]+$/g, '');
  const m = /^((?:[a-z0-9][a-z0-9._+-]*\/)+[a-z0-9][a-z0-9._+-]*)$/.exec(t);
  if (!m) return null;
  const full = m[1];
  const provider = full.split('/')[0];
  const known = { ...(cfg && typeof cfg.get === 'function' ? cfg.get('providers') || {} : DEFAULTS.providers), ...PRESETS };
  if (!known[provider]) return null;
  const model = full.slice(provider.length + 1).replace(/[.,;:]$/, '');
  if (!model) return null;
  return { provider, model, ref: `${provider}/${model}` };
}

function normalizeRef(raw, cfg) {
  const r = String(raw).trim();
  if (r.includes('/')) return r;
  const found = findModelRefs(r, cfg)[0];
  return found ? found.ref : `${cfg.get('models.provider') || 'deepseek'}/${r}`;
}

export { WORD_TO_JOB, JOB_WORDS };
