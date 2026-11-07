/** Per-key serialization: two jobs for the same key NEVER interleave.
 * Different keys run freely in parallel — one slow chat must not block a
 * Telegram ping, but two turns on the same session must not split each
 * other's context window or half-write each other's history. */
const tails = new Map();

export function serial(key, fn) {
  const k = String(key || 'default');
  const prev = tails.get(k) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  /* the stored tail never rejects, so one failed job cannot poison the chain */
  const tail = run.then(() => undefined, () => undefined);
  tails.set(k, tail);
  tail.then(() => {
    if (tails.get(k) === tail) tails.delete(k); // nothing queued behind us
  });
  return run;
}

/** tests + diagnostics only */
export function pendingKeys() {
  return [...tails.keys()];
}
