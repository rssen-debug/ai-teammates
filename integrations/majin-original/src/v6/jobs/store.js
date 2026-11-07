/**
 * MAJIN V6 — durable job/application store and candidate profiles.
 *
 * Profiles are owner-authored configuration, read-only to V6. Applications are
 * kept per candidate; the store refuses to lose that separation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, ensureDir, newId, nowIso, readJson, withFileLock } from '../util.js';

export const JOB_STORE_SCHEMA = 'majin.v6.jobs/v1';
export const PROFILE_SCHEMA = 'majin.v6.profiles/v1';

const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|ref|source|src|mc_cid|mc_eid)$/i;

export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  url.hash = '';
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function jobFingerprint(job = {}) {
  const canonical = canonicalUrl(job.apply?.url || job.url);
  const basis = canonical
    ? `url:${canonical}`
    : `job:${[job.siteId, job.site, job.company, job.title]
      .map((part) => String(part || '').trim().toLowerCase().replace(/\s+/g, ' '))
      .join('|')}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

export function normalizeCompany(value) {
  return String(value || '').toLowerCase().replace(/\b(ab|hb|aktiebolag)\b/g, '').replace(/[^a-z0-9åäö]+/gi, ' ').trim(); // input vocabulary, never rendered
}

export function loadProfiles(file) {
  if (!file || !fs.existsSync(file)) {
    return { ok: false, candidates: [], error: { code: 'PROFILES_MISSING', reason: `Candidate profile file not found: ${file || '(not configured)'}` } };
  }
  let raw;
  try { raw = readJson(file); } catch (error) {
    return { ok: false, candidates: [], error: { code: 'PROFILES_UNREADABLE', reason: error.message } };
  }
  if (!raw || raw.schema !== PROFILE_SCHEMA || !Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    return { ok: false, candidates: [], error: { code: 'PROFILES_INVALID', reason: `Expected schema ${PROFILE_SCHEMA} with at least one candidate` } };
  }
  const seen = new Set();
  const candidates = [];
  for (const item of raw.candidates) {
    const id = String(item?.id || '').trim();
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(id)) throw Object.assign(new Error(`Invalid candidate id ${JSON.stringify(id)}`), { code: 'PROFILES_INVALID' });
    if (seen.has(id)) throw Object.assign(new Error(`Duplicate candidate id ${id}`), { code: 'PROFILES_INVALID' });
    seen.add(id);
    if (!item.cvPath || typeof item.cvPath !== 'string') throw Object.assign(new Error(`Candidate ${id} has no cvPath`), { code: 'PROFILES_INVALID' });
    if (!item.contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.contactEmail)) {
      throw Object.assign(new Error(`Candidate ${id} has no valid contactEmail`), { code: 'PROFILES_INVALID' });
    }
    candidates.push({
      id,
      displayName: String(item.displayName || id),
      cvPath: path.resolve(item.cvPath),
      contactEmail: item.contactEmail,
      gmailAccount: item.gmailAccount || item.contactEmail,
      exclusions: {
        companies: (item.exclusions?.companies || []).map(String),
        roles: (item.exclusions?.roles || []).map((role) => String(role).toLowerCase()),
        locations: (item.exclusions?.locations || []).map((location) => String(location).toLowerCase()),
        salaryMin: Number.isFinite(Number(item.exclusions?.salaryMin)) ? Number(item.exclusions.salaryMin) : null,
      },
      rules: {
        locationsAllow: (item.rules?.locationsAllow || []).map((location) => String(location).toLowerCase()),
        remoteOk: item.rules?.remoteOk !== false,
        minScore: Number.isFinite(Number(item.rules?.minScore)) ? Number(item.rules.minScore) : 0.35,
      },
      approval: {
        policy: ['owner-review', 'allow-list'].includes(item.approval?.policy) ? item.approval.policy : 'owner-review',
        authorizedCompanies: (item.approval?.authorizedCompanies || []).map(String),
      },
      quotas: {
        maxApplicationsPerRun: Math.max(0, Math.min(100, Number(item.quotas?.maxApplicationsPerRun) || 0)),
        maxPerDay: Math.max(0, Math.min(100, Number(item.quotas?.maxPerDay) || 0)),
      },
    });
  }
  return { ok: true, candidates, error: null, file: path.resolve(file) };
}

export function eligibility(job = {}, profile = {}) {
  const company = normalizeCompany(job.company);
  const excludedCompany = (profile.exclusions?.companies || []).find((entry) => {
    const needle = normalizeCompany(entry);
    return needle && (company === needle || company.includes(needle));
  });
  if (excludedCompany) return { eligible: false, reason: { code: 'COMPANY_EXCLUDED', detail: excludedCompany } };

  const role = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const excludedRole = (profile.exclusions?.roles || []).find((entry) => entry && role.includes(entry));
  if (excludedRole) return { eligible: false, reason: { code: 'ROLE_EXCLUDED', detail: excludedRole } };

  const city = String(job.city || '').toLowerCase();
  const excludedLocation = (profile.exclusions?.locations || []).find((entry) => entry && city.includes(entry));
  if (excludedLocation) return { eligible: false, reason: { code: 'LOCATION_EXCLUDED', detail: excludedLocation } };

  const allow = profile.rules?.locationsAllow || [];
  if (allow.length && city && !allow.some((entry) => city.includes(entry))) {
    return { eligible: false, reason: { code: 'LOCATION_NOT_ALLOWED', detail: job.city } };
  }
  if (profile.exclusions?.salaryMin != null && Number.isFinite(Number(job.salary)) && Number(job.salary) < profile.exclusions.salaryMin) {
    return { eligible: false, reason: { code: 'SALARY_BELOW_MINIMUM', detail: String(job.salary) } };
  }
  return { eligible: true, reason: null };
}

export class JobStore {
  constructor({ file, clock = Date.now, log = null } = {}) {
    if (!file) throw new Error('JobStore requires a file');
    this.file = path.resolve(file);
    this.clock = clock;
    this.log = log;
    ensureDir(path.dirname(this.file));
  }

  #blank() {
    return { schema: JOB_STORE_SCHEMA, version: 1, updatedAt: nowIso(this.clock), applications: [] };
  }

  async #withLock(fn) {
    return withFileLock(`${this.file}.lock`, async () => {
      const state = readJson(this.file, this.#blank());
      if (state?.schema !== JOB_STORE_SCHEMA || !Array.isArray(state.applications)) {
        throw Object.assign(new Error('Job store state is not recognisable'), { code: 'STATE_CORRUPT' });
      }
      const result = await fn(state);
      state.updatedAt = nowIso(this.clock);
      atomicWriteJson(this.file, state);
      return result;
    }, { clock: this.clock });
  }

  async list({ candidateId = null, state = null, limit = 500 } = {}) {
    return this.#withLock((current) => current.applications
      .filter((app) => (!candidateId || app.candidateId === candidateId) && (!state || app.state === state))
      .slice(0, Math.max(1, limit))
      .map((app) => structuredClone(app)));
  }

  async get(id) {
    return this.#withLock((current) => {
      const found = current.applications.find((app) => app.id === id);
      return found ? structuredClone(found) : null;
    });
  }

  async stats() {
    return this.#withLock((current) => {
      const byState = {};
      const byCandidate = {};
      for (const app of current.applications) {
        byState[app.state] = (byState[app.state] || 0) + 1;
        byCandidate[app.candidateId] = (byCandidate[app.candidateId] || 0) + 1;
      }
      return { total: current.applications.length, byState, byCandidate };
    });
  }

  async upsertDiscovered(job, candidateId) {
    return this.#withLock((current) => {
      const fingerprint = jobFingerprint(job);
      const existing = current.applications.find((app) => app.candidateId === candidateId && app.fingerprint === fingerprint);
      if (existing) return { application: structuredClone(existing), created: false };
      const now = nowIso(this.clock);
      const application = {
        schema: 'majin.v6.application/v1',
        id: newId('app', this.clock),
        candidateId,
        fingerprint,
        state: 'DISCOVERED',
        job: {
          site: job.site || 'unknown',
          siteId: job.siteId == null ? null : String(job.siteId),
          title: String(job.title || '').slice(0, 300),
          company: String(job.company || '').slice(0, 200),
          city: job.city || null,
          url: canonicalUrl(job.url) || job.url || null,
          apply: job.apply ? { ...job.apply, url: canonicalUrl(job.apply.url) || job.apply.url } : null,
          deadline: job.deadline || null,
          description: String(job.description || '').slice(0, 12000),
          mustHave: job.mustHave || [],
          niceToHave: job.niceToHave || [],
        },
        score: null,
        match: null,
        approval: null,
        evidence: [],
        history: [{ state: 'DISCOVERED', at: now, by: 'discovery', evidence: { site: job.site || null } }],
        createdAt: now,
        updatedAt: now,
      };
      current.applications.push(application);
      return { application: structuredClone(application), created: true };
    });
  }

  /** Persist a mutated application; callers use the state machine first. */
  async save(application, { event = null } = {}) {
    if (!application?.id) throw new Error('Application has no id');
    return this.#withLock((current) => {
      const index = current.applications.findIndex((app) => app.id === application.id);
      if (index === -1) throw Object.assign(new Error(`Unknown application ${application.id}`), { code: 'APPLICATION_NOT_FOUND' });
      application.updatedAt = nowIso(this.clock);
      current.applications[index] = structuredClone(application);
      this.log?.append('job.state', {
        taskId: null, candidateId: application.candidateId, applicationId: application.id,
        state: application.state, event: event || application.state,
      });
      return structuredClone(application);
    });
  }
}
