/* Cost truth, the honest kind.
   Providers like OpenRouter and Kilo answer GET /models with per-model
   pricing; that answer beats any table we could curate by hand (prices move).
   We import it as GAPS ONLY: a price that already exists — shipped default or
   hand-set — is never overwritten by a later list, and every imported price
   carries provenance so the UI can say where the number came from.

   Per-token prices come in as strings like "0.00000014" (USD per token); we
   store USD per 1M tokens to match the DeepSeek table shape ({in,out}). */

const PER_MILLION = 1e6;
import { keylessUrl } from './presets.js';
const priceNumber = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

/** payload → { 'provider/model': {in, out} }; models without a price are absent. */
export function extractPricing(providerName, payload) {
  const rows = payload?.data || payload?.models || [];
  const out = {};
  for (const m of Array.isArray(rows) ? rows : []) {
    const id = String(m?.id || m?.name || '');
    if (!id) continue;
    const p = m?.pricing;
    if (!p || p.prompt == null || p.completion == null) continue; // unknown stays unknown — never $0
    if (priceNumber(p.prompt) === null || priceNumber(p.completion) === null) continue;
    const pin = Number(p.prompt) * PER_MILLION;
    const pout = Number(p.completion) * PER_MILLION;
    if (!Number.isFinite(pin) || !Number.isFinite(pout)) continue;
    const ref = `${providerName}/${id}`;
    // free tiers ("...:free") land as real zeros — that is data, not a guess
    out[ref] = { in: roundPrice(pin), out: roundPrice(pout) };
    const extra = Object.entries(p).filter(([key]) => !['prompt', 'completion'].includes(key) && priceNumber(p[key]) !== 0);
    // Preserve fee units: request/image charges are not token prices. Their
    // presence blocks a free classification; token-only estimates remain a floor.
    if (extra.length) out[ref].extra = Object.fromEntries(extra);
  }
  return out;
}

/* price per 1M tokens, enough decimals to keep small prices non-zero */
function roundPrice(usd) {
  if (usd === 0) return 0;
  return Number(usd.toPrecision(6));
}

/**
 * Fill pricing gaps from a /models payload. Never overwrites an existing
 * price. Returns { imported, skipped, refs } and stamps pricingMeta with
 * provenance for the newly imported keys only.
 */
export async function importPricing(cfg, providerName, payload, { source } = {}) {
  const found = extractPricing(providerName, payload);
  const current = { ...(cfg.get('pricing') || {}) };
  const meta = { ...(cfg.get('pricingMeta') || {}) };
  const patch = {};
  const refs = [];
  for (const [ref, price] of Object.entries(found)) {
    if (current[ref]) continue; // kuraterat vinner alltid
    patch[ref] = price;
    meta[ref] = { source: source || `${providerName}:/models`, at: new Date().toISOString() };
    refs.push(ref);
  }
  const skipped = Object.keys(found).length - refs.length;
  if (refs.length) {
    await cfg.patch({ pricing: { ...current, ...patch }, pricingMeta: meta }, { source: 'pricing.import' });
  }
  return { imported: refs.length, skipped, refs };
}

/**
 * Does a route cost money, as far as we can honestly tell?
 * Free = explicit 0/0 price, the mock provider, or your own machine/LAN
 * (loopback/RFC1918 — same rule the key box uses). A remote endpoint with NO
 * price data is treated as paid: under a spending cap, "we don't know" must
 * never spend money by default.
 */
/** Del 6A: an honest price answer. A KNOWN price is either a real pricing table
   or provably free (local/mock/$0). Everything else is UNKNOWN and must never be
   displayed as $0. */
export function priceKnownForRoute(route = {}) {
  if (isFreeRoute(route)) return true;
  const p = route.pricing;
  return Boolean(p && (Number(p.in) > 0 || Number(p.out) > 0));
}

export function isFreeRoute(route = {}) {
  if (!route) return false;
  if (route.kind === 'mock') return true;
  const p = route.pricing;
  if (p && priceNumber(p.in) === 0 && priceNumber(p.out) === 0 && Object.values(p).every(value => priceNumber(value) === 0)) return true;
  return keylessUrl(route.baseUrl);
}
