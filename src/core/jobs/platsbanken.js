/**
 * MAJIN — job-site adapter: Platsbanken (Arbetsförmedlingen, JobTech Dev).
 * Public API, no key, JSON. The REAL shape was observed 2026-10-18
 * (hits[]: id, webpage_url, headline, application_deadline, description.text,
 * employer.name, workplace_address.municipality/city, application_details
 * {url|email}, must_have/nice_to_have {skills:[{label}]}).
 *
 * parseHits() is pure and fixture-tested — the wire part is five lines.
 */
const API = 'https://jobsearch.api.jobtechdev.se/search';

const labels = (list) => (Array.isArray(list) ? list.map((s) => s && s.label).filter(Boolean) : []);

/** one API hit → canonical job (fields the pipeline can rely on) */
export function parseHit(h) {
  const app = h.application_details || {};
  const wp = h.workplace_address || {};
  return {
    site: 'platsbanken',
    siteId: h.id == null ? null : String(h.id),
    title: h.headline || '',
    company: (h.employer && h.employer.name) || '',
    city: wp.city || wp.municipality || null,
    country: wp.country || 'SE',
    url: h.webpage_url || null,
    deadline: h.application_deadline || null,
    published: h.publication_date || null,
    description: (h.description && h.description.text) || '',
    mustHave: labels(h.must_have && h.must_have.skills),
    niceToHave: labels(h.nice_to_have && h.nice_to_have.skills),
    experienceRequired: h.experience_required === true,
    vacancies: Number(h.number_of_vacancies) || 1,
    apply: app.url ? { url: app.url } : app.email ? { email: app.email } : null,
  };
}

export function parseHits(json) {
  const hits = json && Array.isArray(json.hits) ? json.hits : [];
  return { total: Number(json && json.total && json.total.value != null ? json.total.value : json.total) || hits.length, jobs: hits.map(parseHit) };
}

/** search Platsbanken. errors come back shaped — never thrown raw at a tool. */
export async function searchPlatsbanken({ q, limit = 10, offset = 0, timeoutSec = 15 } = {}) {
  const url = `${API}?q=${encodeURIComponent(String(q || '').trim())}&limit=${Math.min(100, Math.max(1, limit))}&offset=${Math.max(0, offset)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutSec * 1000);
  t.unref?.();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'MAJIN-jobs/1.0 (+https://github.com/rssen-debug/MAJINCLI)' } });
    if (!res.ok) return { ok: false, error: { code: 'site_http', message: `Platsbanken answered HTTP ${res.status} — try again in a minute`, status: res.status } };
    const json = await res.json();
    return { ok: true, ...parseHits(json) };
  } catch (e) {
    return { ok: false, error: { code: 'site_unreachable', message: `could not reach Platsbanken (${e.name === 'AbortError' ? 'timeout' : e.message})` } };
  } finally {
    clearTimeout(t);
  }
}
