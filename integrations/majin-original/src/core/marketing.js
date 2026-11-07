/**
 * MAJIN Marketing Autopilot — read-only Meta Ads intelligence.
 * One account, one currency, deterministic and token-free. NEVER mutates ads.
 * Meta-attributed purchases are signals, NOT confirmed WooCommerce profit.
 */
const API_VERSION = 'v23.0';
const PURCHASE_ACTIONS = [
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'purchase',
  'onsite_conversion.purchase',
];
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0;

export function checkMarketingConfig(settings) {
  const e = settings?.economics || {};
  const m = settings?.meta || {};
  const errors = [];
  if (!/^(act_)?[0-9]{3,25}$/.test(String(m.accountId || ''))) errors.push('Enter a valid Meta ad account ID, for example act_123456789.');
  if (!/^[A-Z]{3}$/.test(String(m.currency || ''))) errors.push('Enter the Meta ad account currency (ISO code, e.g. USD or SEK).');
  for (const field of ['price', 'cogs', 'shipping', 'fees', 'refundRate', 'targetProfit', 'dailyCap']) {
    const value = e[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) errors.push(field + ' must be a non-negative number.');
  }
  if (e.refundRate > 1) errors.push('refundRate must be a fraction between 0 and 1.');
  if (!(e.price > 0)) errors.push('Set the actual selling price (same currency as the ad account).');
  if (e.price <= e.cogs + e.shipping + e.fees) errors.push('Selling price must exceed product, shipping and payment costs.');
  if (!(e.dailyCap > 0)) errors.push('Set a positive maximum planned daily ad spend.');
  return errors;
}

export function marketingStatus(cfg) {
  const c = cfg.get('marketing') || {};
  const key = String(c.meta?.accessToken || '');
  const envMatch = /^\{env:([A-Z0-9_]+)\}$/.exec(key);
  const tokenReady = envMatch ? Boolean(process.env[envMatch[1]]) : Boolean(key.trim());
  return {
    connected: tokenReady && checkMarketingConfig(c).length === 0,
    accountId: c.meta?.accountId || '',
    currency: c.meta?.currency || '',
    economics: c.economics || {},
    mode: 'analysis_only',
    dataSource: 'Meta Ads Insights (attributed events, not confirmed shop revenue)',
    tokenSource: envMatch ? 'environment' : (tokenReady ? 'local_config' : 'missing'),
  };
}

export function contributionEconomics(e) {
  const margin = e.price * (1 - e.refundRate) - e.cogs - e.shipping - e.fees;
  const targetProfit = Math.max(num(e.targetProfit), margin * 0.20);
  const breakEvenCpa = Math.max(0, margin);
  const targetCpa = Math.max(0, margin - targetProfit);
  return { contributionPerOrder: round(margin), breakEvenCpa: round(breakEvenCpa), targetCpa: round(targetCpa), targetProfit: round(targetProfit) };
}

export function purchaseCount(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const name of PURCHASE_ACTIONS) {
    const row = actions.find((a) => a && a.action_type === name);
    if (row && Number.isFinite(Number(row.value))) return Math.max(0, Number(row.value));
  }
  return 0;
}

export function analyzeMarketing(rows, settings) {
  const errors = checkMarketingConfig(settings);
  if (errors.length) return { ok: false, errors };
  const economics = contributionEconomics(settings.economics);
  if (economics.targetCpa <= 0) return { ok: false, errors: ['No room for acquisition cost after costs and minimum profit reserve.'] };
  const expectedCurrency = settings.meta.currency;
  const returnedCurrencies = [...new Set(rows.map((r) => String(r.account_currency || '').toUpperCase()).filter(Boolean))];
  if (rows.length && (returnedCurrencies.length !== 1 || returnedCurrencies[0] !== expectedCurrency)) {
    return { ok: false, errors: ['Meta account currency is missing or differs from ' + expectedCurrency + '. Refusing to compare unverified currency values.'] };
  }
  const campaigns = rows.map((r) => {
    const spend = num(r.spend);
    const purchases = purchaseCount(r.actions);
    const cpa = purchases > 0 ? round(spend / purchases) : null;
    const estimatedContribution = round(purchases * economics.contributionPerOrder - spend);
    // One-sided ~80% Poisson lower-count approximation. Conservative, never a guarantee.
    const conservativePurchases = Math.max(0, purchases - 0.84 * Math.sqrt(purchases + 0.25));
    const conservativeCpa = conservativePurchases > 0 ? round(spend / conservativePurchases) : null;
    let decision = 'collect_data';
    let explanation = 'Too little reliable purchase evidence; keep testing within the daily cap.';
    let proposedChangePct = 0;
    if (spend > 0 && purchases === 0 && spend >= 2 * economics.targetCpa) {
      decision = 'review_tracking_or_pause';
      explanation = 'No attributed purchases after material spend; verify tracking, attribution delay and landing page before deciding to pause.';
    } else if (purchases >= 5 && cpa > economics.breakEvenCpa * 1.15) {
      decision = 'review_loss';
      explanation = 'Observed acquisition cost exceeds contribution margin; investigate attribution and real orders before continuing.';
    } else if (purchases >= 8 && cpa <= economics.targetCpa * 0.8 && conservativeCpa !== null && conservativeCpa <= economics.targetCpa) {
      decision = 'scale_candidate';
      proposedChangePct = 10;
      explanation = 'Conservative attributed results support a small +10% budget test, subject to manual approval and account cap.';
    } else if (purchases >= 5) {
      decision = 'hold_and_verify';
      explanation = 'Some purchase signal, but too much uncertainty to increase spend. Cross-check actual order margin.';
    }
    return {
      id: String(r.campaign_id || ''),
      name: String(r.campaign_name || 'Unnamed').slice(0, 140),
      spend: round(spend),
      purchases,
      cpa,
      conservativeCpa,
      estimatedContribution,
      decision,
      proposedChangePct,
      explanation,
    };
  }).sort((a, b) => b.spend - a.spend);
  const totalSpend = round(campaigns.reduce((s, c) => s + c.spend, 0));
  const totalPurchases = campaigns.reduce((s, c) => s + c.purchases, 0);
  const avgDailySpend = round(totalSpend / 7);
  return {
    ok: true,
    currency: expectedCurrency,
    attribution: 'Meta-attributed purchase events; NOT independently verified orders, incremental sales, or profit.',
    window: 'last_7d',
    economics,
    totals: {
      spend: totalSpend,
      purchases: totalPurchases,
      attributedCpa: totalPurchases ? round(totalSpend / totalPurchases) : null,
      estimatedContribution: round(campaigns.reduce((s, c) => s + c.estimatedContribution, 0)),
      observedAvgDailySpend: avgDailySpend,
      advisoryDailyCap: settings.economics.dailyCap,
      overAdvisoryCap: avgDailySpend > settings.economics.dailyCap,
    },
    campaigns,
    safety: 'Read-only. No campaigns, bids, or budgets changed. Budget cap is an advisory comparison, not an enforced Meta Ads spending limit.' + (rows.length ? '' : ' No campaign data exists yet; reporting currency could not be independently verified.'),
    nextStep: 'Verify orders and refunds in your shop; review proposals manually before making any Meta changes.',
  };
}

function accessToken(settings) {
  const key = String(settings?.meta?.accessToken || '');
  const match = /^\{env:([A-Z0-9_]+)\}$/.exec(key);
  return match ? String(process.env[match[1]] || '') : key;
}

export async function fetchMetaInsights(settings, { transport = fetch, maxPages = 5 } = {}) {
  const token = accessToken(settings);
  if (!token) throw new Error('Meta Ads access token missing. Connect your Meta account first.');
  const errors = checkMarketingConfig(settings);
  if (errors.length) throw new Error(errors.join(' '));
  const raw = String(settings.meta.accountId).replace(/^act_/, '');
  const url = new URL('https://graph.facebook.com/' + API_VERSION + '/act_' + raw + '/insights');
  url.searchParams.set('fields', 'account_currency,campaign_id,campaign_name,spend,actions');
  url.searchParams.set('level', 'campaign');
  url.searchParams.set('date_preset', 'last_7d');
  url.searchParams.set('limit', '100');
  const rows = [];
  let after = '';
  const pages = Math.min(5, Math.max(1, Number(maxPages) || 5));
  for (let i = 0; i < pages; i += 1) {
    if (after) url.searchParams.set('after', after);
    const res = await transport(url.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403
      ? 'Meta rejected the token or ads_read permission. Reconnect a token with ads_read access.'
      : 'Meta Insights API returned HTTP ' + res.status + '. Check account ID, access rights and API availability.');
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error('Meta Insights returned an invalid data structure.');
    rows.push(...json.data);
    if (rows.length > 500) throw new Error('More than 500 campaign rows; narrow the account or reporting period.');
    after = json.paging?.cursors?.after || '';
    if (!json.paging?.next) return rows;
    if (!after) throw new Error('Meta pagination cannot be verified, refusing to follow untrusted links.');
  }
  throw new Error('Meta report exceeded the safe five-page limit; no incomplete optimization report will be used.');
}

export async function analyzeMetaAccount(cfg, opts = {}) {
  const settings = cfg.get('marketing') || {};
  const rows = await fetchMetaInsights(settings, opts);
  return analyzeMarketing(rows, settings);
}

// This is a small deterministic intent filter, not an extra LLM call.
// It only handles explicit requests to operate on advertising, not generic
// educational questions such as "what is marketing?".
export function wantsMarketingSetup(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s.length > 6000) return false;
  const platform = /\b(meta|facebook|instagram|fb)\b/.test(s);
  const adWords = /(ads|annonser|annons|kampanj|campaign|reklam|marknadsf\u00f6ring|marketing)/.test(s);
  const actionable = /(analy[sz]|optim|sk\u00f6t|hantera|granska|marknadsf\u00f6r|annonser|k\u00f6p|reklam|k\u00f6r|starta|f\u00f6rb\u00e4ttra|manage|run|improve|audit|review)/.test(s);
  return (platform && adWords && actionable) || (/(mina annonser|min facebook-marknadsf\u00f6ring|my facebook ads|my meta ads)/.test(s) && actionable);
}
