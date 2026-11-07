/**
 * V2 goal state machine (master brief section 3.4).
 *
 * Single source for the twelve states and which transitions are legal.
 * COMPLETED is reachable only from VERIFYING, and the goal itself refuses
 * that hop unless every acceptance item carries verified evidence — the
 * model saying "done" is not evidence.
 */

export const STATES = Object.freeze({
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  WAITING_FOR_TOOL: 'WAITING_FOR_TOOL',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  VERIFYING: 'VERIFYING',
  RECOVERING: 'RECOVERING',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
});

/** Terminal states: no further transitions are permitted. */
export const TERMINAL = Object.freeze(new Set([
  STATES.FAILED,
  STATES.CANCELLED,
  STATES.COMPLETED,
]));

/**
 * Legal transitions. Missing key = no legal exit (terminal).
 * BLOCKED and RECOVERING may return to RUNNING; FAILED/CANCELLED/COMPLETED never.
 */
export const TRANSITIONS = Object.freeze({
  CREATED: ['PLANNING', 'CANCELLED'],
  PLANNING: ['READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_TOOL', 'WAITING_FOR_APPROVAL', 'VERIFYING', 'RECOVERING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_TOOL: ['RUNNING', 'RECOVERING', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['RUNNING', 'CANCELLED', 'BLOCKED'],
  VERIFYING: ['COMPLETED', 'RECOVERING', 'FAILED'],
  RECOVERING: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['RUNNING', 'FAILED', 'CANCELLED'],
});

/** True when `from -> to` is a legal transition. */
export function canTransition(from, to) {
  const exits = TRANSITIONS[from];
  return Array.isArray(exits) && exits.includes(to);
}

/** Throws with a readable reason when the hop is illegal. */
export function assertTransition(from, to) {
  if (!Object.values(STATES).includes(from)) {
    throw new Error(`unknown state: ${String(from)}`);
  }
  if (!Object.values(STATES).includes(to)) {
    throw new Error(`unknown state: ${String(to)}`);
  }
  if (TERMINAL.has(from)) {
    throw new Error(`goal is in terminal state ${from}; cannot move to ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}
