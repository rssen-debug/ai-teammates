/**
 * MAJIN V6 — job application state machine.
 *
 * The important property is not that states exist; it is that an uncertain
 * external submission cannot be walked back into SUBMITTING by a retry. A
 * filled form, a click or a 200 response is not a receipt.
 */

export const APPLICATION_STATES = Object.freeze([
  'DISCOVERED', 'MATCHED', 'APPROVED', 'FORM_STARTED', 'FORM_PREPARED', 'SUBMITTING',
  'SUBMITTED_UNCONFIRMED', 'EMAIL_VERIFICATION_PENDING', 'CONFIRMED_RECEIVED',
  'SKIPPED', 'BLOCKED', 'UNCERTAIN', 'FAILED_RETRYABLE', 'FAILED_FINAL',
]);

export const TERMINAL_APPLICATION_STATES = Object.freeze(['CONFIRMED_RECEIVED', 'SKIPPED', 'FAILED_FINAL']);

export const APPLICATION_TRANSITIONS = Object.freeze({
  DISCOVERED: ['MATCHED', 'SKIPPED', 'BLOCKED'],
  MATCHED: ['APPROVED', 'SKIPPED', 'BLOCKED'],
  APPROVED: ['FORM_STARTED', 'SKIPPED', 'BLOCKED'],
  FORM_STARTED: ['FORM_PREPARED', 'FAILED_RETRYABLE', 'BLOCKED', 'SKIPPED'],
  FORM_PREPARED: ['SUBMITTING', 'BLOCKED', 'FAILED_RETRYABLE', 'SKIPPED'],
  SUBMITTING: ['SUBMITTED_UNCONFIRMED', 'UNCERTAIN', 'FAILED_RETRYABLE', 'BLOCKED'],
  SUBMITTED_UNCONFIRMED: ['EMAIL_VERIFICATION_PENDING', 'CONFIRMED_RECEIVED', 'UNCERTAIN'],
  EMAIL_VERIFICATION_PENDING: ['CONFIRMED_RECEIVED', 'UNCERTAIN', 'BLOCKED'],
  FAILED_RETRYABLE: ['FORM_STARTED', 'FAILED_FINAL', 'BLOCKED'],
  UNCERTAIN: ['CONFIRMED_RECEIVED', 'FAILED_FINAL'],
  BLOCKED: ['FORM_STARTED', 'MATCHED', 'APPROVED', 'SKIPPED'],
  CONFIRMED_RECEIVED: [],
  SKIPPED: [],
  FAILED_FINAL: [],
});

export function canTransition(from, to) {
  return Boolean(APPLICATION_TRANSITIONS[from]?.includes(to));
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function requireEvidence(to, evidence) {
  const e = evidence || {};
  switch (to) {
    case 'MATCHED':
      if (!Number.isFinite(Number(e.score))) throw new Error('MATCHED requires a numeric match score');
      break;
    case 'APPROVED':
      if (!nonEmpty(e.approvalRef)) throw new Error('APPROVED requires the owner policy reference that authorized it');
      break;
    case 'FORM_STARTED':
      if (!nonEmpty(e.portalUrl) || !/^https:\/\//i.test(e.portalUrl)) throw new Error('FORM_STARTED requires the real https portal URL');
      break;
    case 'FORM_PREPARED':
      if (e.fieldsVerified !== true) throw new Error('FORM_PREPARED requires fieldsVerified=true after an actual field check');
      if (!nonEmpty(e.cvFileName)) throw new Error('FORM_PREPARED requires the CV file name that was attached');
      break;
    case 'SUBMITTED_UNCONFIRMED': {
      if (!e.receipt || typeof e.receipt !== 'object') throw new Error('SUBMITTED_UNCONFIRMED requires a receipt object; a click or HTTP 200 is not proof');
      const receipt = e.receipt;
      if (!nonEmpty(receipt.kind) || !(nonEmpty(receipt.reference) || nonEmpty(receipt.url) || nonEmpty(receipt.evidencePath) || nonEmpty(receipt.text))) {
        throw new Error('SUBMITTED_UNCONFIRMED receipt must carry a concrete acknowledgement (reference, url, evidence path or text)');
      }
      break;
    }
    case 'EMAIL_VERIFICATION_PENDING':
      if (!nonEmpty(e.emailMessageId)) throw new Error('EMAIL_VERIFICATION_PENDING requires the matched Gmail message id');
      if (!nonEmpty(e.receivedAt)) throw new Error('EMAIL_VERIFICATION_PENDING requires the email received timestamp');
      break;
    case 'CONFIRMED_RECEIVED':
      if (!(nonEmpty(e.confirmationId) || nonEmpty(e.emailMessageId))) throw new Error('CONFIRMED_RECEIVED requires a portal confirmation id or a matched confirmation email');
      if (!nonEmpty(e.confirmedAt)) throw new Error('CONFIRMED_RECEIVED requires the time the confirmation was observed');
      break;
    case 'BLOCKED':
      if (!nonEmpty(e.code) || !nonEmpty(e.reason)) throw new Error('BLOCKED requires a code and a concrete reason');
      break;
    case 'FAILED_RETRYABLE':
    case 'FAILED_FINAL':
      if (!nonEmpty(e.error || e.note)) throw new Error('A failure must say why');
      break;
    default:
      break;
  }
}

export class ApplicationStateError extends Error {
  constructor(message, code = 'APPLICATION_STATE_INVALID') {
    super(message);
    this.name = 'ApplicationStateError';
    this.code = code;
  }
}

/**
 * Move one application. `owner` is required to resume a BLOCKED task or to
 * reconcile UNCERTAIN; automation may never do either silently.
 */
export function transitionApplication(application, to, { by = 'automation', evidence = null, now = Date.now, owner = false } = {}) {
  if (!APPLICATION_STATES.includes(to)) throw new ApplicationStateError(`Unknown application state ${to}`);
  const from = application.state;
  if (!canTransition(from, to)) {
    throw new ApplicationStateError(`Cannot move application ${application.id} from ${from} to ${to}`, 'APPLICATION_TRANSITION_DENIED');
  }
  if (from === 'UNCERTAIN' && !owner) {
    throw new ApplicationStateError('UNCERTAIN can only be resolved by an explicit owner reconciliation', 'APPLICATION_UNCERTAIN_OWNER_REQUIRED');
  }
  if (from === 'BLOCKED' && !owner) {
    throw new ApplicationStateError('A BLOCKED application resumes only with an explicit owner action', 'APPLICATION_BLOCKED_OWNER_REQUIRED');
  }
  requireEvidence(to, evidence);
  application.previousState = from;
  application.state = to;
  application.updatedAt = new Date(now()).toISOString();
  application.history.push({ state: to, at: application.updatedAt, by, evidence: evidence || null });
  return application;
}

/** Reconcile an uncertain submission with observed proof, never by retrying. */
export function reconcileApplication(application, { outcome, evidence, by = 'owner', now = Date.now }) {
  if (!['confirmed', 'failed_final'].includes(outcome)) throw new ApplicationStateError('outcome must be confirmed or failed_final', 'APPLICATION_RECONCILE_INVALID');
  if (!evidence) throw new ApplicationStateError('Reconciliation requires evidence', 'APPLICATION_RECONCILE_EVIDENCE_REQUIRED');
  if (outcome === 'confirmed') {
    return transitionApplication(application, 'CONFIRMED_RECEIVED', {
      by, owner: true, now,
      evidence: { confirmationId: evidence.confirmationId, emailMessageId: evidence.emailMessageId, confirmedAt: evidence.confirmedAt || new Date(now()).toISOString() },
    });
  }
  return transitionApplication(application, 'FAILED_FINAL', { by, owner: true, now, evidence: { error: evidence.error || evidence.note || 'reconciled failure' } });
}
