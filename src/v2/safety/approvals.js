/**
 * V2 consent/session layers (master brief sections 53-58).
 *
 * Held operations never execute until a consent record for the EXACT scope
 * exists, is unexpired, and has uses left. One-time consent is consumed on use.
 * Time-limited consent auto-expires. Session consent is bounded by scope and
 * can be revoked. Every decision is emitted so it lands in the audit trail.
 */
export class Approvals {
  constructor(events) { this.events = events; this.consents = new Map(); }

  /** scope e.g. "shell:hold", "browser:submit-form:example.com", "fs:delete:/tmp/x" */
  grant(scope, { user, mode = 'once', maxUses = 1, ttlMs = 0 } = {}) {
    if (!user) throw new Error('consent requires a named human (no self-consent)');
    if (!['once', 'limited', 'session'].includes(mode)) throw new Error('unknown consent mode');
    const rec = { user, mode, maxUses, uses: 0, grantedAt: Date.now(), expiresAt: ttlMs ? Date.now() + ttlMs : 0 };
    this.consents.set(scope, rec);
    this.events.emit('task.updated', { taskId: `consent:${scope}`, to: 'granted', mode, maxUses, ttlMs });
    return scope;
  }

  revoke(scope) {
    this.consents.delete(scope);
    this.events.emit('consent.revoked', { scope });
  }

  /** status(scope): read-only snapshot for operator surfaces. Never mutates;
   *  never consumes a use. Frozen so callers cannot reach into the store. */
  status(scope) {
    const rec = this.consents.get(scope);
    if (!rec) return Object.freeze({ scope, granted: false });
    const expired = rec.expiresAt && Date.now() > rec.expiresAt;
    return Object.freeze({
      scope,
      granted: !expired,
      mode: rec.mode,
      user: rec.user,
      uses: rec.uses,
      maxUses: rec.maxUses,
      usesLeft: Math.max(0, rec.maxUses - rec.uses),
      grantedAt: rec.grantedAt,
      expiresAt: rec.expiresAt || null,
      expired: !!expired,
    });
  }

  /** check(scope): exactly what the executor asks before touching a held op */
  check(scope, detail = {}) {
    const rec = this.consents.get(scope);
    if (!rec) return { decision: 'waiting', note: 'no consent on file for this exact scope' };
    if (rec.expiresAt && Date.now() > rec.expiresAt) {
      this.consents.delete(scope);
      this.events.emit('consent.expired', { scope });
      return { decision: 'waiting', note: 'consent expired before use' };
    }
    if (rec.uses >= rec.maxUses) {
      return { decision: 'waiting', note: 'consent uses exhausted' };
    }
    rec.uses += 1;
    if (rec.mode === 'once' || rec.uses >= rec.maxUses) this.consents.delete(scope);
    this.events.emit('task.updated', { taskId: `consent:${scope}`, to: 'used', usesLeft: rec.maxUses - rec.uses });
    return { decision: 'allow', note: detail.preflightReason || '' };
  }
}
