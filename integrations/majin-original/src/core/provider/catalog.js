import { listModelsUrl } from '../presets.js';
import { normalizeCatalog } from '../../ui/catalog.js';

// Shared by HTTP, UI and agent tools. Listing never makes an inference request.
export async function discoverModels(provider, { fetchImpl = globalThis.fetch } = {}) {
  const initial = listModelsUrl(provider);
  const headers = { accept: 'application/json', ...(provider.headers || {}) };
  const key = provider.apiKey || (provider.keyEnv && process.env[provider.keyEnv]);
  if (provider.kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (provider.kind === 'gemini' && !/\/openai(?:\/|$)/.test(initial)) {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) headers.authorization = `Bearer ${key}`;
  let status = 0;
  try {
    let next = new URL(initial);
    const origin = next.origin, visited = new Set(), rows = [];
    while (next) {
      if (visited.has(next.href) || visited.size >= 100) throw new Error('Catalog pagination did not finish; no partial catalog was saved.');
      if (next.origin !== origin) throw new Error('Catalog pagination changed origin; credentials were not forwarded.');
      visited.add(next.href);
      const response = await fetchImpl(next, { headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
      status = response.status;
      const payload = await response.json();
      if (!response.ok || payload.error || payload.success === false) {
        return { ok: false, status, error: `Catalog request failed (HTTP ${status}). Check the key, endpoint and account access.`, hint: 'Check the key, endpoint and account permissions; no inference was attempted.' };
      }
      const page = Array.isArray(payload) ? payload : payload.data || payload.models || payload.output?.models;
      if (!Array.isArray(page)) throw new Error('The provider returned no recognized model list. Use an exact model ID or check its endpoint.');
      rows.push(...page);
      const current = next;
      next = null;
      if (payload.nextPageToken) {
        next = new URL(current); next.searchParams.set('pageToken', payload.nextPageToken);
      } else if (payload.has_more) {
        const cursor = payload.last_id || page.at(-1)?.id;
        if (!cursor || !page.length) throw new Error('Catalog pagination has no next cursor.');
        next = new URL(current); next.searchParams.set('after_id', cursor);
      } else if (payload.output?.total > rows.length) {
        if (!page.length) throw new Error('Catalog ended before its reported total.');
        next = new URL(current); next.searchParams.set('page_no', String(Number(current.searchParams.get('page_no') || 1) + 1));
      } else if (payload.next || payload.links?.next) {
        next = new URL(payload.next || payload.links.next, current);
      }
    }
    // Gemini native lists include embedding/image-only models. Keep chat candidates.
    const chatRows = rows.filter(m => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'));
    const catalog = [...new Map(normalizeCatalog({ data: chatRows }).map(m => [m.id, m])).values()];
    return { ok: true, status, models: catalog.map(m => m.id), catalog, count: catalog.length, payload: { data: chatRows } };
  } catch (error) {
    return { ok: false, status, error: error.message, hint: 'Check the provider endpoint and connection; no guessed models were saved.' };
  }
}
