/**
 * V2 normalized failure classes (master brief section 23).
 *
 * Every executor/worker error collapses into one of the named classes plus a
 * retry hint. The scheduler drives recovery from this, not from raw messages.
 */

export const FAILURE_CLASSES = Object.freeze([
  'TIMEOUT', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'DEPENDENCY_MISSING',
  'ELEMENT_NOT_FOUND', 'ELEMENT_OBSCURED', 'WINDOW_NOT_FOUND', 'PROCESS_CRASH',
  'MODEL_FAILURE', 'MODEL_RATE_LIMIT', 'MODEL_CONTEXT_LIMIT', 'NETWORK_FAILURE',
  'INVALID_TOOL_OUTPUT', 'STALE_STATE', 'BUILD_FAILURE', 'TEST_FAILURE',
  'VERIFICATION_FAILURE', 'USER_ACTION_REQUIRED', 'UNKNOWN',
]);

/** class -> default retry behaviour for the scheduler. */
export const POLICY = Object.freeze([
  { cls: 'TIMEOUT', retry: true },
  { cls: 'AUTH_REQUIRED', retry: false },
  { cls: 'PERMISSION_DENIED', retry: false },
  { cls: 'DEPENDENCY_MISSING', retry: false },
  { cls: 'ELEMENT_NOT_FOUND', retry: true },
  { cls: 'ELEMENT_OBSCURED', retry: true },
  { cls: 'WINDOW_NOT_FOUND', retry: true },
  { cls: 'PROCESS_CRASH', retry: true },
  { cls: 'MODEL_FAILURE', retry: true },
  { cls: 'MODEL_RATE_LIMIT', retry: true },
  { cls: 'MODEL_CONTEXT_LIMIT', retry: false },
  { cls: 'NETWORK_FAILURE', retry: true },
  { cls: 'INVALID_TOOL_OUTPUT', retry: true },
  { cls: 'STALE_STATE', retry: true },
  { cls: 'BUILD_FAILURE', retry: false },
  { cls: 'TEST_FAILURE', retry: false },
  { cls: 'VERIFICATION_FAILURE', retry: false },
  { cls: 'USER_ACTION_REQUIRED', retry: false },
  { cls: 'UNKNOWN', retry: false },
]);

/**
 * Collapse anything thrown into a class + retry hint.
 * `hint` (string match) wins over shape heuristics for explicit signals:
 * executors should attach err.cls when they know.
 */
export function normalizeError(err, hint = null) {
  if (!err) return { detail: { cls: 'UNKNOWN', retry: false, message: '' } };
  const cls = err.cls && FAILURE_CLASSES.includes(err.cls)
    ? err.cls
    : classify(String(err.code || '') + ' ' + String(err.message || err));
  const p = POLICY.find((x) => x.cls === cls) || POLICY[POLICY.length - 1];
  return { detail: { cls, retry: hint === 'retry' ? true : hint === 'never' ? false : p.retry, message: String(err.message || err) } };
}

function classify(text) {
  const s = text.toUpperCase();
  if (/ECONNREFUSED|ECONNRESET|ENETDOWN|EAI_AGAIN|ENOTFOUND|socket hang up/.test(s)) return 'NETWORK_FAILURE';
  if (/ETIMEDOUT|TIMEOUT|DEADLINE/.test(s)) return 'TIMEOUT';
  if (/401|403|UNAUTH|UNAUTHORIZED|FORBIDDEN/.test(s)) return 'AUTH_REQUIRED';
  if (/EACCES|EPERM|PERMISSION/.test(s)) return 'PERMISSION_DENIED';
  if (/ENOENT|MODULE_NOT_FOUND|not found.*dependency|command not found/.test(s)) return 'DEPENDENCY_MISSING';
  if (/ELEMENT_NOT_FOUND|SELECTOR.*NOT.*FOUND|no such element/.test(s)) return 'ELEMENT_NOT_FOUND';
  if (/RATE.?LIMIT|429/.test(s)) return 'MODEL_RATE_LIMIT';
  if (/CONTEXT.?LIMIT|too many tokens|max_tokens|token limit/.test(s)) return 'MODEL_CONTEXT_LIMIT';
  if (/SYNTAX|BUILD FAILURE|compile error/.test(s)) return 'BUILD_FAILURE';
  return 'UNKNOWN';
}
