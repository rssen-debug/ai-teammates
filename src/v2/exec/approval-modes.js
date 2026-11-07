/**
 * V2 approval handling modes (master brief sections 36-39).
 * Mode + safety tier + whitelist status -> decision for the executor.
 * Forever forbidden ('no' tier) blocks in EVERY mode; that rule cannot loosen.
 */
export const APPROVAL_MODES = Object.freeze(['guided', 'balanced', 'auto', 'hands_off']);

/**
 * decide({mode, tier, whitelisted}) -> {decision: 'allow'|'ask'|'blocked', reason}
 *   guided    - ok: allow if whitelisted, else ask; hold: always ask
 *   balanced  - ok: allow; whitelisted ok: allow; hold: ask
 *   auto      - ok: allow; unwhitelisted ok-items: ask (trust the list); hold: ask
 *   hands_off - ok+whitelisted: allow; hold: pause-this-task == ask but recorded differently
 */
export function decide({ mode, tier, whitelisted }) {
  if (!APPROVAL_MODES.includes(mode)) throw new Error(`unknown approval mode: ${mode}`);
  if (tier === 'no') return { decision: 'blocked', reason: 'forbidden tier — cannot run in any mode (brief 40)' };
  switch (mode) {
    case 'guided':
      if (tier === 'ok' && whitelisted) return { decision: 'allow', reason: 'guided: whitelisted read-safe commands pass' };
      return { decision: 'ask', reason: `guided asks for non-whitelisted/${tier} commands` };
    case 'balanced':
      if (tier === 'ok') return { decision: 'allow', reason: 'balanced: small+reversible steps auto-approved' };
      return { decision: 'ask', reason: 'balanced asks before risky or irreversible steps' };
    case 'auto':
      if (tier === 'ok' && whitelisted) return { decision: 'allow', reason: 'auto: whitelisted ok commands' };
      if (tier === 'ok') return { decision: 'ask', reason: 'auto: executable outside whitelist must be reviewed (or added)' };
      return { decision: 'ask', reason: 'auto asks before risky or external actions' };
    case 'hands_off':
    default:
      if (tier === 'ok' && whitelisted) return { decision: 'allow', reason: 'hands_off: autonomous under plan supervision' };
      if (tier === 'ok') return { decision: 'ask', reason: 'hands_off: new executables need one-time review' };
      return { decision: 'ask', reason: 'hands_off: risky execution pauses the goal (escalate, not block)' };
  }
}
