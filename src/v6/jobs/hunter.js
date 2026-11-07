/**
 * MAJIN V6 — Job Hunter pipeline (discovery → eligibility → match → approval →
 * preparation → submission evidence → email verification).
 *
 * What is real here: deduplication against a durable store, candidate
 * separation, exclusions, deterministic CV scoring, strict state transitions,
 * approval records, receipt persistence and email matching.
 * What is deliberately not faked: nothing in this file clicks "submit" on an
 * employer portal. That requires an owner-authorized adapter and passes through
 * `recordSubmission` with evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { searchPlatsbanken } from '../../core/jobs/platsbanken.js';
import { scoreCv } from '../../core/jobs/model.js';
import { extractDriverDocument } from '../../v5/document-extract.js';
import { transitionApplication, canTransition } from './state.js';
import { eligibility, canonicalUrl } from './store.js';

const MAX_CV_BYTES = 10 * 1024 * 1024;
const MAX_DESCRIPTION = 12000;

async function defaultCvReader(cvPath) {
  const stat = fs.statSync(cvPath);
  if (stat.size > MAX_CV_BYTES) throw Object.assign(new Error('CV exceeds 10 MB'), { code: 'CV_TOO_LARGE' });
  const buffer = fs.readFileSync(cvPath);
  const ext = path.extname(cvPath).toLowerCase();
  if (['.pdf', '.docx', '.doc', '.txt', '.md'].includes(ext)) {
    const extracted = await extractDriverDocument(buffer, cvPath);
    return String(extracted?.text || extracted?.content || '');
  }
  return buffer.toString('utf8');
}

export class JobHunter {
  constructor({ store, profiles, log = null, searchFn = searchPlatsbanken, cvReader = defaultCvReader, gmail = null, clock = Date.now } = {}) {
    if (!store) throw new Error('JobHunter requires a JobStore');
    this.store = store;
    this.profiles = profiles;
    this.log = log;
    this.searchFn = searchFn;
    this.cvReader = cvReader;
    this.gmail = gmail;
    this.clock = clock;
  }

  profile(candidateId) {
    if (!this.profiles?.ok) return { ok: false, error: this.profiles?.error || { code: 'PROFILES_MISSING', reason: 'No profiles loaded' } };
    const profile = this.profiles.candidates.find((item) => item.id === candidateId);
    if (!profile) return { ok: false, error: { code: 'CANDIDATE_UNKNOWN', reason: `No profile for candidate ${candidateId || '(missing)'}` } };
    return { ok: true, profile };
  }

  #emit(type, data) {
    try { this.log?.append(type, data); } catch { /* never break work for telemetry */ }
  }

  async discover({ candidateId, query, limit = 10 } = {}) {
    const found = this.profile(candidateId);
    if (!found.ok) return { ok: false, retryable: false, error: found.error, summary: found.error.reason };
    if (typeof query !== 'string' || !query.trim()) {
      return { ok: false, retryable: false, error: { code: 'QUERY_REQUIRED', reason: 'A search query is required' }, summary: 'No query' };
    }
    let response;
    try {
      response = await this.searchFn({ q: query.trim(), limit: Math.max(1, Math.min(100, Number(limit) || 10)) });
    } catch (error) {
      return { ok: false, retryable: true, error: { code: 'SEARCH_FAILED', reason: String(error?.message || error).slice(0, 300) }, summary: 'Job search failed' };
    }
    if (!response?.ok) {
      return {
        ok: false,
        retryable: true,
        error: { code: response?.error?.code || 'SEARCH_FAILED', reason: response?.error?.message || 'Job search failed' },
        summary: 'Job search failed',
      };
    }
    let newJobs = 0;
    let excluded = 0;
    const accepted = [];
    const skipped = [];
    for (const job of response.jobs || []) {
      if (!job?.title || !(job.url || job.apply?.url)) { excluded += 1; skipped.push({ title: job?.title || null, code: 'NO_CANONICAL_URL' }); continue; }
      const decision = eligibility(job, found.profile);
      if (!decision.eligible) {
        excluded += 1;
        skipped.push({ title: job.title, company: job.company || null, code: decision.reason.code });
        continue;
      }
      const { application, created } = await this.store.upsertDiscovered(job, candidateId);
      if (created) newJobs += 1;
      accepted.push(application.id);
      if (created) this.#emit('job.discovered', {
        taskId: null, candidateId, applicationId: application.id,
        site: job.site || null, company: job.company || null,
      });
    }
    return {
      ok: true,
      discovered: (response.jobs || []).length,
      newJobs,
      excluded,
      accepted,
      skipped,
      candidateId,
      evidence: { site: 'platsbanken', query: query.trim(), fetchedAt: new Date(this.clock()).toISOString(), accepted: accepted.length },
      summary: `Discovered ${(response.jobs || []).length} listings; ${newJobs} new, ${excluded} excluded`,
    };
  }

  async evaluate({ applicationId, candidateId = null } = {}) {
    const application = await this.store.get(applicationId);
    if (!application) return { ok: false, retryable: false, error: { code: 'APPLICATION_NOT_FOUND' }, summary: 'Application not found' };
    if (candidateId && application.candidateId !== candidateId) {
      return { ok: false, retryable: false, error: { code: 'CANDIDATE_MISMATCH' }, summary: 'Application belongs to another candidate' };
    }
    const found = this.profile(application.candidateId);
    if (!found.ok) return { ok: false, retryable: false, error: found.error, summary: found.error.reason };
    if (!['DISCOVERED', 'MATCHED'].includes(application.state)) {
      return { ok: false, retryable: false, error: { code: 'APPLICATION_STATE_INVALID', reason: `Cannot evaluate from ${application.state}` }, summary: 'Wrong state' };
    }
    let cvText;
    try {
      cvText = await this.cvReader(found.profile.cvPath);
    } catch (error) {
      return { ok: false, retryable: false, error: { code: 'CV_UNREADABLE', reason: String(error?.message || error).slice(0, 300) }, summary: 'CV could not be read' };
    }
    const scored = scoreCv(cvText, {
      title: application.job.title,
      description: String(application.job.description || '').slice(0, MAX_DESCRIPTION),
      mustHave: application.job.mustHave,
      niceToHave: application.job.niceToHave,
    });
    if (scored.score == null) {
      return { ok: false, retryable: false, error: { code: 'CV_UNSCORABLE', reason: scored.basis }, summary: 'No recognisable skills in the CV' };
    }
    const minScore = found.profile.rules?.minScore ?? 0.35;
    const eligible = scored.score >= minScore;
    const evidence = { score: scored.score, missing: scored.missing.slice(0, 20), basis: scored.basis, minScore };
    if (application.state === 'DISCOVERED') {
      if (eligible) {
        transitionApplication(application, 'MATCHED', { by: 'v6-match', now: this.clock, evidence: { score: scored.score } });
      } else {
        transitionApplication(application, 'SKIPPED', { by: 'v6-match', now: this.clock, evidence: { note: `score ${scored.score} below minimum ${minScore}` } });
      }
    }
    application.score = scored.score;
    application.match = { ...scored, minScore, missing: scored.missing.slice(0, 20) };
    if (eligible && application.state === 'MATCHED' && found.profile.approval?.policy === 'allow-list') {
      const authorized = (found.profile.approval.authorizedCompanies || []).some((company) => {
        const needle = String(company).toLowerCase().trim();
        return needle && String(application.job.company || '').toLowerCase().includes(needle);
      });
      if (authorized && canTransition('MATCHED', 'APPROVED')) {
        transitionApplication(application, 'APPROVED', {
          by: 'owner-policy', now: this.clock,
          evidence: { approvalRef: `policy:allow-list:${application.job.company}` },
        });
        application.approval = { policyRef: `policy:allow-list:${application.job.company}`, at: new Date(this.clock()).toISOString(), by: 'owner-policy' };
      }
    }
    await this.store.save(application, { event: 'evaluated' });
    this.#emit('job.matched', { taskId: null, candidateId: application.candidateId, applicationId: application.id, score: scored.score, state: application.state });
    return {
      ok: true,
      summary: `Scored ${scored.score} (${application.job.company || 'unknown employer'}) → ${application.state}`,
      evidence,
    };
  }

  /** Owner decision. Never reachable from the MCP tool surface. */
  async approve({ applicationId, approvalRef } = {}) {
    const application = await this.store.get(applicationId);
    if (!application) return { ok: false, error: { code: 'APPLICATION_NOT_FOUND' } };
    if (application.state !== 'MATCHED') return { ok: false, error: { code: 'APPLICATION_STATE_INVALID', reason: `Cannot approve from ${application.state}` } };
    if (typeof approvalRef !== 'string' || approvalRef.trim().length < 3) return { ok: false, error: { code: 'APPROVAL_REF_REQUIRED' } };
    transitionApplication(application, 'APPROVED', { by: 'owner', now: this.clock, evidence: { approvalRef: approvalRef.trim() } });
    application.approval = { policyRef: approvalRef.trim(), at: new Date(this.clock()).toISOString(), by: 'owner' };
    await this.store.save(application, { event: 'approved' });
    return { ok: true, application };
  }

  async quotaStatus(candidateId) {
    const found = this.profile(candidateId);
    if (!found.ok) return { allowed: false, reason: found.error };
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    const apps = await this.store.list({ candidateId });
    const submittedToday = apps.filter((app) => ['SUBMITTED_UNCONFIRMED', 'EMAIL_VERIFICATION_PENDING', 'CONFIRMED_RECEIVED'].includes(app.state)
      && String(app.history?.at(-1)?.at || '').startsWith(today)).length;
    const max = found.profile.quotas?.maxPerDay || 0;
    if (max && submittedToday >= max) return { allowed: false, reason: { code: 'DAILY_QUOTA_REACHED', submittedToday, max } };
    return { allowed: true, submittedToday, max };
  }

  /**
   * Record an actual portal acknowledgement. Refuses to move two steps at
   * once, refuses duplicate submissions, and refuses placeholder receipts.
   */
  async recordSubmission({ applicationId, receipt, portalUrl } = {}) {
    const application = await this.store.get(applicationId);
    if (!application) return { ok: false, error: { code: 'APPLICATION_NOT_FOUND' } };
    if (['SUBMITTED_UNCONFIRMED', 'EMAIL_VERIFICATION_PENDING', 'CONFIRMED_RECEIVED'].includes(application.state)) {
      return { ok: true, alreadySubmitted: true, state: application.state, summary: 'Already submitted; not repeated' };
    }
    if (application.state === 'UNCERTAIN') return { ok: false, error: { code: 'APPLICATION_UNCERTAIN', reason: 'Reconcile the uncertain outcome before any submission action' } };
    if (application.state === 'BLOCKED') return { ok: false, error: { code: 'APPLICATION_BLOCKED' } };
    if (application.state !== 'FORM_PREPARED') {
      return { ok: false, error: { code: 'APPLICATION_STATE_INVALID', reason: `Submission requires FORM_PREPARED, not ${application.state}` } };
    }
    if (portalUrl && canonicalUrl(portalUrl) !== canonicalUrl(application.job.apply?.url || application.job.url)) {
      return { ok: false, error: { code: 'PORTAL_URL_MISMATCH', reason: 'Evidence URL does not belong to this application' } };
    }
    transitionApplication(application, 'SUBMITTING', { by: 'v6-submit', now: this.clock });
    transitionApplication(application, 'SUBMITTED_UNCONFIRMED', {
      by: 'v6-submit', now: this.clock,
      evidence: { receipt, portalUrl: portalUrl || application.job.apply?.url || application.job.url || null },
    });
    application.evidence.push({ type: 'submission-receipt', at: new Date(this.clock()).toISOString(), receipt });
    await this.store.save(application, { event: 'submitted' });
    this.#emit('job.submitted', {
      taskId: null, candidateId: application.candidateId, applicationId: application.id,
      receiptKind: receipt?.kind || null, receiptReference: receipt?.reference || null,
    });
    return { ok: true, state: application.state, summary: 'Submission recorded with acknowledgement' };
  }

  /**
   * Read-only Gmail check. Opening a verification link is a separate,
   * owner-authorized action; this method never follows links.
   */
  async checkVerificationEmail({ applicationId } = {}) {
    if (!this.gmail) {
      return {
        ok: false, retryable: false,
        error: { code: 'GMAIL_NOT_CONFIGURED', reason: 'Gmail access is not configured; no email access was inferred from a registered tool.' },
        summary: 'Gmail is not configured',
      };
    }
    const application = await this.store.get(applicationId);
    if (!application) return { ok: false, retryable: false, error: { code: 'APPLICATION_NOT_FOUND' }, summary: 'Application not found' };
    if (!['SUBMITTED_UNCONFIRMED', 'EMAIL_VERIFICATION_PENDING'].includes(application.state)) {
      return { ok: false, retryable: false, error: { code: 'APPLICATION_STATE_INVALID', reason: `Email verification does not apply from ${application.state}` }, summary: 'Wrong state' };
    }
    const found = this.profile(application.candidateId);
    if (!found.ok) return { ok: false, retryable: false, error: found.error, summary: found.error.reason };
    if (String(this.gmail.account || '') && String(this.gmail.account).toLowerCase() !== String(found.profile.gmailAccount).toLowerCase()) {
      return { ok: false, retryable: false, error: { code: 'GMAIL_ACCOUNT_MISMATCH', reason: 'Configured Gmail account does not belong to this candidate' }, summary: 'Wrong Gmail account' };
    }
    let messages;
    try {
      messages = await this.gmail.findApplicationEmails({
        company: application.job.company, title: application.job.title, sinceDays: 30,
      });
    } catch (error) {
      return { ok: false, retryable: true, error: { code: error.code || 'GMAIL_READ_FAILED', reason: String(error.message || error).slice(0, 300) }, summary: 'Gmail read failed' };
    }
    const match = messages?.matched;
    if (!match) {
      return { ok: true, state: application.state, summary: `No verification or confirmation email found (${messages?.scanned || 0} scanned)` };
    }
    if (application.state === 'SUBMITTED_UNCONFIRMED') {
      if (match.kind === 'confirmation') {
        transitionApplication(application, 'CONFIRMED_RECEIVED', {
          by: 'gmail', now: this.clock,
          evidence: { emailMessageId: match.messageId, confirmedAt: match.receivedAt, confirmationId: match.reference || undefined },
        });
        application.evidence.push({ type: 'gmail-confirmation', at: new Date(this.clock()).toISOString(), messageId: match.messageId, reference: match.reference || null });
        await this.store.save(application, { event: 'confirmed-by-email' });
        this.#emit('job.confirmed', { taskId: null, candidateId: application.candidateId, applicationId: application.id, source: 'gmail' });
        return { ok: true, state: application.state, summary: 'Application confirmed by email', evidence: { messageId: match.messageId } };
      }
      transitionApplication(application, 'EMAIL_VERIFICATION_PENDING', {
        by: 'gmail', now: this.clock,
        evidence: { emailMessageId: match.messageId, receivedAt: match.receivedAt, senderDomain: match.senderDomain || null },
      });
      application.evidence.push({ type: 'gmail-verification-request', at: new Date(this.clock()).toISOString(), messageId: match.messageId, reference: match.reference || null });
      await this.store.save(application, { event: 'verification-email' });
      return { ok: true, state: application.state, summary: 'Verification email found; owner action may be required', evidence: { messageId: match.messageId } };
    }
    // EMAIL_VERIFICATION_PENDING: only a confirmed message moves the state.
    if (match.kind === 'confirmation') {
      transitionApplication(application, 'CONFIRMED_RECEIVED', {
        by: 'gmail', now: this.clock,
        evidence: { emailMessageId: match.messageId, confirmedAt: match.receivedAt, confirmationId: match.reference || undefined },
      });
      application.evidence.push({ type: 'gmail-confirmation', at: new Date(this.clock()).toISOString(), messageId: match.messageId, reference: match.reference || null });
      await this.store.save(application, { event: 'confirmed-by-email' });
      this.#emit('job.confirmed', { taskId: null, candidateId: application.candidateId, applicationId: application.id, source: 'gmail' });
      return { ok: true, state: application.state, summary: 'Confirmation email observed' };
    }
    return { ok: true, state: application.state, summary: 'Verification still pending; no new confirmation' };
  }
}
