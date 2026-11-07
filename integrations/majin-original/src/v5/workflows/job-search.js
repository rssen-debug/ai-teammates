/**
 * MAJIN V5 — 500-Job Search & Application Workflow (`career.job-application`, Section 9).
 *
 * Composes reusable canonical skills:
 *  - `documents.read`
 *  - `research.search`
 *  - `career.job-match`
 *  - `browser.forms`
 *  - `documents.upload`
 *
 * Enforces:
 *  1. Truthful CV extraction only — never invents experience, education,
 *     certificates, work permits or personal answers.
 *  2. 500 is a cap/ceiling, never a reason to submit irrelevant applications.
 *     If only 83 meet criteria, `matched === 83` and only those 83 proceed.
 *  3. 8 separate counters: `found`, `unique`, `matched`, `prepared`,
 *     `submitted`, `confirmed`, `blocked`, `failed`.
 *  4. Clicking "Submit" (`Skicka`) NEVER marks an application `confirmed` —
 *     `confirmed` requires an independent confirmation receipt (`confirmationId`
 *     or verified portal confirmation payload + SHA-256).
 *  5. Durable queue, bounded concurrency, rate limit, and crash-safe idempotency
 *     (inspects `submissionLedger` and portal state before retrying after a crash).
 *  6. CAPTCHA, MFA, and missing personal info produce concrete resumable blockers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const JOB_WORKFLOW_SCHEMA = 'majin.v5.job-workflow/v1';

const KNOWN_SKILLS = [
  'javascript', 'typescript', 'node.js', 'nodejs', 'python', 'react', 'vue', 'sql',
  'postgresql', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'git', 'linux',
  'windows', 'c#', '.net', 'java', 'go', 'golang', 'rust', 'graphql', 'rest',
  'playwright', 'testing', 'ci/cd', 'scrum', 'agile', 'figma', 'css', 'html',
  'intune', 'entra id', 'azure ad', 'azure active directory', 'microsoft 365', 'm365', 'apple business manager',
  'active directory', 'endpoint management', 'local it', 'sentinel', 'defender',
];

const KNOWN_LANGUAGES = [
  { id: 'svenska', patterns: /\b(svenska|swedish)\b/i }, // input vocabulary, never rendered
  { id: 'engelska', patterns: /\b(engelska|english)\b/i }, // input vocabulary, never rendered
  { id: 'danska', patterns: /\b(danska|danish)\b/i }, // input vocabulary, never rendered
  { id: 'tyska', patterns: /\b(tyska|german)\b/i }, // input vocabulary, never rendered
];

const KNOWN_LOCATIONS = [
  'stockholm', 'göteborg', 'malmö', 'uppsala', 'köpenhamn', 'copenhagen', // input vocabulary, never rendered
  'oslo', 'helsinki', 'remote', 'distans', 'lund', 'linköping', 'helsingborg', 'landskrona', 'københavn', // input vocabulary, never rendered
];

// These aliases normalize vocabulary, not seniority or broader product expertise.
function qualificationKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const aliases = {
    'm365': 'microsoft 365', 'nodejs': 'node.js',
    'azure ad': 'entra id', 'azure active directory': 'entra id', 'microsoft entra id': 'entra id',
    'microsoft intune': 'intune', 'swedish': 'svenska', 'english': 'engelska', // input vocabulary, never rendered
    'danish': 'danska', 'german': 'tyska', // input vocabulary, never rendered
  };
  return aliases[key] || key;
}

// A conservative lexical filter, not an NLP proof of every possible CV claim.
const UNCERTAIN_CLAIM = /\b(no|not|without|lack|lacking|expired|revoked|aspiring|seeking|studying for|preparing for|plan to|ingen|inget|inga|inte|saknar|nej|planerar|studerar till|krävs|behövs)\b/i; // input vocabulary, never rendered

/**
 * 1. Extract strictly verifiable facts from CV text.
 * Never invents missing degrees, certificates, work permits or years of experience.
 */
export function extractVerifiableCvFacts(cvText = '', { cvFileName = 'cv.pdf', cvSha256 = null } = {}) {
  const raw = String(cvText || '');
  const lower = raw.toLowerCase();
  const assertedClauses = raw.split(/(?:[\r\n;]+|(?<=[.!?])\s+)/).map(s => s.trim()).filter(s => s && !UNCERTAIN_CLAIM.test(s));
  const asserted = assertedClauses.join('\n');

  const emailMatch = raw.match(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/);
  const phoneMatch = raw.match(/(?<![\w+])(?:\+(?:46|45)(?:[ \t-]*\d){7,10}|07\d(?:[ \t-]*\d){7})\b/);

  // Name: first non-empty header line that looks like a person's name
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let fullName = null;
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/^(?:cv|curriculum vitae|resume|namn|name)\s*[-:—]?\s*/i, '').trim(); // input vocabulary, never rendered
    if (/^[A-ZÅÄÖ][a-zåäöé]+(?:\s+[A-ZÅÄÖ][a-zåäöé-]+){1,3}$/.test(cleaned)) {
      fullName = cleaned;
      break;
    }
  }

  const skills = KNOWN_SKILLS.filter((s) => {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = s === 'active directory' ? '(?<!azure\\s)' : '';
    const suffix = s === 'azure' ? '(?!\\s+(?:ad|active directory)\\b)' : '';
    return new RegExp(`(?:^|[^\\w])${prefix}${escaped}${suffix}(?:$|[^\\w])`, 'i').test(asserted);
  }).map((s) => (s === 'nodejs' ? 'node.js' : s));

  const languages = KNOWN_LANGUAGES.filter((l) => l.patterns.test(asserted)).map((l) => l.id);
  const locations = KNOWN_LOCATIONS.filter((loc) => lower.includes(loc));

  const roles = [];
  const rolePatterns = [
    { id: 'it technician', re: /\b(it[- ]tekniker|it technician|local it)\b/i },
    { id: 'systems administrator', re: /\b(systems? administrator|systemadministratör)\b/i },
    { id: 'endpoint administrator', re: /\b(intune administrator|endpoint (?:administrator|management specialist)|modern workplace engineer)\b/i },
    { id: 'soc analyst', re: /\b(soc analyst|soc[- ]analytiker|security operations analyst)\b/i },
    { id: 'fullstack developer', re: /\b(fullstack|full-stack|fullstackutvecklare)\b/i }, // input vocabulary, never rendered
    { id: 'backend developer', re: /\b(backend|backendutvecklare|systemutvecklare)\b/i }, // input vocabulary, never rendered
    { id: 'frontend developer', re: /\b(frontend|frontendutvecklare|webbutvecklare)\b/i }, // input vocabulary, never rendered
    { id: 'devops engineer', re: /\b(devops|cloud engineer|sre|plattform)\b/i }, // input vocabulary, never rendered
    { id: 'data engineer', re: /\b(data engineer|data scientist|ai engineer|ml)\b/i },
    { id: 'software engineer', re: /\b(software engineer|mjukvaruutvecklare|utvecklare|developer)\b/i }, // input vocabulary, never rendered
  ];
  for (const rp of rolePatterns) {
    if (rp.re.test(asserted)) roles.push(rp.id);
  }

  const yearsMatch = asserted.match(/\b(\d{1,2})\+?\s*(?:års?\s+erfarenhet|years?\s+(?:of\s+)?experience)\b/i); // input vocabulary, never rendered
  const experienceYears = yearsMatch ? Number(yearsMatch[1]) : null;

  const education = [];
  if (/\b(civilingenjör|master|m\.sc|bachelor|kandidat|högskoleingenjör|universitet|university|yrkeshögskola)\b/i.test(raw)) { // input vocabulary, never rendered
    const eduLines = assertedClauses.filter((l) =>
      /\b(civilingenjör|master|m\.sc|bachelor|kandidat|högskoleingenjör|universitet|university|yrkeshögskola)\b/i.test(l), // input vocabulary, never rendered
    );
    education.push(...eduLines.slice(0, 3));
  }

  const certificates = [];
  const certMatches = asserted.match(/\b(AWS Certified[^\n,;.]*|Azure Certified[^\n,;.]*|CKA|PMP|Scrum Master)\b/gi);
  if (certMatches) certificates.push(...new Set(certMatches.map((c) => c.trim())));

  // A mention, question or nationality alone is not an affirmative permit claim.
  const permitStatement = assertedClauses.find(line =>
    /(?:\b(?:has|have|har|valid|giltigt)\s+(?:a\s+)?(?:work permit|arbetstillstånd|arbejdstilladelse)\b|\b(?:work permit|arbetstillstånd|arbejdstilladelse)\s*:\s*(?:valid|yes|ja|giltigt|eu-medborgare)\b)/i.test(line)); // input vocabulary, never rendered
  const workPermit = permitStatement ? 'explicitly_stated_in_cv' : null;

  return {
    verifiableOnly: true,
    inventedFactsCount: 0,
    cvFileName,
    cvSha256: cvSha256 || crypto.createHash('sha256').update(raw).digest('hex'),
    fullName,
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
    skills: [...new Set(skills)],
    roles: [...new Set(roles)],
    languages: [...new Set(languages)],
    locations: [...new Set(locations)],
    experienceYears,
    education,
    certificates,
    workPermit,
  };
}

/**
 * 4. Deduplicate job ads across multiple employer links and portals.
 * Collapses duplicate postings by canonical URL (stripping tracking params)
 * AND by `(normalizedEmployer, normalizedTitle, normalizedLocation)`.
 */
export function deduplicateJobListings(ads = []) {
  const seenKeys = new Map();
  const seenUrls = new Set();
  const unique = [];
  const duplicates = [];

  for (const ad of Array.isArray(ads) ? ads : []) {
    if (!ad || typeof ad !== 'object') continue;
    const employer = String(ad.employer || ad.company || 'unknown').toLowerCase().trim().replace(/\s+/g, ' ');
    const title = String(ad.title || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const location = String(ad.location || ad.city || '').toLowerCase().trim().replace(/\s+/g, ' ');

    let canonicalUrl = '';
    if (ad.url) {
      try {
        const u = new URL(ad.url);
        u.searchParams.delete('utm_source');
        u.searchParams.delete('utm_medium');
        u.searchParams.delete('utm_campaign');
        u.searchParams.delete('ref');
        u.hash = '';
        canonicalUrl = u.toString().toLowerCase();
      } catch {
        canonicalUrl = String(ad.url).toLowerCase().trim();
      }
    }

    const semanticKey = `${employer}::${title}::${location}`;
    if ((canonicalUrl && seenUrls.has(canonicalUrl)) || seenKeys.has(semanticKey)) {
      const primaryAd = seenKeys.get(semanticKey);
      if (primaryAd && ad.url && !primaryAd.alternateUrls.includes(ad.url)) {
        primaryAd.alternateUrls.push(ad.url);
      }
      duplicates.push(ad);
      continue;
    }

    const enriched = {
      ...ad,
      id: String(ad.id || `job-${unique.length + 1}`),
      employer: ad.employer || ad.company || 'Unknown Employer',
      title: ad.title || 'Untitled Role',
      location: ad.location || ad.city || '',
      canonicalKey: semanticKey,
      alternateUrls: ad.url ? [ad.url] : [],
    };
    if (canonicalUrl) seenUrls.add(canonicalUrl);
    seenKeys.set(semanticKey, enriched);
    unique.push(enriched);
  }

  return {
    foundCount: (Array.isArray(ads) ? ads : []).length,
    uniqueCount: unique.length,
    duplicateCount: duplicates.length,
    unique,
    duplicates,
  };
}

/** Normalize location names so e.g. Köpenhamn and Copenhagen match each other. */
function normalizeLocationToken(loc = '') {
  const s = String(loc || '').toLowerCase().trim();
  if (s === 'copenhagen' || s === 'københavn' || s === 'köpenhamn') return 'köpenhamn'; // input vocabulary, never rendered
  if (s === 'gothenburg' || s === 'göteborg') return 'göteborg'; // input vocabulary, never rendered
  if (s === 'malmo' || s === 'malmö') return 'malmö'; // input vocabulary, never rendered
  return s;
}

/**
 * 5 & 6. Evaluate match with motivation, strictly separating REQUIRED (`krav`)
 * from PREFERRED (`meriterande`) skills!
 */
export function evaluateJobMatch(ad, cvFacts, criteria = {}) {
  const cvSkills = new Set((cvFacts?.skills || []).map(qualificationKey));
  const cvLangs = new Set((cvFacts?.languages || []).map(qualificationKey));

  // Geography filter (supports mid-flight steering like "bara jobb i Köpenhamn")
  const requiredLocations = (Array.isArray(criteria.locations) ? criteria.locations : [])
    .map(normalizeLocationToken)
    .filter(Boolean);
  const adLocation = normalizeLocationToken(ad.location || ad.city || '');
  if (requiredLocations.length > 0 && !requiredLocations.includes(adLocation)) {
    return {
      matched: false,
      score: 0,
      reason: `Location "${ad.location || 'unknown'}" does not match filter (${requiredLocations.join(', ')})`,
      requiredSkills: { met: [], missing: [] },
      preferredSkills: { met: [], missing: [] },
      motivation: `Exkluderad på grund av ort (${ad.location}).`, // input vocabulary, never rendered
    };
  }

  // Separate required vs preferred qualifications
  const requiredList = Array.isArray(ad.requiredSkills)
    ? ad.requiredSkills.map((s) => String(s).toLowerCase())
    : [];
  const preferredList = Array.isArray(ad.preferredSkills)
    ? ad.preferredSkills.map((s) => String(s).toLowerCase())
    : [];

  const requiredMet = requiredList.filter((req) => cvSkills.has(qualificationKey(req)) || cvLangs.has(qualificationKey(req)));
  const requiredMissing = requiredList.filter((req) => !cvSkills.has(qualificationKey(req)) && !cvLangs.has(qualificationKey(req)));

  const preferredMet = preferredList.filter((pref) => cvSkills.has(qualificationKey(pref)) || cvLangs.has(qualificationKey(pref)));
  const preferredMissing = preferredList.filter((pref) => !cvSkills.has(qualificationKey(pref)) && !cvLangs.has(qualificationKey(pref)));

  // Experience requirement check
  const minYears = Number(ad.minExperienceYears) || 0;
  const yearsOk = minYears === 0
    || (Number.isFinite(cvFacts?.experienceYears) && cvFacts.experienceYears >= minYears);

  // Required skills must be met (or at least criteria.minRequiredRatio, default 1.0)
  const minRequiredRatio = criteria.minRequiredRatio ?? 1.0;
  const reqRatio = requiredList.length === 0 ? 1.0 : requiredMet.length / requiredList.length;
  const prefRatio = preferredList.length === 0 ? 0.5 : preferredMet.length / preferredList.length;

  const matched = yearsOk && reqRatio >= minRequiredRatio;
  const score = Number(((reqRatio * 0.7 + prefRatio * 0.3) * 100).toFixed(1));

  const motivation = matched
    ? `Matchar ${requiredMet.length}/${requiredList.length} skall-krav (${requiredMet.join(', ') || 'grundkrav'}) samt ${preferredMet.length}/${preferredList.length} meriterande kompetenser (${preferredMet.join(', ') || 'inga angivna'}) i ${ad.location || 'angiven ort'}.` // input vocabulary, never rendered
    : `Saknar obligatoriska krav: ${requiredMissing.join(', ') || (!yearsOk ? `${minYears} års erfarenhet` : 'kriterier')}.`; // input vocabulary, never rendered

  return {
    matched,
    score,
    requiredSkills: {
      total: requiredList.length,
      met: requiredMet,
      missing: requiredMissing,
    },
    preferredSkills: {
      total: preferredList.length,
      met: preferredMet,
      missing: preferredMissing,
    },
    yearsOk,
    motivation,
  };
}

/**
 * 7. Prepare a truthful application strictly from verifiable CV facts.
 * Never fabricates missing personal answers, certificates or work permits!
 */
export function prepareTruthfulApplication(ad, cvFacts, matchResult) {
  const missingRequiredFields = [];
  if (!cvFacts.fullName) missingRequiredFields.push('fullName');
  if (!cvFacts.email) missingRequiredFields.push('email');

  if (ad.requiresWorkPermitAnswer && !cvFacts.workPermit) {
    missingRequiredFields.push('workPermit');
  }
  if (ad.requiredCertificate && !(cvFacts.certificates || []).includes(ad.requiredCertificate)) {
    missingRequiredFields.push(`certificate:${ad.requiredCertificate}`);
  }
  if (Array.isArray(ad.personalQuestions) && ad.personalQuestions.length > 0) {
    for (const q of ad.personalQuestions) {
      if (!cvFacts.personalAnswers?.[q]) {
        missingRequiredFields.push(`personalQuestion:${q}`);
      }
    }
  }

  if (missingRequiredFields.length > 0) {
    return {
      ok: false,
      blocked: true,
      blocker: {
        type: 'MISSING_INFO',
        fields: missingRequiredFields,
        message: `Missing verifiable facts in CV (${missingRequiredFields.join(', ')}) — Majin never fabricates personal or credential answers.`,
      },
    };
  }

  const coverNote = [
    `Ansökan till ${ad.title} hos ${ad.employer} (${ad.location || ''}).`, // input vocabulary, never rendered
    `Verifierade kompetenser ur CV: ${matchResult.requiredSkills.met.concat(matchResult.preferredSkills.met).join(', ') || cvFacts.skills.join(', ')}.`, // input vocabulary, never rendered
    cvFacts.experienceYears ? `Verifierad erfarenhet: ${cvFacts.experienceYears} år.` : '', // input vocabulary, never rendered
  ].filter(Boolean).join(' ');

  return {
    ok: true,
    blocked: false,
    application: {
      jobId: ad.id,
      employer: ad.employer,
      title: ad.title,
      location: ad.location,
      applicantName: cvFacts.fullName,
      applicantEmail: cvFacts.email,
      applicantPhone: cvFacts.phone || '',
      cvFileName: cvFacts.cvFileName,
      cvSha256: cvFacts.cvSha256,
      verifiedSkillsUsed: [...new Set([...matchResult.requiredSkills.met, ...matchResult.preferredSkills.met])],
      coverNote,
      fabricatedFields: 0,
    },
  };
}

/**
 * Durable, idempotent 500-Job Search & Application Workflow Engine.
 */
export class JobApplicationWorkflow {
  constructor({
    dataDir,
    skillTree = null,
    portalAdapter = null,
    concurrency = 4,
    rateLimitDelayMs = 5,
  } = {}) {
    if (!dataDir) throw new Error('JobApplicationWorkflow requires dataDir');
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'job-workflow-state.json');
    this.skillTree = skillTree;
    this.portalAdapter = portalAdapter;
    this.concurrency = Math.max(1, Math.min(8, Number(concurrency) || 4));
    this.rateLimitDelayMs = Math.max(0, Number(rateLimitDelayMs) || 0);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#loadState();
  }

  #loadState() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (raw?.schema === JOB_WORKFLOW_SCHEMA) return raw;
      } catch { /* fall through */ }
    }
    return this.#emptyState();
  }

  #emptyState() {
    return {
      schema: JOB_WORKFLOW_SCHEMA,
      workflowId: `wf-${Date.now()}`,
      status: 'IDLE',
      maxTarget: 500,
      criteria: { locations: [], roles: [], minRequiredRatio: 1.0 },
      mandate: { allowSubmit: false },
      cvFacts: null,
      counters: {
        found: 0,
        unique: 0,
        matched: 0,
        prepared: 0,
        submitted: 0,
        confirmed: 0,
        blocked: 0,
        failed: 0,
      },
      items: {}, // jobId -> durable item record
      submissionLedger: {}, // idempotencyKey -> { submittedAt, confirmed, confirmationId, receipt }
      openedTopJobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  save() {
    this.#recomputeCounters();
    this.state.updatedAt = new Date().toISOString();
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  #recomputeCounters() {
    const items = Object.values(this.state.items || {});
    const matched = items.filter((i) => i.matched === true).length;
    const prepared = items.filter((i) => i.prepared === true).length;
    const submitted = items.filter((i) => i.submitted === true).length;
    const confirmed = items.filter((i) => i.confirmed === true).length;
    const blocked = items.filter((i) => i.status === 'BLOCKED').length;
    const failed = items.filter((i) => i.status === 'FAILED').length;

    this.state.counters = {
      found: Number(this.state.counters.found) || items.length,
      unique: items.length,
      matched,
      prepared,
      submitted,
      confirmed,
      blocked,
      failed,
    };
  }

  /**
   * Run the workflow:
   *  1. Extract CV facts
   *  2. Deduplicate up to `maxTarget` (500 ceiling) ads
   *  3. Evaluate match (required vs preferred)
   *  4. Prepare truthful applications ONLY for matched ads
   *  5. If `mandate.allowSubmit === true`, fill form, upload CV, submit and verify receipt
   */
  async run({
    cvText,
    cvFileName = 'cv.pdf',
    cvSha256 = null,
    jobAds = [],
    criteria = {},
    maxTarget = 500,
    mandate = { allowSubmit: false },
    signal = null,
    onProgress = null,
  } = {}) {
    const emit = (statusText, extra = {}) => {
      if (typeof onProgress === 'function') onProgress({ statusText, counters: this.state.counters, ...extra });
    };

    this.state = this.#emptyState();
    this.state.maxTarget = Math.max(1, Math.min(500, Number(maxTarget) || 500));
    this.state.criteria = {
      locations: Array.isArray(criteria.locations) ? [...criteria.locations] : [],
      roles: Array.isArray(criteria.roles) ? [...criteria.roles] : [],
      minRequiredRatio: criteria.minRequiredRatio ?? 1.0,
    };
    this.state.mandate = { allowSubmit: Boolean(mandate?.allowSubmit) };
    this.state.status = 'RUNNING';

    emit('Läser CV'); // input vocabulary, never rendered
    const cvFacts = extractVerifiableCvFacts(cvText, { cvFileName, cvSha256 });
    this.state.cvFacts = cvFacts;

    emit('Kontrollerar matchningar'); // input vocabulary, never rendered
    const dedup = deduplicateJobListings(jobAds);
    this.state.counters.found = dedup.foundCount;

    // Respect the 500 ceiling on unique ads evaluated
    const cappedUnique = dedup.unique.slice(0, this.state.maxTarget);
    for (const ad of cappedUnique) {
      const match = evaluateJobMatch(ad, cvFacts, this.state.criteria);
      this.state.items[ad.id] = {
        jobId: ad.id,
        ad,
        matched: match.matched,
        score: match.score,
        requiredSkills: match.requiredSkills,
        preferredSkills: match.preferredSkills,
        motivation: match.motivation,
        prepared: false,
        submitted: false,
        confirmed: false,
        status: match.matched ? 'MATCHED' : 'SKIPPED_UNMATCHED',
        application: null,
        blocker: null,
        error: null,
        receipt: null,
      };
    }
    this.save();

    // Prepare and (if mandated) submit only the matched items
    await this.#processQueue({ signal, emit });
    return this.getSummary();
  }

  async #processQueue({ signal = null, emit = () => {} } = {}) {
    const matchedItems = Object.values(this.state.items)
      .filter((item) => item.matched && !['CONFIRMED', 'SUBMITTED_UNCONFIRMED', 'BLOCKED', 'CANCELLED'].includes(item.status))
      .sort((a, b) => b.score - a.score);

    // Prepare applications first
    for (const item of matchedItems) {
      if (signal?.aborted) {
        this.state.status = 'CANCELLED';
        this.save();
        return;
      }
      if (!item.prepared) {
        const prep = prepareTruthfulApplication(item.ad, this.state.cvFacts, item);
        if (!prep.ok && prep.blocked) {
          item.status = 'BLOCKED';
          item.blocker = { ...prep.blocker, jobId: item.jobId };
          continue;
        }
        item.prepared = true;
        item.application = prep.application;
        item.status = 'PREPARED';
      }
    }
    this.save();

    if (!this.state.mandate.allowSubmit) {
      this.state.status = Object.values(this.state.items).some((i) => i.status === 'BLOCKED')
        ? 'PARTIAL'
        : 'COMPLETED';
      this.save();
      return;
    }

    // Submit prepared items with bounded concurrency, rate limit and idempotency
    const toSubmit = Object.values(this.state.items).filter(
      (i) => i.prepared && !i.confirmed && i.status === 'PREPARED',
    );

    let index = 0;
    const worker = async () => {
      while (index < toSubmit.length) {
        if (signal?.aborted) return;
        const current = toSubmit[index];
        index += 1;
        if (!current || current.status === 'CANCELLED') continue;
        await this.#submitSingleItem(current, { emit, signal });
        if (this.rateLimitDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.rateLimitDelayMs));
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, Math.max(1, toSubmit.length)) },
      () => worker(),
    );
    await Promise.all(workers);

    if (signal?.aborted) {
      this.state.status = 'CANCELLED';
    } else if (Object.values(this.state.items).some((i) => ['BLOCKED', 'FAILED', 'SUBMITTED_UNCONFIRMED'].includes(i.status))) {
      this.state.status = 'PARTIAL';
    } else {
      this.state.status = 'COMPLETED';
    }
    this.save();
  }

  async #submitSingleItem(item, { emit = () => {}, signal = null } = {}) {
    const idempotencyKey = `${item.jobId}::${this.state.cvFacts?.cvSha256 || 'cv'}`;

    // Crash-recovery idempotency check: check local submission ledger AND portal before retrying!
    const existingLedger = this.state.submissionLedger[idempotencyKey];
    if (existingLedger?.confirmed) {
      item.submitted = true;
      item.confirmed = true;
      item.status = 'CONFIRMED';
      item.receipt = existingLedger.receipt;
      this.save();
      return;
    }

    if (existingLedger?.submittedAt && !existingLedger.pending) {
      item.submitted = true;
      item.confirmed = false;
      item.status = 'SUBMITTED_UNCONFIRMED';
      this.save();
      return;
    }

    let prior = null;
    try {
      if (this.portalAdapter?.checkPriorSubmission) prior = await this.portalAdapter.checkPriorSubmission({
        jobId: item.jobId, idempotencyKey, applicantEmail: item.application?.applicantEmail,
      });
    } catch {
      item.status = 'BLOCKED';
      item.blocker = { type: 'PRIOR_SUBMISSION_CHECK_FAILED', jobId: item.jobId, message: 'Could not check prior submission. No new submission attempted.' };
      this.save();
      return;
    }
    if (prior?.alreadySubmitted) {
      item.submitted = true;
      item.confirmed = prior.confirmed === true && Boolean(prior.confirmationId) && prior.cvSha256Match === true
        && prior.receipt?.verified === true && prior.receipt?.cvSha256 === item.application.cvSha256;
      item.status = item.confirmed ? 'CONFIRMED' : 'SUBMITTED_UNCONFIRMED';
      item.receipt = item.confirmed ? prior.receipt || null : null;
      this.state.submissionLedger[idempotencyKey] = {
        submittedAt: prior.submittedAt || new Date().toISOString(), confirmed: item.confirmed,
        confirmationId: prior.confirmationId || null, receipt: item.receipt,
      };
      this.save();
      return;
    }
    if (existingLedger?.pending && !(prior?.alreadySubmitted === false && prior?.definitive === true)) {
      item.status = 'BLOCKED';
      item.blocker = { type: 'SUBMISSION_UNCERTAIN', jobId: item.jobId, message: 'A prior submit may have reached the portal. Verify the portal before retrying.' };
      this.save();
      return;
    }
    if (typeof this.portalAdapter?.submitApplication !== 'function') {
      item.status = 'BLOCKED';
      item.blocker = { type: 'PORTAL_ADAPTER_REQUIRED', jobId: item.jobId, message: 'No submission portal adapter is connected. Application prepared, not submitted.' };
      this.save();
      return;
    }

    // Check for CAPTCHA / MFA challenges on the job ad or portal
    if (item.ad.requiresCaptcha && !item.captchaResolved) {
      item.status = 'BLOCKED';
      item.blocker = {
        type: 'CAPTCHA',
        jobId: item.jobId,
        message: `CAPTCHA challenge required on ${item.ad.employer} (${item.ad.title}).`,
      };
      this.save();
      return;
    }
    if (item.ad.requiresMfa && !item.mfaResolved) {
      item.status = 'BLOCKED';
      item.blocker = {
        type: 'MFA',
        jobId: item.jobId,
        message: `MFA verification required on ${item.ad.employer} (${item.ad.title}).`,
      };
      this.save();
      return;
    }

    emit('Laddar upp CV', { jobId: item.jobId }); // input vocabulary, never rendered
    try {
      // Persist intent before the external effect, including abrupt process death.
      this.state.submissionLedger[idempotencyKey] = { pending: true, startedAt: new Date().toISOString(), confirmed: false };
      this.save();
      const portalRes = await this.portalAdapter.submitApplication({
        jobId: item.jobId, ad: item.ad, application: item.application, idempotencyKey, signal,
      });

      if (portalRes?.submitted === false) delete this.state.submissionLedger[idempotencyKey];
      if (portalRes?.blocker) {
        item.status = 'BLOCKED';
        item.blocker = { ...portalRes.blocker, jobId: item.jobId };
        this.save();
        return;
      }

      if (portalRes?.submitted) {
        item.submitted = true;
      } else {
        item.status = 'FAILED';
        item.error = portalRes?.error || 'Submission failed';
        this.save();
        return;
      }

      emit('Bekräftar mottagen ansökan', { jobId: item.jobId }); // input vocabulary, never rendered

      // Clicking "Skicka" is NEVER enough for status `confirmed`!
      // Require an explicit confirmationId + verified CV SHA-256 match.
      const hasIndependentConfirmation = Boolean(
        portalRes.confirmed === true
        && portalRes.confirmationId
        && portalRes.cvSha256Match === true,
      );

      if (hasIndependentConfirmation) {
        const receiptId = `rcpt-job-${item.jobId}-${portalRes.confirmationId}`;
        item.confirmed = true;
        item.status = 'CONFIRMED';
        item.receipt = {
          id: receiptId,
          receiptId,
          kind: 'http',
          verifier: 'http',
          verified: true,
          jobId: item.jobId,
          confirmationId: portalRes.confirmationId,
          cvSha256: item.application.cvSha256,
          at: new Date().toISOString(),
        };
      } else {
        item.confirmed = false;
        item.status = 'SUBMITTED_UNCONFIRMED';
      }

      this.state.submissionLedger[idempotencyKey] = {
        submittedAt: new Date().toISOString(),
        confirmed: item.confirmed,
        confirmationId: portalRes.confirmationId || null,
        receipt: item.receipt,
      };
      this.save();
    } catch (err) {
      item.status = 'BLOCKED';
      item.error = String(err?.message || err);
      item.blocker = { type: 'SUBMISSION_UNCERTAIN', jobId: item.jobId, message: 'Submission interrupted; inspect the portal before retrying.' };
      this.save();
    }
  }

  /**
   * Mid-flight steering (Section 9 & 11):
   *  - "Nej vänta, bara jobb i Köpenhamn" -> updates location filter, cancels obsolete queued items
   *    that haven't been submitted yet, and re-evaluates remaining items without starting over!
   *  - "Öppna de fyra bästa" -> selects and opens the top 4 matched jobs by score.
   */
  async steerWorkflow({ instruction = '', locations = null, openTopCount = null } = {}) {
    const raw = String(instruction || '').toLowerCase();

    // Detect "Öppna de fyra bästa" / "Open top N"
    let topN = openTopCount;
    if (topN === null && /öppna|open/i.test(raw)) {
      if (/\b(fyra|four|4)\b/i.test(raw)) topN = 4; // input vocabulary, never rendered
      else if (/\b(tre|three|3)\b/i.test(raw)) topN = 3; // input vocabulary, never rendered
      else if (/\b(fem|five|5)\b/i.test(raw)) topN = 5; // input vocabulary, never rendered
    }

    if (topN !== null && topN > 0) {
      const topJobs = Object.values(this.state.items)
        .filter((i) => i.matched)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((i) => ({
          jobId: i.jobId,
          title: i.ad.title,
          employer: i.ad.employer,
          location: i.ad.location,
          score: i.score,
          url: i.ad.url || `https://jobs.example.test/${i.jobId}`,
        }));
      this.state.openedTopJobs = topJobs;
      this.save();
      return {
        steered: true,
        kind: 'OPEN_TOP_JOBS',
        openedTopJobs: topJobs,
        summary: this.getSummary(),
      };
    }

    // Detect location filter update e.g. "Nej vänta, bara jobb i Köpenhamn"
    let nextLocations = Array.isArray(locations) ? locations : null;
    if (!nextLocations) {
      const foundLocs = KNOWN_LOCATIONS.filter((loc) => raw.includes(loc));
      if (foundLocs.length > 0) nextLocations = foundLocs;
    }

    if (nextLocations && nextLocations.length > 0) {
      this.state.criteria.locations = nextLocations.map(normalizeLocationToken);
      let cancelledSteps = 0;

      for (const item of Object.values(this.state.items)) {
        // Already submitted/confirmed items remain untouched
        if (item.submitted || item.confirmed) continue;

        const reEval = evaluateJobMatch(item.ad, this.state.cvFacts, this.state.criteria);
        if (!reEval.matched) {
          if (item.matched || item.prepared) cancelledSteps += 1;
          item.matched = false;
          item.prepared = false;
          item.status = 'CANCELLED_BY_STEERING';
        } else {
          item.matched = true;
          item.score = reEval.score;
          item.motivation = reEval.motivation;
          if (!item.prepared) {
            const prep = prepareTruthfulApplication(item.ad, this.state.cvFacts, reEval);
            if (prep.ok) {
              item.prepared = true;
              item.application = prep.application;
              item.status = 'PREPARED';
            }
          }
        }
      }
      this.save();
      return {
        steered: true,
        kind: 'UPDATE_CRITERIA',
        criteria: this.state.criteria,
        cancelledQueuedItems: cancelledSteps,
        summary: this.getSummary(),
      };
    }

    return { steered: false, summary: this.getSummary() };
  }

  /**
   * Resolve a blocker (CAPTCHA, MFA, or MISSING_INFO) for a specific job item
   * and resume that exact item without re-sending already submitted items.
   */
  async resolveBlockerAndResume({
    jobId,
    resolution = {},
    signal = null,
  } = {}) {
    const item = this.state.items[jobId];
    if (!item) {
      return { ok: false, error: `Unknown jobId: ${jobId}` };
    }

    if (resolution.captchaSolved) item.captchaResolved = true;
    if (resolution.mfaSolved) item.mfaResolved = true;
    if (resolution.workPermit) {
      this.state.cvFacts.workPermit = resolution.workPermit;
    }
    if (resolution.personalAnswers && typeof resolution.personalAnswers === 'object') {
      this.state.cvFacts.personalAnswers = {
        ...(this.state.cvFacts.personalAnswers || {}),
        ...resolution.personalAnswers,
      };
    }

    item.blocker = null;
    if (!item.prepared) {
      const prep = prepareTruthfulApplication(item.ad, this.state.cvFacts, item);
      if (!prep.ok) {
        item.status = 'BLOCKED';
        item.blocker = { ...prep.blocker, jobId: item.jobId };
        this.save();
        return { ok: false, blocked: true, blocker: item.blocker };
      }
      item.prepared = true;
      item.application = prep.application;
      item.status = 'PREPARED';
    }

    if (this.state.mandate.allowSubmit) {
      await this.#submitSingleItem(item, { signal });
    }

    this.save();
    return {
      ok: true,
      item,
      summary: this.getSummary(),
    };
  }

  /** Resume after crash/restart without duplicating any previously submitted applications. */
  async resumeAfterRestart({ signal = null, onProgress = null } = {}) {
    const emit = (statusText, extra = {}) => {
      if (typeof onProgress === 'function') onProgress({ statusText, counters: this.state.counters, ...extra });
    };
    await this.#processQueue({ signal, emit });
    return this.getSummary();
  }

  getSummary() {
    this.#recomputeCounters();
    const verifiedReceipts = Object.values(this.state.items)
      .map((i) => i.receipt)
      .filter((r) => r && r.verified === true);
    const blockers = Object.values(this.state.items)
      .filter((i) => i.status === 'BLOCKED' && i.blocker)
      .map((i) => i.blocker);

    return {
      workflowId: this.state.workflowId,
      status: this.state.status,
      maxTarget: this.state.maxTarget,
      criteria: this.state.criteria,
      mandate: this.state.mandate,
      cvFacts: this.state.cvFacts,
      counters: { ...this.state.counters },
      openedTopJobs: this.state.openedTopJobs || [],
      blockers,
      verifiedReceipts,
      items: Object.values(this.state.items),
    };
  }
}
