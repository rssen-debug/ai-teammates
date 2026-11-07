/**
 * MAJIN V4 — approval policy: ask, or full trust.
 *
 * The owner's machine, the owner's decision. Up to now the only choices were
 * `sandbox-auto` (workspace writes auto-approved, every host tool held) and
 * `strict` (everything held). A real task — find a file, open a browser, search —
 * therefore stopped at the first `browser_open` and waited for a human, and the
 * card said "no consent on file for this exact scope", which is accurate and
 * useless.
 *
 * Two policies, named for what they actually do:
 *
 *   ask   the default. A held tool waits for the owner.
 *   auto  full trust. Every tool the owner has granted a LANE for runs without a
 *         prompt. This is the owner's explicit instruction, so it is honoured —
 *         but it is never silent:
 *
 *           - it is a stored decision, visible in the app and readable at
 *             GET /api/approvals, so the owner can always see which mode is live
 *           - every auto-approved held call is emitted as an event and written to
 *             telemetry, because "no prompts" must not mean "no record"
 *           - it does NOT widen which tools exist. Owner Mode still decides which
 *             lanes are available; full trust only removes the per-call prompt
 *             inside those lanes. Revoking a lane still removes its tools.
 *
 * `strict` from the old configuration keeps working and means `ask` — a held tool
 * always waits.
 */
import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_SCHEMA = 'majin.v4.approval-policy/v1';

export const APPROVAL_POLICIES = Object.freeze({
  ASK: 'ask',
  AUTO: 'auto',
});

export class ApprovalPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalPolicyError';
    this.code = code;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The stored policy, or the supplied default when nothing is stored. */
export function readApprovalPolicy(file, { fallback = APPROVAL_POLICIES.ASK } = {}) {
  const raw = readJson(file);
  if (!raw || raw.schema !== APPROVAL_SCHEMA) return fallback;
  return raw.policy === APPROVAL_POLICIES.AUTO ? APPROVAL_POLICIES.AUTO : APPROVAL_POLICIES.ASK;
}

/** Persist a policy decision. Anything but `auto` is stored as `ask`. */
export function writeApprovalPolicy(file, policy, { now = () => new Date().toISOString() } = {}) {
  if (!Object.values(APPROVAL_POLICIES).includes(policy)) {
    throw new ApprovalPolicyError('UNKNOWN_POLICY', `policy must be one of ${Object.values(APPROVAL_POLICIES).join(', ')}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    schema: APPROVAL_SCHEMA,
    policy,
    updatedAt: now(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * A policy-aware view of V2's `Approvals`.
 *
 * V2's runner asks `approvals.check(scope)`. Rather than modifying V2 — which is
 * the one library every version shares — this wraps it: in `auto` the answer is
 * always allow, in `ask` the real store answers. `grant`, `revoke` and `status`
 * pass straight through, so the existing approval-continuation flow is untouched.
 */
export function createPolicyAwareApprovals({ approvals, policyFile, onAutoApprove = null, fallback = APPROVAL_POLICIES.ASK }) {
  let policy = readApprovalPolicy(policyFile, { fallback });

  /**
   * The file can be changed by another process — the CLI, or a second app window.
   * A cached value would let the server keep asking after the owner said "never
   * ask", so every held call reads the file. It is a few hundred bytes and only
   * consulted for held tools, which is already the slow path; a modification-time
   * check is not enough because two writes can land in the same millisecond.
   */
  function sync() {
    policy = readApprovalPolicy(policyFile, { fallback });
    return policy;
  }

  const facade = {
    get policy() {
      return sync();
    },
    /** Re-read from disk now. */
    refresh() {
      return sync();
    },
    set(policyName) {
      writeApprovalPolicy(policyFile, policyName);
      return facade.refresh();
    },
    check(scope, detail = {}) {
      sync();
      if (policy === APPROVAL_POLICIES.AUTO) {
        // Recorded, never silent. The caller decides where the record goes.
        try {
          onAutoApprove?.({ scope, detail, at: new Date().toISOString() });
        } catch {
          /* an audit hook must never block the work it is recording */
        }
        return { decision: 'allow', note: 'owner full-trust policy' };
      }
      return approvals.check(scope, detail);
    },
    grant(scope, options) {
      return approvals.grant(scope, options);
    },
    revoke(scope) {
      return approvals.revoke(scope);
    },
    status(scope) {
      sync();
      if (policy === APPROVAL_POLICIES.AUTO) {
        return Object.freeze({ scope, granted: true, mode: 'auto', user: 'owner', policy });
      }
      return approvals.status(scope);
    },
    /** The underlying store, for the approval-continuation flow. */
    inner: approvals,
  };
  return facade;
}
