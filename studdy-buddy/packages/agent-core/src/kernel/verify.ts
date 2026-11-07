/**
 * Unified kernel — verification gate.
 *
 * The rule comes from Omega (`buddy.py`, test K): *a lying model is never
 * marked complete*. MAJIN V6 enforced the same idea structurally — a handler's
 * `ok: true` is only a claim, and a receipt is what the system treats as
 * evidence. This module makes that rule explicit and reusable so every caller
 * (kernel tasks, legacy Buddy bridge, CLI) shares one implementation.
 *
 * Deliberate design choices:
 *  - an outcome without a recognised evidence kind is `unverified`, never `verified`;
 *  - a claim that asserts a file exists is checked against the real filesystem;
 *  - "the model said so" is not evidence, and is named as such in the output.
 */
import fs from 'node:fs';

export type EvidenceKind =
  | 'tool-operation'
  | 'file'
  | 'readback'
  | 'ui-readback'
  | 'command-output'
  | 'http-response'
  | 'screenshot'
  | 'receipt'
  | 'none';

export type VerificationState = 'verified' | 'unverified' | 'blocked' | 'contradicted';

export interface Evidence {
  kind: EvidenceKind;
  /** Tool or operation identifier. */
  operationId?: string | null;
  /** Absolute path for file/readback evidence. */
  path?: string | null;
  /** Text that was read back (must match what the claim expected). */
  readback?: string | null;
  /** Wall-clock time the evidence was observed. */
  at?: string | null;
  /** Free-form detail for the receipt. */
  detail?: string | null;
}

export interface Claim {
  /** What the agent says it did, in one sentence. */
  statement: string;
  /** Optional expectation; when present, readback evidence must contain it. */
  expect?: { pathExists?: string; readbackContains?: string; text?: string } | null;
}

export interface VerificationResult {
  state: VerificationState;
  verified: boolean;
  claim: string;
  evidenceKind: EvidenceKind;
  reasons: string[];
  /** True when the outcome cannot be decided locally (e.g. a real desktop). */
  blocked: boolean;
}

const KNOWN_EVIDENCE: readonly EvidenceKind[] = [
  'tool-operation', 'file', 'readback', 'ui-readback', 'command-output', 'http-response', 'screenshot', 'receipt',
];

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Decides whether a claim is proven.
 *
 * `verification` is intentionally strict: missing evidence is `unverified`,
 * an evidence kind that does not exist is `unverified`, and a filesystem
 * expectation that fails is `contradicted` (not merely unverified, because a
 * negative result is information the caller must not ignore).
 */
export function verifyClaim(claim: Claim, evidence: Evidence | null | undefined): VerificationResult {
  const statement = String(claim?.statement ?? '').slice(0, 500);
  const base: VerificationResult = {
    state: 'unverified',
    verified: false,
    claim: statement,
    evidenceKind: 'none',
    reasons: [],
    blocked: false,
  };

  if (!evidence || !evidence.kind || evidence.kind === 'none') {
    return { ...base, reasons: ['No evidence was supplied. A statement from the model is not evidence.'] };
  }

  const kind = evidence.kind;
  if (!KNOWN_EVIDENCE.includes(kind)) {
    return { ...base, evidenceKind: kind, reasons: [`Unknown evidence kind "${String(kind)}" is not verifiable.`] };
  }

  const reasons: string[] = [];
  const withKind: VerificationResult = { ...base, evidenceKind: kind };

  // An operation id must look like an operation id, not an empty string or a
  // plausible-sounding sentence.
  if (kind === 'tool-operation' || kind === 'receipt') {
    const id = String(evidence.operationId ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,120}$/.test(id)) {
      return {
        ...withKind,
        state: 'unverified',
        reasons: ['A tool operation receipt requires a concrete operation id (letters, digits, . _ : -), not a narrative.'],
      };
    }
    reasons.push(`Operation ${id} was executed by the tool layer.`);
  }

  if (kind === 'file' || kind === 'readback' || kind === 'screenshot') {
    const target = String(evidence.path ?? '').trim();
    if (!target) return { ...withKind, state: 'unverified', reasons: ['File evidence requires a path.'] };
    let exists = false;
    try {
      exists = fs.existsSync(target);
    } catch {
      exists = false;
    }
    if (!exists) {
      return { ...withKind, state: 'contradicted', reasons: [`Claimed file does not exist: ${target}`] };
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { ...withKind, state: 'contradicted', reasons: [`Path is not a regular file: ${target}`] };
    reasons.push(`File exists on disk (${stat.size} bytes): ${target}`);
  }

  if (kind === 'ui-readback' || kind === 'readback') {
    const readback = normalise(String(evidence.readback ?? ''));
    const expected = claim?.expect?.readbackContains;
    if (expected != null) {
      if (!readback) return { ...withKind, state: 'unverified', reasons: ['Expected a read-back value but none was returned.'] };
      if (!readback.includes(String(expected))) {
        return {
          ...withKind,
          state: 'contradicted',
          reasons: [`Read-back did not contain the expected text. Found: ${readback.slice(0, 120)}`],
        };
      }
      reasons.push('Read-back contains the expected value.');
    } else if (!readback) {
      return { ...withKind, state: 'unverified', reasons: ['Read-back evidence was empty.'] };
    } else {
      reasons.push('A concrete read-back value was returned.');
    }
  }

  if (kind === 'command-output') {
    const output = String(evidence.readback ?? evidence.detail ?? '').trim();
    if (!output) return { ...withKind, state: 'unverified', reasons: ['Command output evidence was empty.'] };
    const expected = claim?.expect?.readbackContains;
    if (expected != null && !output.includes(String(expected))) {
      return { ...withKind, state: 'contradicted', reasons: [`Command output did not contain "${String(expected)}".`] };
    }
    reasons.push('Command produced real output.');
  }

  if (kind === 'http-response') {
    const detail = String(evidence.detail ?? '').trim();
    if (!/HTTP\s+\d{3}/i.test(detail) && !/^\d{3}$/.test(detail)) {
      return { ...withKind, state: 'unverified', reasons: ['HTTP evidence must record the actual status code.'] };
    }
    reasons.push(`HTTP evidence recorded: ${detail.slice(0, 80)}`);
  }

  // Explicit filesystem expectation on the claim itself, independent of kind.
  const expectedPath = claim?.expect?.pathExists;
  if (expectedPath) {
    let exists = false;
    try {
      exists = fs.existsSync(expectedPath);
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        ...withKind,
        state: 'contradicted',
        reasons: [...reasons, `The claim said ${expectedPath} exists, but it does not.`],
      };
    }
    reasons.push(`Expected path confirmed: ${expectedPath}`);
  }

  return { ...withKind, state: 'verified', verified: true, reasons };
}

/** A blocked verification (host cannot be observed here) is never a pass. */
export function blockedVerification(claim: Claim, reason: string): VerificationResult {
  return {
    state: 'blocked',
    verified: false,
    claim: String(claim?.statement ?? '').slice(0, 500),
    evidenceKind: 'none',
    reasons: [String(reason).slice(0, 300)],
    blocked: true,
  };
}

/**
 * Kernel handler outcome for a verified claim: a claim that fails verification
 * can never be reported as `ok:true`, which is what stops a model from
 * declaring a task complete without evidence ids.
 */
export function outcomeForClaim(claim: Claim, evidence: Evidence | null | undefined): {
  result: VerificationResult;
  outcome: { ok: true; summary: string; receipt: { kind: string; reference: string } } | { ok: false; retryable: boolean; error: { code: string; messageClass: string }; summary: string };
} {
  const result = verifyClaim(claim, evidence);
  if (result.verified) {
    return {
      result,
      outcome: {
        ok: true,
        summary: `${claim.statement} (verified: ${result.evidenceKind})`,
        receipt: {
          kind: 'verified-claim',
          reference: `${result.evidenceKind}:${evidence?.operationId ?? evidence?.path ?? result.claim.slice(0, 40)}`,
        },
      },
    };
  }
  const blocked = result.state === 'blocked';
  return {
    result,
    outcome: {
      ok: false,
      retryable: !blocked && result.state === 'unverified',
      error: { code: blocked ? 'VERIFICATION_BLOCKED' : 'VERIFICATION_FAILED', messageClass: 'verification' },
      summary: `${claim.statement} — ${result.state}: ${result.reasons.join(' ')}`.slice(0, 400),
    },
  };
}
