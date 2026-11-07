/**
 * Exact, independent read-back of selected model after a config PATCH.
 * Do not compare abbreviated display names, or conflate OpenCode Go
 * (a provider) with a similarly named Zen/model route.
 */
export function confirmSelectedModel(state, providerName, modelId, jobs) {
  if (!state || !Array.isArray(state.routes)) {
    return { ok: false, reason: 'Server did not return active model routes', missing: jobs || [] };
  }
  const name = String(providerName || '').trim();
  const id = String(modelId || '').trim();
  const expected = name + '/' + id;
  if (!name || !id || !Array.isArray(jobs) || !jobs.length) {
    return { ok: false, reason: 'Invalid model selection request', missing: jobs || [] };
  }
  const routes = new Map(state.routes.map(row => [row.job, row]));
  const missing = jobs.filter(job => routes.get(job)?.ref !== expected ||
    routes.get(job)?.provider !== name);
  if (missing.length) {
    return { ok: false, reason: 'Active server model does not match the saved selection', missing, expected };
  }
  if (state.moa?.policy !== 'off') {
    return { ok: false, reason: 'Multi-model routing stayed enabled after choosing one model', missing: [], expected };
  }
  return { ok: true, reason: 'Exact provider/model confirmed from fresh server state', missing: [], expected };
}
