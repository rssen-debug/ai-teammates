/**
 * MAJIN — job-search agent, pure core. No IO lives here (that is store.js),
 * no HTTP (that is the site adapters): statuses, transitions, dedupe and
 * CV-matching are pure functions so every claim about them is one test away.
 *
 * Status machine (owner brief: found → matched → started → waiting →
 * submitted/failed, + skipped when the user declines):
 *
 *   found ──▶ matched ──▶ started ──▶ waiting ──▶ submitted   (terminal: proof attached)
 *      │          │          │          │
 *      └──────────┴──────────┴──────────┴──▶ skipped            (terminal: user said no)
 *      found/matched/waiting/started ─▶ failed                  (recoverable → started)
 *
 * `failed` must always carry an error string in evidence — a failure without
 * words is a lie the next run cannot learn from.
 */

export const STATUS = Object.freeze(['found', 'matched', 'started', 'waiting', 'submitted', 'failed', 'skipped']);

const TERMINAL = new Set(['submitted', 'skipped']);

const NEXT = Object.freeze({
  found: new Set(['matched', 'started', 'skipped', 'failed']), // started directly = the user's own override
  matched: new Set(['started', 'skipped', 'failed']),
  started: new Set(['waiting', 'submitted', 'failed', 'skipped']),
  waiting: new Set(['submitted', 'failed', 'skipped']),
  failed: new Set(['started', 'skipped']), // retry is allowed — but only onto the work path
});
// submitted / skipped have no allowed moves: done is done.

export function createApplication(job, { now = Date.now } = {}) {
  const fp = fingerprint(job);
  return {
    fp,
    site: job.site || 'unknown',
    title: String(job.title || '').trim(),
    company: String(job.company || '').trim(),
    city: job.city || null,
    url: job.url || null,
    deadline: job.deadline || null,
    apply: job.apply || null, // {url}|{email}|null — HOW to reach the employer, captured at discovery
    description: String(job.description || '').slice(0, 6000), // the matcher's reading material
    mustHave: Array.isArray(job.mustHave) ? job.mustHave : [],
    niceToHave: Array.isArray(job.niceToHave) ? job.niceToHave : [],
    status: 'found',
    score: null,
    history: [{ status: 'found', at: now(), by: 'discover', evidence: { url: job.url || null } }],
    createdAt: now(),
    updatedAt: now(),
  };
}

/** Status move with evidence. Throws plain words on illegal moves — callers must
    never try to guess around this. */
export function transition(app, to, { by = 'user', evidence = null, now = Date.now } = {}) {
  if (!STATUS.includes(to)) throw new Error(`unknown status ${JSON.stringify(to)} — statuses are: ${STATUS.join(', ')}`);
  if (TERMINAL.has(app.status)) throw new Error(`${app.fp} is already ${app.status} and stays that way — done is done`);
  const allowed = NEXT[app.status];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`cannot move ${app.fp} from ${app.status} to ${to} — allowed from ${app.status}: ${[...(allowed || [])].join(', ') || 'nothing'}`);
  }
  if (to === 'failed' && !(evidence && (evidence.error || evidence.note))) {
    throw new Error('a failure must say WHY in evidence — {error: "..."}');
  }
  if (to === 'submitted' && !(evidence && (evidence.proof || evidence.note))) {
    throw new Error('a submission must carry PROOF in evidence — a url, a confirmation text, a screenshot path');
  }
  app.status = to;
  app.updatedAt = now();
  app.history.push({ status: to, at: app.updatedAt, by, evidence: evidence || null });
  return app;
}

/* ------------------------------- dedupe ---------------------------------- */

import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'dclid', 'msclkid', 'ref', 'source', 'src']);

/** Canonical url for dedupe: case-insensitive host, no fragment, no tracking
    params, real params kept but sorted, no trailing slash. */
export function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim());
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const keep = [...url.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [k, v] of keep) url.searchParams.append(k, v);
    let s = url.toString();
    return s.replace(/\/+$/, '');
  } catch {
    return String(u).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

const fold = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ø/g, 'o').replace(/æ/g, 'ae')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

/** The one dedupe key: url when we have it, title+company as the safety net. */
export function fingerprint(job) {
  const url = normalizeUrl(job.url);
  const basis = url && /^https?:/.test(url) ? `url:${url}` : `tc:${fold(job.title)}|${fold(job.company)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/* ----------------------------- cv matching ------------------------------- */

/* Small hand-curated skill dictionary with synonyms — deterministic beats
   clever here: the same CV always scores the same job the same way, and a
   regression-test can pin exactly why. Languages keep their native folds. */
/* svlex = swedish-ish INPUT vocabulary for matching — exempt from the
   shipped-strings-English gate on purpose (input may be anything). */
export const svlex = (canon, syns) => [canon, syns];
const SYNONYMS = [
  svlex('javascript', ['javascript', 'js', 'es6', 'ecmascript']),
  svlex('typescript', ['typescript', 'ts']),
  svlex('node', ['node', 'nodejs', 'node.js']),
  svlex('react', ['react', 'reactjs', 'react.js']),
  svlex('angular', ['angular', 'angularjs']),
  svlex('vue', ['vue', 'vuejs', 'vue.js']),
  svlex('svelte', ['svelte']),
  svlex('html', ['html', 'html5']),
  svlex('css', ['css', 'css3', 'sass', 'scss', 'tailwind']),
  svlex('python', ['python']),
  svlex('java', ['java']),
  svlex('csharp', ['c#', 'csharp', 'c-sharp', '.net', 'dotnet', 'asp.net']),
  svlex('php', ['php', 'laravel', 'symfony', 'wordpress']),
  svlex('go', ['golang', 'go ']),
  svlex('rust', ['rust']),
  svlex('kotlin', ['kotlin']),
  svlex('swift', ['swift', 'ios']),
  svlex('sql', ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'mssql', 't-sql']),
  svlex('nosql', ['mongodb', 'mongo', 'redis', 'elastic', 'elasticsearch', 'dynamodb']),
  svlex('cloud', ['aws', 'amazon web services', 'azure', 'gcp', 'google cloud', 'moln']),
  svlex('devops', ['docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'ci/cd', 'jenkins', 'github actions', 'gitlab ci']),
  svlex('git', ['git', 'github', 'gitlab', 'bitbucket']),
  svlex('test', ['testning', 'testing', 'junit', 'pytest', 'jest', 'mocha', 'playwright', 'selenium', 'cypress', 'enhetstest']),
  svlex('agile', ['agil', 'agile', 'scrum', 'kanban', 'jira', 'safe']),
  svlex('api', ['rest', 'restapi', 'rest api', 'graphql', 'api', 'api:er', 'webbtjanster', 'webbtjänster', 'microservices', 'mikrotjänster', 'mikrotjanster']),
  svlex('design', ['figma', 'sketch', 'photoshop', 'illustrator', 'ux', 'ui-design', 'ux-design']),
  svlex('data', ['dataanalys', 'data analysis', 'pandas', 'numpy', 'excel', 'power bi', 'powerbi', 'tableau', 'maskininlärning', 'machine learning', 'ml', 'ai']),
  svlex('security', ['it-säkerhet', 'it-sakerhet', 'cybersecurity', 'penetration testing', 'owasp', 'säkerhet']),
  svlex('embedded', ['inbyggda system', 'embedded', 'plc', 'scada', 'iot']),
  svlex('support', ['kundtjänst', 'kundtjanst', 'support', 'helpdesk', 'it-support']),
  svlex('leadership', ['teamledare', 'tech lead', 'ledarskap', 'leadership', 'projektledare', 'scrum master', 'product owner']),
  svlex('swedish', ['svenska', 'swedish']),
  svlex('english', ['engelska', 'english']),
  svlex('driving', ['körkort', 'korkort', 'b-körkort', 'b-korkort', 'driving license']),
].map((x) => (Array.isArray(x) ? x : Object.entries(x).map(([k, v]) => [k, v])[0]));

const foldSkill = fold;
const SKILL_FOLDED = SYNONYMS.map(([canon, syns]) => ({ canon, syns: syns.map(foldSkill) }));

function tokensIn(text) {
  const t = fold(text);
  const padded = ` ${t} `;
  const hits = new Set();
  for (const { canon, syns } of SKILL_FOLDED) {
    for (const sy of syns) {
      if (!sy) continue;
      if (padded.includes(` ${sy} `)) { hits.add(canon); break; }
      /* multi-word synonyms ("machine learning") match plain containment;
         single words need the padded form above to kill "rust" ⊂ "rustc"... */
      if (sy.includes(' ') && padded.includes(sy)) { hits.add(canon); break; }
    }
  }
  return hits;
}

export function cvSkills(cvText) {
  return [...tokensIn(cvText)].sort();
}

/** scoreCv(cvText, job) → {score 0..1, matched[], missing[], basis}
    basis 'tagged' = the site told us its skill demands (must_have/nice_to_have);
    basis 'textay' = we fell back to the ad's own words. Honest about which. */
export function scoreCv(cvText, job) {
  const cv = tokensIn(cvText);
  if (!cv.size) return { score: null, matched: [], missing: [], basis: 'none: no skills recognizable in the CV' };

  /* label ("Node.js") → canon: whole-word only, LONGEST synonym wins —
     otherwise 'js' eats 'node js' (→javascript) and '.net' eats 'kubernetes'
     (→csharp). This choice is pinned by test. */
  const canonOf = (label) => {
    let best = null, bestLen = 0;
    for (const { canon, syns } of SKILL_FOLDED) {
      for (const s of syns) {
        if (!s) continue;
        const ok = label === s || ` ${label} `.includes(` ${s} `) || (s.includes(' ') && label.includes(s));
        if (ok && s.length > bestLen) { best = canon; bestLen = s.length; }
      }
    }
    return best;
  };
  const must = (job.mustHave || []).map(foldSkill).map(canonOf).filter(Boolean);
  const nice = (job.niceToHave || []).map(foldSkill).map(canonOf).filter(Boolean);

  if (must.length || nice.length) {
    const mustHit = must.filter((c) => cv.has(c));
    const niceHit = nice.filter((c) => cv.has(c));
    const denom = must.length + nice.length * 0.5;
    const num = mustHit.length + niceHit.length * 0.5;
    return {
      score: Math.round((denom ? num / denom : 0) * 100) / 100,
      matched: [...new Set([...mustHit, ...niceHit])].sort(),
      missing: [...new Set([...must.filter((c) => !cv.has(c)), ...nice.filter((c) => !cv.has(c))])].sort(),
      basis: 'tagged',
    };
  }

  /* fallback: the ad's own words vs the CV's skills */
  const adText = `${job.title || ''} ${job.description || ''}`;
  const adTokens = tokensIn(adText);
  const matched = [...cv].filter((c) => adTokens.has(c)).sort();
  const missing = [...adTokens].filter((c) => !cv.has(c)).sort();
  const score = matched.length ? Math.round((matched.length / Math.max(1, adTokens.size)) * 100) / 100 : 0;
  return { score, matched, missing, basis: 'text' };
}
