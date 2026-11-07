/**
 * Standalone CI-only prompt battery teardown.
 *
 * Closing the HTTP fixture BEFORE its Chrome/Edge sessions leaves outstanding
 * keep-alive connections, which can stall server.close() indefinitely and
 * suppress FINAL / prompt-battery.json despite completed agent turns.
 *
 * Close browsers first; bound teardown, independently record any cleanup
 * problems, and never transform missing outcome evidence into a PASS.
 */
export async function closeQaFixture({
  browserSessions = [],
  closeBrowser,
  server,
  runtime,
  browserDeadlineMs = 6500,
  serverDeadlineMs = 2500,
  runtimeDeadlineMs = 6500,
} = {}) {
  const problems = [];
  const bounded = async (label, fn, ms) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), ms);
        }),
      ]);
    } catch (err) {
      problems.push(label + ': ' + String(err?.message || err));
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const sessions = [...new Set(browserSessions)];
  for (const session of sessions) {
    await bounded('browser ' + session, () => closeBrowser(session, { wait: true }), browserDeadlineMs);
  }

  const serverStatus = await new Promise(resolve => {
    if (!server) return resolve('not_started');
    let resolved = false, forced = false;
    const done = state => {
      if (resolved) return;
      resolved = true;
      clearTimeout(forceTimer);
      clearTimeout(failTimer);
      resolve(state);
    };
    const forceTimer = setTimeout(() => {
      forced = true;
      problems.push('server: HTTP connections required forced close');
      try { server.closeAllConnections?.(); }
      catch (err) { problems.push('server force-close: ' + String(err?.message || err)); }
    }, serverDeadlineMs);
    const failTimer = setTimeout(() => {
      problems.push('server: close callback never returned');
      done('timeout');
    }, serverDeadlineMs + 2000);
    try {
      server.close(err => done(err ? 'error' : forced ? 'forced' : 'closed'));
      server.closeIdleConnections?.();
    } catch (err) {
      problems.push('server: ' + String(err?.message || err));
      done('error');
    }
  });
  if (serverStatus === 'error') problems.push('server: close failed');

  if (runtime?.shutdown) {
    await bounded('runtime shutdown', () => runtime.shutdown(), runtimeDeadlineMs);
  }
  return { browsers: sessions.length, server: serverStatus, ok: problems.length === 0, problems };
}
