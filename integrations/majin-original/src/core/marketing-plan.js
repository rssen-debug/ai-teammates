/**
 * MAJIN Micro-Budget Marketing Planner.
 *
 * Computes concrete break-even guardrails and a no-spend-first 7-day plan.
 * ZERO model calls, ZERO remote requests, ZERO ad mutations.
 * User-reported sales are unverified; never claim a conversion, revenue or profit.
 */
import { contributionEconomics } from './marketing.js';

const money = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

function economicInput(input = {}, configured = {}) {
  const args = input.product || {};
  const base = configured?.economics || {};
  const ccy = String(input.currency || 'SEK').toUpperCase();
  const configMatches = configured?.meta?.currency === ccy;
  const get = (k) => optionalNumber(args[k], configMatches ? base[k] : 0);
  return {
    currency: ccy,
    price: get('price'),
    cogs: get('cogs'),
    shipping: get('shipping'),
    fees: get('fees'),
    refundRate: get('refundRate'),
    targetProfit: get('targetProfit'),
  };
}

export function microMarketingPlan(input = {}, configured = {}) {
  const totalBudget = optionalNumber(input.totalBudget, NaN);
  const currency = String(input.currency || configured?.meta?.currency || 'SEK').toUpperCase();
  const site = String(input.site || '').trim().slice(0, 150);
  if (!finite(totalBudget) || totalBudget < 0 || totalBudget > 1_000_000) throw new Error('totalBudget must be a finite amount between 0 and 1000000. It is the TOTAL ad allowance, not a daily amount.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter ISO code such as SEK.');
  if (site && (!/^(https?:\/\/)?[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(site) || /(?:localhost|\.local|127\.0\.0\.1)/i.test(site))) throw new Error('site must be a public website hostname or URL.');
  const p = economicInput({ ...input, currency }, configured);
  for (const k of ['price','cogs','shipping','fees','refundRate','targetProfit']) {
    if (!finite(p[k]) || p[k] < 0) throw new Error('product.' + k + ' must be a nonnegative finite number.');
  }
  if (p.refundRate > 1) throw new Error('product.refundRate is a fraction between 0 and 1, e.g. 0.05.');
  const knownMargin = p.price > 0 && p.price > p.cogs + p.shipping + p.fees;
  const margin = knownMargin ? contributionEconomics(p) : null;
  const sales = optionalNumber(input.reportedPastOrders, 0);
  const oldCpa = input.historicalCpa == null ? null : Number(input.historicalCpa);
  if (!Number.isInteger(sales) || sales < 0 || sales > 1_000_000) throw new Error('reportedPastOrders must be a nonnegative integer.');
  if (oldCpa !== null && (!finite(oldCpa) || oldCpa < 0)) throw new Error('historicalCpa must be a nonnegative number or omitted.');
  const tracking = input.trackingReady === true; // user-reported; cannot confirm Pixel from input alone
  const minOrders = margin?.contributionPerOrder > 0 ? Math.ceil(totalBudget / margin.contributionPerOrder) : null;
  const targetOrders = margin?.targetCpa > 0 ? Math.ceil(totalBudget / margin.targetCpa) : null;
  const enoughEvidence = Boolean(margin && tracking && sales >= 5 && oldCpa !== null && oldCpa > 0 && oldCpa <= margin.targetCpa);
  const enoughBudget = Boolean(margin && totalBudget >= 3 * margin.targetCpa);
  const paidCandidate = Boolean(totalBudget > 0 && enoughEvidence && enoughBudget);
  const proposedPaidTest = paidCandidate ? money(Math.min(totalBudget, 3 * margin.targetCpa)) : 0;
  const reasons = [];
  if (!margin) reasons.push('Real product economics are missing or the reported price does not cover product, shipping and fees.');
  if (!tracking) reasons.push('Verified purchase tracking has not been demonstrated; reporting trackingReady=true alone is not independent evidence.');
  if (sales < 5) reasons.push('Fewer than five user-reported past orders; insufficient evidence to predict acquisition cost.');
  if (oldCpa === null) reasons.push('No historical acquisition cost provided from actual sales.');
  else if (margin && oldCpa > margin.targetCpa) reasons.push('Historical reported CPA exceeds target CPA, so there is no conservative case for paid scaling.');
  if (!enoughBudget && margin) reasons.push('The total budget cannot fund even three conversions at target CPA; a paid test would be inconclusive.');
  const nextQuestions = [];
  if (!site) nextQuestions.push('What is the website URL?');
  if (!margin) nextQuestions.push('What are the sale price and product, fulfillment, shipping and payment costs per order in ' + currency + '?');
  if (!tracking) nextQuestions.push('Are checkout purchases being verified by WooCommerce and Meta Pixel/Conversions API?');
  if (oldCpa === null && sales > 0) nextQuestions.push('Do you have real paid-order history and your past customer acquisition cost?');
  const name = String(input.product?.name || 'the main product').slice(0, 100);
  return {
    ok: true,
    objective: 'first profitable orders without wasting the marketing budget',
    site: site || null,
    currency,
    totalBudget,
    paidAdsRecommended: paidCandidate,
    proposedPaidTest, // suggestion ONLY: NOT a live budget limit or spend action
    reservedBudget: money(totalBudget - proposedPaidTest),
    mode: paidCandidate ? 'small_paid_test_candidate' : 'organic_first',
    economics: margin ? {
      ...margin,
      minOrdersToRecoverFullBudget: minOrders,
      minOrdersToMeetTargetCpa: targetOrders,
      estimatedOnly: true,
    } : null,
    safeguards: {
      neverAutoSpend: true,
      requireUserApproval: true,
      allocationIsNotPlatformCap: true,
      providerTokensNotAdSpend: true,
      noProfitGuarantee: true,
      dataConfidence: 'user-reported economics, tracking and prior orders have NOT been independently reconciled',
    },
    reasons: paidCandidate
      ? ['A paid experiment is a candidate only; first verify actual WooCommerce orders and Meta attribution before approving.']
      : reasons,
    sevenDayPlan: [
      { day: 1, channel: 'store', step: 'Inspect mobile checkout, page speed, trust details, shipping and product promise for ' + name, cost: 0, evidence: 'A short list of specific conversion blockers and the live product URL' },
      { day: 2, channel: 'creative', step: 'Prepare three distinct factual UGC hooks, one demonstration and one buyer-objection answer; no invented reviews or claims', cost: 0, evidence: '3 scripts and real product footage checklist' },
      { day: 3, channel: 'organic', step: 'Publish one short product demonstration using your own account; do not mass-spam communities', cost: 0, evidence: 'Post URL and actual views, saves, profile visits' },
      { day: 4, channel: 'organic', step: 'Test a second creative angle or honest product comparison, keeping the offer the same', cost: 0, evidence: 'A second post URL and engagement measurements' },
      { day: 5, channel: 'measurement', step: 'Check store sessions, add-to-cart, checkout starts and real paid orders; check Meta attribution separately', cost: 0, evidence: 'Funnel counts with dates and source; unknown values stay unknown' },
      { day: 6, channel: 'conversion', step: 'Fix the largest verified checkout or product-page obstacle; do not invent discounts', cost: 0, evidence: 'Before/after change with verification' },
      { day: 7, channel: 'decision', step: paidCandidate
        ? 'Review whether a tightly limited paid creative test is justified; ask approval first'
        : 'Compare the free creative tests; preserve the cash budget until valid purchase evidence exists',
        cost: 0, evidence: 'Actual store orders, attributed ad purchases and recommended next test' },
    ],
    nextQuestions,
    disclaimer: 'This is a read-only action plan, not advertising execution or proof of profitable sales. Paid ads can spend the entire budget without any purchases.',
    modelCalls: 0,
  };
}
