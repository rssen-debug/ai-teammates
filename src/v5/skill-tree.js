/**
 * MAJIN V5 — Canonical Skill Tree, Taxonomy & Deduplication Registry.
 *
 * Schema: majin.v5.skill-registry/v1
 *
 * Taxonomy enforced here:
 *  - Tool:     concrete atomic operation (e.g. `browser.upload`, `fs.read`)
 *  - Skill:    reusable method with contract & verification (e.g. `documents.upload`, `browser.forms`)
 *  - Domain:   area grouping skills (e.g. `documents`, `career`, `browser`, `research`, `code`, `desktop`)
 *  - Workflow: composition of multiple skills solving a larger goal (e.g. `career.job-application`)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  XP_CURVE_SCHEMA,
  MIN_LEVEL,
  MAX_LEVEL,
  effectiveLevelForSkill,
  evaluateLevel99Gates,
  XpLedger,
} from './xp-engine.js';

export const SKILL_REGISTRY_SCHEMA = 'majin.v5.skill-registry/v1';

export const MATURITY_STATUS = Object.freeze({
  UNTRAINED: 'UNTRAINED',
  TRAINING: 'TRAINING',
  VERIFIED: 'VERIFIED',
  REUSABLE: 'REUSABLE',
  MASTERED: 'MASTERED',
  STALE: 'STALE',
  FAILED: 'FAILED',
});

export const DOMAINS = Object.freeze({
  documents: {
    id: 'documents',
    title: 'Documents & Files',
    summary: 'Reading, extracting, validating and uploading documents (PDF, DOCX, text).',
  },
  research: {
    id: 'research',
    title: 'Search & Research',
    summary: 'Searching, fetching, deduplicating and cross-checking external sources.',
  },
  browser: {
    id: 'browser',
    title: 'Browser & Forms',
    summary: 'Navigating pages, filling semantic forms and verifying DOM states.',
  },
  career: {
    id: 'career',
    title: 'Career & Job Applications',
    summary: 'CV fact extraction, job matching, application preparation and workflows.',
  },
  code: {
    id: 'code',
    title: 'Code & Synthesis',
    summary: 'Building pages, scripts, self-synthesized skills and automated repairs.',
  },
  desktop: {
    id: 'desktop',
    title: 'Desktop & System',
    summary: 'Operating local programs, files, terminal and Windows UI automation.',
  },
});

/** Default canonical skills — all start UNTRAINED at Level 1 (0 XP). */
const INITIAL_SKILL_VER = [1, 0, 0].join('.');

export const DEFAULT_CANONICAL_SKILLS = Object.freeze([
  {
    canonical_id: 'documents.read',
    display_name: 'Läs dokument', // input vocabulary, never rendered
    title_en: 'Read Document',
    domain: 'documents',
    kind: 'skill',
    aliases: [
      'documents.read', 'read-document', 'parse-cv', 'read-cv', 'extract-pdf', 'extract-docx',
      'läs-cv', 'läsa-dokument', 'läs-pdf', 'tolka-cv', 'dokumentläsning', // input vocabulary, never rendered
    ],
    purpose: 'Read and extract verifiable text and structured facts from PDF, DOCX and text documents.',
    masteryScope: {
      mastered: 'Extracts text and structured sections from readable PDF, DOCX, Markdown and plain text files within granted folders or workspace.',
      limitations: 'Does not invent missing facts or bypass encrypted/password-protected files without owner credentials.',
    },
    contract: {
      input: ['filePath', 'format?'],
      output: ['text', 'sha256', 'confidence', 'facts'],
    },
    dependencies: [],
    required_tools: ['document_read'],
    preferred_tools: ['fs.find', 'fs.read'],
    relevance_criteria: ['cv', 'pdf', 'docx', 'resume', 'document', 'read', 'extract', 'läs', 'dokument', 'fil'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'file_sha256',
    failure_strategies: {
      UNREADABLE_PDF: 'Switch to secondary extractor or OCR/vision fallback and verify output length.',
      FILE_NOT_FOUND: 'Use fs.find inside granted folders rather than repeating the missing path.',
    },
  },
  {
    canonical_id: 'documents.upload',
    display_name: 'Filuppladdning', // input vocabulary, never rendered
    title_en: 'Document Upload',
    domain: 'documents',
    kind: 'skill',
    aliases: [
      'documents.upload', 'upload-document', 'upload-cv', 'file-upload', 'attach-cv',
      'ladda-upp-cv', 'ladda-upp-fil', 'filuppladdning', 'bifoga-cv', // input vocabulary, never rendered
    ],
    purpose: 'Upload a verified local document (such as a CV) to an external portal or workspace.',
    masteryScope: {
      mastered: 'Uploads verified PDF/DOCX/image files to file inputs and confirms byte/filename receipt.',
      limitations: 'Cannot upload files outside workspace/granted folders or exceed portal size caps.',
    },
    contract: {
      input: ['filePath', 'targetSelectorOrUrl'],
      output: ['uploadedName', 'bytes', 'sha256', 'receiptId'],
    },
    dependencies: ['documents.read'],
    required_tools: ['browser.upload'],
    preferred_tools: ['browser.verify'],
    relevance_criteria: ['upload', 'attach', 'cv', 'portal', 'ladda', 'upp', 'bifoga'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'http_or_dom_receipt',
    failure_strategies: {
      INPUT_HIDDEN: 'Locate underlying input[type=file] element and verify attached file name and SHA-256.',
      TOO_LARGE: 'Report exact size limit blocker rather than truncating binary document.',
    },
  },
  {
    canonical_id: 'research.search',
    display_name: 'Sök & Research', // input vocabulary, never rendered
    title_en: 'Search & Research',
    domain: 'research',
    kind: 'skill',
    aliases: [
      'research.search', 'web-search', 'job-search-ads', 'find-listings', 'search-sources',
      'sök-jobb', 'hitta-annonser', 'webbsökning', 'undersök', // input vocabulary, never rendered
    ],
    purpose: 'Search external job feeds and web sources, deduplicate links and verify source availability.',
    masteryScope: {
      mastered: 'Queries structured APIs and web pages, deduplicates URLs and extracts grounded listings.',
      limitations: 'Cannot access paywalled or authenticated private feeds without owner session.',
    },
    contract: {
      input: ['query', 'criteria', 'limit'],
      output: ['items', 'uniqueCount', 'sources'],
    },
    dependencies: [],
    required_tools: ['jobs.search'],
    preferred_tools: ['web.search', 'web.fetch'],
    relevance_criteria: ['search', 'find', 'jobs', 'listings', 'research', 'sök', 'hitta', 'jobb', 'annonser'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'http_receipt',
    failure_strategies: {
      TIMEOUT: 'Retry with bounded backoff or switch to secondary feed.',
      EMPTY_RESULTS: 'Broaden query synonyms while preserving mandatory geography/role filters.',
    },
  },
  {
    canonical_id: 'browser.forms',
    display_name: 'Formulär', // input vocabulary, never rendered
    title_en: 'Browser Forms',
    domain: 'browser',
    kind: 'skill',
    aliases: [
      'browser.forms', 'form-fill', 'fill-form', 'web-form', 'application-form', 'job-form',
      'formulär', 'fyll-i-formulär', 'ansökningsformulär', 'webbformulär', 'ifyllning', // input vocabulary, never rendered
    ],
    purpose: 'Inspect, fill and verify web forms using grounded field labels and truthful user data.',
    masteryScope: {
      mastered: 'Fills text inputs, textareas, selects, radio groups and checkboxes with retained-value verification.',
      limitations: 'Never bypasses CAPTCHA or MFA; pauses and requests owner handoff when encountered.',
    },
    contract: {
      input: ['url', 'fields', 'submitMandate'],
      output: ['filledFields', 'retainedVerified', 'submitted', 'confirmationReceipt'],
    },
    dependencies: [],
    required_tools: ['browser.open', 'browser.form_fill'],
    preferred_tools: ['browser.form', 'browser.verify', 'browser.form_submit'],
    relevance_criteria: ['form', 'fill', 'application', 'submit', 'input', 'formulär', 'fyll', 'ansökan', 'skicka'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'dom_state',
    failure_strategies: {
      VALUE_REVERTED: 'Use native input descriptor setter + input/change event dispatch and re-verify DOM value.',
      CAPTCHA_REQUIRED: 'Mark item BLOCKED with concrete CAPTCHA handoff and preserve form checkpoint.',
    },
  },
  {
    canonical_id: 'career.job-match',
    display_name: 'Jobbmatchning', // input vocabulary, never rendered
    title_en: 'Job Matching',
    domain: 'career',
    kind: 'skill',
    aliases: [
      'career.job-match', 'match-jobs', 'evaluate-job', 'cv-match',
      'jobbmatchning', 'matcha-jobb', 'bedöm-matchning', // input vocabulary, never rendered
    ],
    purpose: 'Match extracted CV facts against job ads, separating required vs preferred qualifications.',
    masteryScope: {
      mastered: 'Evaluates role, geography, language, required skills and preferred skills with transparent motivation.',
      limitations: 'Never fabricates missing qualifications, certificates or work permits.',
    },
    contract: {
      input: ['cvFacts', 'jobAds', 'criteria'],
      output: ['matches', 'requiredMet', 'preferredMet', 'motivation'],
    },
    dependencies: ['documents.read', 'research.search'],
    required_tools: ['jobs.match'],
    preferred_tools: ['jobs.prepare'],
    relevance_criteria: ['match', 'fit', 'criteria', 'qualify', 'passar', 'matcha', 'kriterier', 'krav', 'meriterande'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'schema_assert',
    failure_strategies: {
      MISSING_CRITERIA: 'Apply explicit owner criteria override and re-score candidate list.',
    },
  },
  {
    canonical_id: 'code.build-page',
    display_name: 'Sidbyggare & Kod', // input vocabulary, never rendered
    title_en: 'Page & Code Builder',
    domain: 'code',
    kind: 'skill',
    aliases: [
      'code.build-page', 'build-page', 'write-code', 'fix-code', 'create-site',
      'bygg-sidan', 'bygg-hemsida', 'fixa-koden', 'skapa-sida', // input vocabulary, never rendered
    ],
    purpose: 'Create, modify and verify web pages, scripts and code artifacts in the workspace.',
    masteryScope: {
      mastered: 'Generates valid HTML/CSS/JS/Python/Node files and verifies syntax and file SHA-256 on disk.',
      limitations: 'Does not deploy to external production servers without explicit owner approval.',
    },
    contract: {
      input: ['specification', 'targetFile'],
      output: ['filePath', 'sha256', 'bytes', 'syntaxValid'],
    },
    dependencies: [],
    required_tools: ['workspace_write'],
    preferred_tools: ['workspace_read', 'fs.write'],
    relevance_criteria: ['build', 'page', 'html', 'website', 'code', 'script', 'bygg', 'sida', 'hemsida', 'kod'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'file_sha256',
    failure_strategies: {
      SYNTAX_ERROR: 'Parse and repair syntax before marking artifact complete.',
    },
  },
  {
    canonical_id: 'desktop.file-fix',
    display_name: 'Dator & Filhantering', // input vocabulary, never rendered
    title_en: 'Desktop & File Repair',
    domain: 'desktop',
    kind: 'skill',
    aliases: [
      'desktop.file-fix', 'open-program-fix-file', 'fix-file', 'desktop-control',
      'öppna-programmet', 'fixa-filen', 'datorstyrning', // input vocabulary, never rendered
    ],
    purpose: 'Locate, inspect and repair files or operate local desktop applications within owner permissions.',
    masteryScope: {
      mastered: 'Reads, patches and verifies local files in granted folders and controls Windows windows when in an interactive session.',
      limitations: 'Requires granted folder access or interactive Windows session for GUI control.',
    },
    contract: {
      input: ['targetPathOrApp', 'instruction'],
      output: ['modifiedPath', 'sha256', 'verified'],
    },
    dependencies: [],
    required_tools: ['fs.read', 'fs.write'],
    preferred_tools: ['wincontrol.open', 'computer.use'],
    relevance_criteria: ['open', 'program', 'fix', 'file', 'desktop', 'öppna', 'programmet', 'fixa', 'filen'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'file_sha256',
    failure_strategies: {
      PERMISSION_DENIED: 'Request owner folder grant for the target directory.',
    },
  },
  {
    canonical_id: 'career.job-application',
    display_name: 'Jobbansökan (Workflow)', // input vocabulary, never rendered
    title_en: 'Job Application Workflow',
    domain: 'career',
    kind: 'workflow',
    aliases: [
      'career.job-application', 'job-application-workflow', 'apply-500-jobs',
      'jobbansökan', 'sök-500-jobb', 'ansökningsflöde', // input vocabulary, never rendered
    ],
    purpose: 'End-to-end workflow composing CV reading, job search, deduplication, matching, form filling and CV upload.',
    masteryScope: {
      mastered: 'Orchestrates up to 500 job evaluations with deduplication, truthful form filling, CV upload and confirmation verification.',
      limitations: 'Respects 500 ceiling as a cap, never fabricates CV experience, and hands off CAPTCHA/MFA to the owner.',
    },
    contract: {
      input: ['cvFile', 'criteria', 'maxJobs', 'autoSubmitMandate'],
      output: ['counters', 'applications', 'receipts'],
    },
    dependencies: ['documents.read', 'research.search', 'career.job-match', 'browser.forms', 'documents.upload'],
    required_tools: ['document_read', 'jobs.search', 'jobs.match', 'browser.form_fill', 'browser.upload'],
    preferred_tools: ['browser.form_submit', 'browser.verify'],
    relevance_criteria: ['500', 'ansökningar', 'apply', 'workflow', 'cv', 'köpenhamn'], // input vocabulary, never rendered
    version: INITIAL_SKILL_VER,
    origin: 'builtin',
    verification_method: 'http_or_dom_receipt',
    failure_strategies: {
      PORTAL_BLOCKED: 'Record blocker per job item and continue remaining queue items.',
    },
  },
]);

/** Words stripped during intent normalization so wording variations map to the same canonical concept. */
const INTENT_NOISE = new Set([
  'a', 'an', 'the', 'to', 'for', 'in', 'on', 'with', 'into', 'from', 'by', 'of', 'and', 'or',
  'skill', 'method', 'procedure', 'tool', 'agent', 'helper', 'task', 'please', 'can', 'you',
  'att', 'i', 'på', 'med', 'för', 'från', 'och', 'eller', 'en', 'ett', 'den', 'det', 'som', // input vocabulary, never rendered
  'förmåga', 'metod', 'procedur', 'verktyg', 'uppgift', 'hjälp', 'kan', 'du', 'snälla', // input vocabulary, never rendered
]);

/** Synonym canonicalization table mapping Swedish/English surface tokens to canonical concept stems. */
const SYNONYM_MAP = Object.freeze({
  formulär: 'form', // input vocabulary, never rendered
  formularet: 'form', // input vocabulary, never rendered
  formulären: 'form', // input vocabulary, never rendered
  ansökningsformulär: 'form', // input vocabulary, never rendered
  webbformulär: 'form', // input vocabulary, never rendered
  forms: 'form',
  formular: 'form',
  fyll: 'fill', // input vocabulary, never rendered
  fylla: 'fill', // input vocabulary, never rendered
  ifyllning: 'fill', // input vocabulary, never rendered
  filling: 'fill',
  populate: 'fill',
  ladda: 'upload', // input vocabulary, never rendered
  uppladdning: 'upload', // input vocabulary, never rendered
  filuppladdning: 'upload', // input vocabulary, never rendered
  bifoga: 'upload', // input vocabulary, never rendered
  uploading: 'upload',
  attach: 'upload',
  läs: 'read', // input vocabulary, never rendered
  läsa: 'read', // input vocabulary, never rendered
  läsning: 'read', // input vocabulary, never rendered
  dokumentläsning: 'read', // input vocabulary, never rendered
  tolka: 'read', // input vocabulary, never rendered
  parse: 'read',
  reading: 'read',
  dokument: 'document', // input vocabulary, never rendered
  dokumentet: 'document', // input vocabulary, never rendered
  fil: 'document', // input vocabulary, never rendered
  filen: 'document', // input vocabulary, never rendered
  pdf: 'document',
  docx: 'document',
  resume: 'cv',
  meritförteckning: 'cv', // input vocabulary, never rendered
  sök: 'search', // input vocabulary, never rendered
  söka: 'search', // input vocabulary, never rendered
  sökning: 'search', // input vocabulary, never rendered
  webbsökning: 'search', // input vocabulary, never rendered
  hitta: 'search', // input vocabulary, never rendered
  find: 'search',
  lookup: 'search',
  matcha: 'match', // input vocabulary, never rendered
  matchning: 'match', // input vocabulary, never rendered
  jobbmatchning: 'match', // input vocabulary, never rendered
  matching: 'match',
  bygg: 'build', // input vocabulary, never rendered
  bygga: 'build', // input vocabulary, never rendered
  skapa: 'build', // input vocabulary, never rendered
  sida: 'page', // input vocabulary, never rendered
  sidan: 'page', // input vocabulary, never rendered
  hemsida: 'page', // input vocabulary, never rendered
  website: 'page',
});

/** Normalize a candidate name or intent string into canonical concept tokens. */
export function normalizeSkillIntent(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tokens = [];
  for (const word of raw) {
    if (INTENT_NOISE.has(word)) continue;
    const mapped = SYNONYM_MAP[word] || word;
    if (!INTENT_NOISE.has(mapped)) tokens.push(mapped);
  }
  return [...new Set(tokens)].sort();
}

/** Jaccard similarity between two arrays/sets of strings. */
function setSimilarity(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter += 1;
  }
  return inter / (setA.size + setB.size - inter);
}

/** Compute environment fingerprint for compatibility / STALE checks. */
export function computeEnvironmentFingerprint({
  platform = process.platform,
  nodeMajor = process.versions.node.split('.')[0],
  grantedLanes = [],
  availableTools = [],
} = {}) {
  const payload = JSON.stringify({
    platform,
    nodeMajor: String(nodeMajor),
    lanes: [...new Set(grantedLanes)].sort(),
    tools: [...new Set(availableTools)].sort(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** Verify that a map of `{ skillId: [depSkillId, ...] }` has no cycles. */
export function assertAcyclicDependencies(depMap) {
  const visiting = new Set();
  const visited = new Set();

  function dfs(node, trail) {
    if (visiting.has(node)) {
      const cycle = [...trail.slice(trail.indexOf(node)), node].join(' -> ');
      const err = new Error(`Dependency cycle detected in skill tree: ${cycle}`);
      err.code = 'SKILL_DEPENDENCY_CYCLE';
      throw err;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    const deps = depMap.get(node) || [];
    for (const dep of deps) {
      dfs(dep, [...trail, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of depMap.keys()) {
    dfs(node, []);
  }
  return true;
}

/**
 * Persistent, versioned Skill Tree Registry (`majin.v5.skill-registry/v1`).
 */
export class SkillTree {
  constructor({ dir, xpLedger = null, envOptions = {} } = {}) {
    if (!dir) throw new Error('SkillTree requires a storage directory');
    this.dir = dir;
    this.registryFile = path.join(dir, 'skill-registry.json');
    this.xpLedger = xpLedger || new XpLedger({ dir });
    this.envOptions = envOptions;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.skills = new Map();
    this.mergeHistory = [];
    this.#loadOrInitialize();
  }

  #createSkillRecord(spec) {
    const id = String(spec.canonical_id || '').trim();
    if (!id) throw new Error('canonical_id is required');
    const aliases = [...new Set([
      id,
      ...(Array.isArray(spec.aliases) ? spec.aliases : []),
      spec.display_name,
      spec.title_en,
    ].filter(Boolean).map((a) => String(a).toLowerCase().trim()))];

    return {
      canonical_id: id,
      display_name: String(spec.display_name || spec.title_en || id),
      title_en: String(spec.title_en || spec.display_name || id),
      domain: String(spec.domain || id.split('.')[0] || 'system'),
      kind: spec.kind === 'workflow' ? 'workflow' : 'skill',
      aliases,
      purpose: String(spec.purpose || ''),
      masteryScope: {
        mastered: String(spec.masteryScope?.mastered || spec.purpose || ''),
        limitations: String(spec.masteryScope?.limitations || 'Applies only to verified version requirements; no guarantee for all future tasks.'),
      },
      contract: {
        input: Array.isArray(spec.contract?.input) ? [...spec.contract.input] : [],
        output: Array.isArray(spec.contract?.output) ? [...spec.contract.output] : [],
      },
      dependencies: Array.isArray(spec.dependencies) ? [...new Set(spec.dependencies)] : [],
      required_tools: Array.isArray(spec.required_tools) ? [...new Set(spec.required_tools)] : [],
      preferred_tools: Array.isArray(spec.preferred_tools) ? [...new Set(spec.preferred_tools)] : [],
      relevance_criteria: Array.isArray(spec.relevance_criteria) ? [...new Set(spec.relevance_criteria)] : [],
      version: String(spec.version || '1.0.0'),
      origin: String(spec.origin || 'builtin'),
      verification_method: String(spec.verification_method || 'file_sha256'),
      failure_strategies: spec.failure_strategies && typeof spec.failure_strategies === 'object'
        ? { ...spec.failure_strategies }
        : {},
      compatibility: {
        platform: spec.compatibility?.platform || 'any',
        nodeFloor: 22,
        validatedEnvFingerprint: spec.compatibility?.validatedEnvFingerprint || null,
        externalOrigins: spec.compatibility?.externalOrigins && typeof spec.compatibility.externalOrigins === 'object'
          ? { ...spec.compatibility.externalOrigins }
          : {},
      },
      maturity_status: spec.maturity_status || MATURITY_STATUS.UNTRAINED,
      xp: Math.max(0, Number(spec.xp) || 0),
      level: Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Number(spec.level) || MIN_LEVEL)),
      rawLevel: Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Number(spec.rawLevel) || MIN_LEVEL)),
      gatedAt98: Boolean(spec.gatedAt98),
      missingLevel99Gates: Array.isArray(spec.missingLevel99Gates) ? [...spec.missingLevel99Gates] : [],
      reliability: typeof spec.reliability === 'number' ? spec.reliability : 1.0,
      freshness: spec.freshness || 'FRESH',
      staleReason: spec.staleReason || null,
      lastVerifiedAt: spec.lastVerifiedAt || null,
      lastReceiptId: spec.lastReceiptId || null,
      lastXpGain: Number(spec.lastXpGain) || 0,
      distinctScenarios: Array.isArray(spec.distinctScenarios) ? [...new Set(spec.distinctScenarios)] : [],
      distinctScenariosCount: Number(spec.distinctScenariosCount) || 0,
      verifiedRecoveryCount: Number(spec.verifiedRecoveryCount) || 0,
      qualityGates: {
        versionedTestSuitePassed: Boolean(spec.qualityGates?.versionedTestSuitePassed),
        testSuiteVersion: spec.qualityGates?.testSuiteVersion || null,
      },
      verification_history: Array.isArray(spec.verification_history) ? [...spec.verification_history] : [],
      learnedProcedures: Array.isArray(spec.learnedProcedures) ? [...spec.learnedProcedures] : [],
      avoidStrategies: Array.isArray(spec.avoidStrategies) ? [...spec.avoidStrategies] : [],
      synthesizedScript: spec.synthesizedScript || null,
      mergedFrom: Array.isArray(spec.mergedFrom) ? [...spec.mergedFrom] : [],
    };
  }

  #loadOrInitialize() {
    if (fs.existsSync(this.registryFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
        if (raw?.schema === SKILL_REGISTRY_SCHEMA && Array.isArray(raw.skills)) {
          for (const s of raw.skills) {
            const rec = this.#createSkillRecord(s);
            this.skills.set(rec.canonical_id, rec);
          }
          this.mergeHistory = Array.isArray(raw.mergeHistory) ? raw.mergeHistory : [];
        }
      } catch {
        // Recover from xp-ledger if registry snapshot was corrupted
      }
    }

    // Ensure all default canonical skills exist (starting at Level 1 / 0 XP if new)
    for (const def of DEFAULT_CANONICAL_SKILLS) {
      if (!this.skills.has(def.canonical_id)) {
        this.skills.set(def.canonical_id, this.#createSkillRecord(def));
      }
    }

    // Reconcile against append-only XP ledger so any crash between ledger write and snapshot is recovered
    this.#reconcileFromLedger();
    this.#validateAllDependencies();
    this.save();
  }

  #reconcileFromLedger() {
    const entries = this.xpLedger.readEntries();
    if (!entries.length) return;

    for (const entry of entries) {
      const skill = this.get(entry.skillId);
      if (!skill) continue;
      const alreadyRecorded = skill.verification_history.some(
        (h) => h.receiptId === entry.receiptId && h.eventId === entry.eventId,
      );
      if (!alreadyRecorded) {
        skill.verification_history.push({
          eventId: entry.eventId,
          receiptId: entry.receiptId,
          goalId: entry.goalId,
          xp: entry.xp,
          role: entry.role,
          scenarioId: entry.scenarioId,
          recoveredFromFailure: entry.recoveredFromFailure,
          verifierKind: entry.verifierKind,
          origin: entry.origin,
          at: entry.at,
        });
      }
    }

    for (const skill of this.skills.values()) {
      this.#recomputeSkillMetrics(skill);
    }
  }

  #recomputeSkillMetrics(skill) {
    // Deduplicate verification_history by receiptId so a receipt never counts twice
    const uniqueByReceipt = new Map();
    for (const item of skill.verification_history) {
      if (!item?.receiptId) continue;
      const prev = uniqueByReceipt.get(item.receiptId);
      if (!prev || (item.xp || 0) > (prev.xp || 0)) {
        uniqueByReceipt.set(item.receiptId, item);
      }
    }
    const deduped = [...uniqueByReceipt.values()];
    skill.verification_history = deduped;

    const successEvents = deduped.filter((h) => (Number(h.xp) || 0) > 0);
    const failureEvents = deduped.filter((h) => h.failed === true);

    skill.xp = successEvents.reduce((sum, h) => sum + (Number(h.xp) || 0), 0);

    const scenarios = new Set([
      ...(skill.distinctScenarios || []),
      ...successEvents.map((h) => h.scenarioId || h.goalId || h.receiptId).filter(Boolean),
    ]);
    skill.distinctScenarios = [...scenarios];
    skill.distinctScenariosCount = skill.distinctScenarios.length;

    const ledgerRecoveries = successEvents.filter((h) => h.recoveredFromFailure === true).length;
    skill.verifiedRecoveryCount = Math.max(skill.verifiedRecoveryCount || 0, ledgerRecoveries);

    const totalOutcomes = successEvents.length + failureEvents.length;
    skill.reliability = totalOutcomes > 0
      ? Number((successEvents.length / totalOutcomes).toFixed(3))
      : 1.0;

    if (successEvents.length > 0) {
      const latest = successEvents[successEvents.length - 1];
      skill.lastVerifiedAt = latest.at || skill.lastVerifiedAt;
      skill.lastReceiptId = latest.receiptId || skill.lastReceiptId;
      skill.lastXpGain = Number(latest.xp) || skill.lastXpGain || 0;
    }

    const lvlInfo = effectiveLevelForSkill(skill);
    skill.level = lvlInfo.level;
    skill.rawLevel = lvlInfo.rawLevel;
    skill.gatedAt98 = lvlInfo.gatedAt98;
    skill.missingLevel99Gates = lvlInfo.missingGates;

    // Determine maturity status while preserving STALE when environment changed
    if (skill.freshness === 'STALE') {
      skill.maturity_status = MATURITY_STATUS.STALE;
    } else if (failureEvents.length > successEvents.length + 1) {
      skill.maturity_status = MATURITY_STATUS.FAILED;
    } else if (skill.level === MAX_LEVEL) {
      skill.maturity_status = MATURITY_STATUS.MASTERED;
    } else if (successEvents.length >= 3 && skill.distinctScenariosCount >= 2) {
      skill.maturity_status = MATURITY_STATUS.REUSABLE;
    } else if (successEvents.length >= 2) {
      skill.maturity_status = MATURITY_STATUS.VERIFIED;
    } else if (successEvents.length >= 1) {
      skill.maturity_status = MATURITY_STATUS.TRAINING;
    } else {
      skill.maturity_status = MATURITY_STATUS.UNTRAINED;
    }
  }

  #validateAllDependencies() {
    const depMap = new Map();
    for (const [id, skill] of this.skills.entries()) {
      depMap.set(id, skill.dependencies || []);
    }
    assertAcyclicDependencies(depMap);
  }

  /** Atomic write-to-temp + rename save. */
  save() {
    const payload = {
      schema: SKILL_REGISTRY_SCHEMA,
      xpCurveSchema: XP_CURVE_SCHEMA,
      updatedAt: new Date().toISOString(),
      skills: [...this.skills.values()],
      mergeHistory: this.mergeHistory,
    };
    const tmp = `${this.registryFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.registryFile);
  }

  /** Lookup a skill by canonical_id or any registered alias. */
  get(idOrAlias) {
    if (!idOrAlias) return null;
    const key = String(idOrAlias).toLowerCase().trim();
    if (this.skills.has(key)) return this.skills.get(key);
    for (const skill of this.skills.values()) {
      if (skill.aliases.includes(key)) return skill;
    }
    return null;
  }

  /** List all canonical skills. */
  list() {
    return [...this.skills.values()].map((s) => ({
      ...s,
      level99Evaluation: evaluateLevel99Gates(s),
    }));
  }

  /**
   * Candidate resolution & deduplication pipeline (Section 4):
   *  1. Normalize intent.
   *  2. Search existing IDs and aliases.
   *  3. Compare behavior (required_tools), contract, and verification_method.
   *  4. Reuse or improve an existing skill when it fits.
   *  5. Create a new skill ONLY when the scope/contract genuinely justifies it.
   */
  resolveOrRegisterSkill(candidate = {}) {
    const rawName = String(candidate.canonical_id || candidate.name || candidate.display_name || '').trim();
    const direct = this.get(rawName);
    if (direct) {
      // Add any new aliases without duplicating the skill
      if (Array.isArray(candidate.aliases)) {
        for (const a of candidate.aliases) {
          const clean = String(a || '').toLowerCase().trim();
          if (clean && !direct.aliases.includes(clean)) direct.aliases.push(clean);
        }
        this.save();
      }
      return { action: 'reused', skill: direct, reason: 'exact_id_or_alias_match' };
    }

    const candTokens = normalizeSkillIntent(
      [rawName, candidate.display_name, candidate.purpose, ...(candidate.aliases || [])].join(' '),
    );
    const candTools = Array.isArray(candidate.required_tools) ? candidate.required_tools : [];
    const candVerifier = String(candidate.verification_method || '').trim();

    let bestMatch = null;
    let bestScore = 0;

    for (const existing of this.skills.values()) {
      const existTokens = normalizeSkillIntent(
        [existing.canonical_id, existing.display_name, existing.title_en, existing.purpose, ...existing.aliases].join(' '),
      );
      const tokenSim = setSimilarity(candTokens, existTokens);
      const toolSim = candTools.length > 0 && existing.required_tools.length > 0
        ? setSimilarity(candTools, existing.required_tools)
        : null;
      const verifierSame = !candVerifier || !existing.verification_method
        || candVerifier === existing.verification_method;

      // Guard against false merges: if both specify required_tools and they are disjoint,
      // OR if verification methods conflict, they are distinct skills even if names sound similar!
      if (toolSim === 0) continue;
      if (!verifierSame && toolSim !== 1) continue;

      // Primary action verb conflict guard: e.g. `read` vs `upload` or `search` vs `match`
      const coreVerbs = ['read', 'upload', 'fill', 'search', 'match', 'build'];
      const candVerbs = candTokens.filter((t) => coreVerbs.includes(t));
      const existVerbs = existTokens.filter((t) => coreVerbs.includes(t));
      if (candVerbs.length > 0 && existVerbs.length > 0 && setSimilarity(candVerbs, existVerbs) === 0) {
        continue;
      }

      const combinedScore = toolSim !== null
        ? tokenSim * 0.55 + toolSim * 0.45
        : tokenSim;

      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestMatch = existing;
      }
    }

    if (bestMatch && bestScore >= 0.48) {
      const newAliases = [rawName, candidate.display_name, ...(candidate.aliases || [])]
        .filter(Boolean)
        .map((a) => String(a).toLowerCase().trim());
      for (const alias of newAliases) {
        if (alias && !bestMatch.aliases.includes(alias)) {
          bestMatch.aliases.push(alias);
        }
      }
      this.save();
      return {
        action: 'reused',
        skill: bestMatch,
        similarity: Number(bestScore.toFixed(3)),
        reason: 'semantic_and_contract_match',
      };
    }

    // Create a new canonical skill at Level 1 (0 XP)
    const domain = String(candidate.domain || (rawName.includes('.') ? rawName.split('.')[0] : 'code')).toLowerCase();
    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const canonicalId = slug.includes('.') ? slug : `${domain}.${slug || `skill-${this.skills.size + 1}`}`;

    // Validate dependencies before inserting
    const candidateDeps = Array.isArray(candidate.dependencies) ? candidate.dependencies : [];
    const depMap = new Map();
    for (const [id, s] of this.skills.entries()) depMap.set(id, s.dependencies || []);
    depMap.set(canonicalId, candidateDeps);
    assertAcyclicDependencies(depMap);

    const record = this.#createSkillRecord({
      ...candidate,
      canonical_id: canonicalId,
      domain,
      xp: 0,
      level: MIN_LEVEL,
      maturity_status: MATURITY_STATUS.UNTRAINED,
    });
    this.skills.set(canonicalId, record);
    this.save();
    return { action: 'created', skill: record, reason: 'distinct_scope_and_contract' };
  }

  /**
   * Semantic similarity may PROPOSE a merge, never blindly execute one.
   * Registry validation checks whether contracts and verification methods agree.
   */
  proposeMerge(skillIdA, skillIdB) {
    const a = this.get(skillIdA);
    const b = this.get(skillIdB);
    if (!a || !b) return { canMerge: false, reason: 'SKILL_NOT_FOUND' };
    if (a.canonical_id === b.canonical_id) return { canMerge: false, reason: 'SAME_SKILL' };

    const toolOverlap = setSimilarity(a.required_tools, b.required_tools);
    const sameVerifier = a.verification_method === b.verification_method;
    const contractOverlap = setSimilarity(a.contract?.output || [], b.contract?.output || []);

    const canMerge = sameVerifier && (toolOverlap >= 0.5 || (a.required_tools.length === 0 && b.required_tools.length === 0));
    return {
      canMerge,
      targetId: a.canonical_id,
      sourceId: b.canonical_id,
      toolOverlap: Number(toolOverlap.toFixed(3)),
      contractOverlap: Number(contractOverlap.toFixed(3)),
      sameVerifier,
      reason: canMerge ? 'COMPATIBLE_CONTRACT_AND_VERIFIER' : 'INCOMPATIBLE_BEHAVIOR_OR_VERIFIER',
    };
  }

  /**
   * Merge `sourceId` into `targetId`, preserving aliases, history, references,
   * and recalculating XP from unique receiptIds without double-counting.
   */
  mergeSkills(targetId, sourceId, { force = false } = {}) {
    const target = this.get(targetId);
    const source = this.get(sourceId);
    if (!target || !source) {
      const err = new Error('Both target and source skills must exist to merge');
      err.code = 'SKILL_NOT_FOUND';
      throw err;
    }
    if (target.canonical_id === source.canonical_id) return target;

    const proposal = this.proposeMerge(target.canonical_id, source.canonical_id);
    if (!proposal.canMerge && !force) {
      const err = new Error(`Cannot merge incompatible skills (${target.canonical_id} <- ${source.canonical_id}): ${proposal.reason}`);
      err.code = 'SKILL_MERGE_INCOMPATIBLE';
      throw err;
    }

    // Preserve aliases
    target.aliases = [...new Set([
      ...target.aliases,
      source.canonical_id,
      ...source.aliases,
    ])];

    // Update dependency references across all skills and check for cycles
    const depMap = new Map();
    for (const [id, s] of this.skills.entries()) {
      if (id === source.canonical_id) continue;
      const updatedDeps = (s.dependencies || [])
        .map((d) => (d === source.canonical_id ? target.canonical_id : d))
        .filter((d) => d !== id);
      depMap.set(id, [...new Set(updatedDeps)]);
    }
    assertAcyclicDependencies(depMap);
    for (const [id, deps] of depMap.entries()) {
      this.skills.get(id).dependencies = deps;
    }

    // Merge verification history deduplicated by receiptId (NO double-counting!)
    target.verification_history = [
      ...target.verification_history,
      ...source.verification_history,
    ];
    target.distinctScenarios = [...new Set([
      ...(target.distinctScenarios || []),
      ...(source.distinctScenarios || []),
    ])];
    target.verifiedRecoveryCount = Math.max(
      target.verifiedRecoveryCount || 0,
      source.verifiedRecoveryCount || 0,
    );
    target.learnedProcedures = [
      ...(target.learnedProcedures || []),
      ...(source.learnedProcedures || []),
    ];
    target.mergedFrom = [...new Set([
      ...(target.mergedFrom || []),
      source.canonical_id,
      ...(source.mergedFrom || []),
    ])];

    this.#recomputeSkillMetrics(target);
    this.skills.delete(source.canonical_id);
    this.mergeHistory.push({
      targetId: target.canonical_id,
      sourceId: source.canonical_id,
      at: new Date().toISOString(),
      resultingXp: target.xp,
      resultingLevel: target.level,
    });
    this.save();
    return target;
  }

  /**
   * Award verified XP to a primary skill and optional support skills,
   * updating levels, reliability, freshness and provenance atomically.
   */
  async recordVerifiedSuccess({
    goalId,
    receipts = [],
    taskSignature = '',
    difficulty = 'standard',
    autonomous = true,
    primarySkillId,
    supportSkillIds = [],
    scenarioId = '',
    recoveredFromFailure = false,
    envFingerprint = null,
    externalOrigins = null,
    now = new Date().toISOString(),
  } = {}) {
    const primary = this.get(primarySkillId);
    if (!primary) {
      return { awarded: false, reason: 'UNKNOWN_PRIMARY_SKILL', grants: [], totalXpAwarded: 0 };
    }

    const resolvedSupports = (Array.isArray(supportSkillIds) ? supportSkillIds : [])
      .map((id) => this.get(id)?.canonical_id)
      .filter((id) => id && id !== primary.canonical_id);

    const ledgerResult = await this.xpLedger.recordVerifiedAward({
      goalId,
      receipts,
      taskSignature,
      difficulty,
      autonomous,
      primarySkillId: primary.canonical_id,
      supportSkillIds: resolvedSupports,
      scenarioId,
      recoveredFromFailure,
      now,
    });

    if (!ledgerResult.awarded) {
      return ledgerResult;
    }

    for (const grant of ledgerResult.grants) {
      const skill = this.get(grant.skillId);
      if (!skill) continue;
      skill.verification_history.push({
        eventId: grant.eventId,
        receiptId: grant.receiptId,
        goalId: grant.goalId,
        xp: grant.xp,
        role: grant.role,
        scenarioId: grant.scenarioId,
        recoveredFromFailure: grant.recoveredFromFailure,
        verifierKind: grant.verifierKind,
        origin: grant.origin,
        at: grant.at,
      });
      if (envFingerprint) {
        skill.compatibility.validatedEnvFingerprint = envFingerprint;
      }
      if (externalOrigins && typeof externalOrigins === 'object') {
        skill.compatibility.externalOrigins = {
          ...skill.compatibility.externalOrigins,
          ...externalOrigins,
        };
      }
      skill.freshness = 'FRESH';
      skill.staleReason = null;
      this.#recomputeSkillMetrics(skill);
    }

    this.save();
    return {
      ...ledgerResult,
      primarySkill: {
        canonical_id: primary.canonical_id,
        display_name: primary.display_name,
        level: primary.level,
        xp: primary.xp,
        lastXpGain: primary.lastXpGain,
        maturity_status: primary.maturity_status,
      },
    };
  }

  /** Record a failure against a skill so reliability and STALE/FAILED status stay accurate. */
  recordFailure({
    skillId,
    goalId = '',
    stepTool = '',
    failureClass = 'UNKNOWN',
    transient = false,
    now = new Date().toISOString(),
  } = {}) {
    const skill = this.get(skillId);
    if (!skill) return null;
    if (transient) return skill; // Transient network/rate-limit errors do not penalize method reliability

    skill.verification_history.push({
      eventId: crypto.createHash('sha256').update(`fail:${goalId}:${stepTool}:${now}`).digest('hex').slice(0, 24),
      receiptId: `fail:${goalId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      goalId,
      xp: 0,
      failed: true,
      stepTool,
      failureClass,
      at: now,
    });
    this.#recomputeSkillMetrics(skill);
    this.save();
    return skill;
  }

  /**
   * Mark a skill STALE when the environment or external origin changes.
   * Preserves historical `level` and `xp`!
   */
  checkEnvironmentFreshness({ currentEnvFingerprint, changedOrigins = {} } = {}) {
    const affected = [];
    for (const skill of this.skills.values()) {
      let staleReason = null;
      if (
        currentEnvFingerprint
        && skill.compatibility?.validatedEnvFingerprint
        && skill.compatibility.validatedEnvFingerprint !== currentEnvFingerprint
      ) {
        staleReason = `Environment changed (${skill.compatibility.validatedEnvFingerprint} -> ${currentEnvFingerprint})`;
      }
      if (!staleReason && changedOrigins && typeof changedOrigins === 'object') {
        for (const [origin, newFp] of Object.entries(changedOrigins)) {
          const oldFp = skill.compatibility?.externalOrigins?.[origin];
          if (oldFp && newFp && oldFp !== newFp) {
            staleReason = `External origin changed (${origin})`;
            break;
          }
        }
      }
      if (staleReason) {
        skill.freshness = 'STALE';
        skill.staleReason = staleReason;
        skill.maturity_status = MATURITY_STATUS.STALE;
        affected.push(skill.canonical_id);
      }
    }
    if (affected.length > 0) this.save();
    return affected;
  }

  /** Update Level 99 quality gate flags for a skill and recompute its effective level. */
  setQualityGates(skillId, { versionedTestSuitePassed, testSuiteVersion, masteryScope } = {}) {
    const skill = this.get(skillId);
    if (!skill) return null;
    if (typeof versionedTestSuitePassed === 'boolean') {
      skill.qualityGates.versionedTestSuitePassed = versionedTestSuitePassed;
      skill.qualityGates.testSuiteVersion = testSuiteVersion || skill.version;
    }
    if (masteryScope && typeof masteryScope === 'object') {
      skill.masteryScope = { ...skill.masteryScope, ...masteryScope };
    }
    this.#recomputeSkillMetrics(skill);
    this.save();
    return skill;
  }

  /** Select the most relevant primary skill and support skills for a user goal. */
  selectSkillsForGoal(goalText = '') {
    const raw = String(goalText || '').toLowerCase();
    const tokens = normalizeSkillIntent(raw);

    // Check if this is the full job-application workflow
    if (
      (/\b500\b/.test(raw) && /jobb|jobs|ansök|apply/i.test(raw))
      || (/cv/i.test(raw) && /fyll|ansök|apply|skicka/i.test(raw))
    ) {
      const primary = this.get('career.job-application');
      return {
        primarySkill: primary,
        supportSkills: ['documents.read', 'research.search', 'career.job-match', 'browser.forms', 'documents.upload']
          .map((id) => this.get(id))
          .filter(Boolean),
      };
    }

    const scored = [];
    for (const skill of this.skills.values()) {
      if (skill.kind === 'workflow') continue;
      let score = 0;
      for (const crit of skill.relevance_criteria || []) {
        if (raw.includes(crit.toLowerCase())) score += 2;
      }
      const skillTokens = normalizeSkillIntent(
        [skill.canonical_id, skill.display_name, skill.title_en, ...skill.aliases].join(' '),
      );
      score += setSimilarity(tokens, skillTokens) * 5;
      if (score > 0) scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      return { primarySkill: null, supportSkills: [] };
    }
    const primarySkill = scored[0].skill;
    const supportSkills = scored
      .slice(1, 3)
      .filter((s) => s.score >= 1.5)
      .map((s) => s.skill);
    return { primarySkill, supportSkills };
  }

  /**
   * Documented aggregate summary of active skills for the main dot-matrix motif.
   * Explicitly never called "universal intelligence in percent".
   */
  aggregateSummary() {
    const all = this.list();
    const trained = all.filter((s) => s.xp > 0);
    const activeSet = trained.length > 0 ? trained : all;
    const avgLevel = Math.max(
      MIN_LEVEL,
      Math.min(
        MAX_LEVEL,
        Math.round(activeSet.reduce((sum, s) => sum + s.level, 0) / Math.max(1, activeSet.length)),
      ),
    );
    const totalXp = all.reduce((sum, s) => sum + s.xp, 0);
    return {
      label: 'Active Skills Summary',
      totalSkills: all.length,
      trainedSkills: trained.length,
      aggregateLevel: avgLevel,
      maxLevel: MAX_LEVEL,
      totalXp,
      domains: Object.values(DOMAINS),
    };
  }
}
