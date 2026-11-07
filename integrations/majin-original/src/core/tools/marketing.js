/**
 * Marketing intelligence tools: the language model may INSPECT, NEVER spend.
 * Credentials enter through a contextual secure chat form or an env reference, not tool args.
 */
import { def } from './registry.js';
import { marketingStatus, analyzeMetaAccount } from '../marketing.js';
import { channelStatus, readTikTokAds, readGoogleAds } from '../marketing-channels.js';
import { microMarketingPlan } from '../marketing-plan.js';

export const marketingTools = [
  def({
    name: 'marketing.channel_report',
    group: 'marketing',
    risk: 'read',
    desc: 'Fetch live campaign-level spend/click/impression reports from TikTok Ads or Google Ads using authorized locally configured platform-specific credentials. READ ONLY, NEVER changes ads. Distinguishes Google reported conversions from actual shop purchases, and cannot prove profit. If missing credentials, request a secure in-chat platform connection. No extra LLM requests for report calculations.',
    params: {platform:'string: tiktok or google'},
    required:['platform'],
    async run(args,ctx){
      try{
        const config=ctx.cfg.get('marketing')||{};
        const platform=String(args.platform||'').toLowerCase();
        const report=platform==='tiktok'?await readTikTokAds(config)
          :platform==='google'?await readGoogleAds(config)
          :null;
        if(!report)return {ok:false,error:{code:'platform',message:'Choose tiktok or google; Meta is covered by marketing.analyze.'}};
        return {result:JSON.stringify(report,null,2),
          meta:{platform,analysisOnly:true,modelCalls:0,currencyVerified:report.currencyVerified},
          summary:platform+' campaign report retrieved; no ad budgets changed'};
      }catch(e){return {ok:false,error:{code:'channel_report',message:e.message},summary:'Ad report unavailable — check the platform authorization'};}
    },
  }),
  def({
    name: 'marketing.plan',
    group: 'marketing',
    risk: 'read',
    desc: 'Plan affordable store marketing from the TOTAL cash budget (even 50 SEK), without ads API keys or extra LLM calls. Computes order break-even math and a concrete organic-first 7-day launch plan with real evidence checks. NEVER starts ads, invents conversions or spends money. Call this for "market my website" or "I have 50 kr" BEFORE requesting Meta Ads credentials.',
    params: {
      site: 'string: public store website URL or hostname (optional)',
      totalBudget: 'number: TOTAL maximum ad-spend budget, NOT daily (required, can be 0)',
      currency: 'string: 3-letter currency of the budget and item costs (default: configured currency or SEK)',
      product: 'object: optional {name,price,cogs,shipping,fees,refundRate,targetProfit} actual unit economics',
      trackingReady: 'boolean: whether user reports purchase tracking configured. optional (not verified)',
      reportedPastOrders: 'number: user-reported historical real orders (optional)',
      historicalCpa: 'number: user-reported past acquisition cost per buyer in SAME currency (optional)',
    },
    required: ['totalBudget'],
    async run(args, ctx) {
      try {
        const plan = microMarketingPlan(args, ctx.cfg?.get('marketing') || {});
        return { result: JSON.stringify(plan, null, 2),
          meta: { totalBudget:plan.totalBudget, currency:plan.currency, paidAdsRecommended:plan.paidAdsRecommended, analysisOnly:true },
          summary: 'Seven-day ' + plan.currency + ' ' + plan.totalBudget + ' marketing plan; no ad spend or model calls for calculation' };
      } catch (err) {
        return { ok:false, error:{ code:'marketing_plan_invalid', message:err.message } };
      }
    },
  }),
  def({
    name: 'marketing.status',
    group: 'marketing',
    risk: 'read',
    desc: 'Show whether Meta Ads marketing is connected and whether product economics are configured, without exposing any access tokens. No network calls.',
    params: {},
    async run(_args, ctx) {
      const s = marketingStatus(ctx.cfg);
      const channels = channelStatus(ctx.cfg.get('marketing') || {});
      return {
        result: JSON.stringify({meta:s,channels},null,2)+'\nFor TikTok or Google Ads, ask the user to request those channels in the chat. An authorized ad account and platform-specific credentials are required. No credentials should be pasted into the conversation.',
        meta: { connected: s.connected, mode: s.mode },
        summary: s.connected ? 'Meta account configured, read-only insights available' : 'Meta not connected',
      };
    },
  }),
  def({
    name: 'marketing.analyze',
    group: 'marketing',
    risk: 'read',
    desc: 'Fetch live last-7-day Meta Ads Insights and compute conservative, margin-aware recommendations. Reports CPA, estimated contribution, sample uncertainty and spend versus the advisory daily cap. Does not buy, pause or change any ad.',
    params: {},
    async run(_args, ctx) {
      try {
        const r = await analyzeMetaAccount(ctx.cfg);
        if (!r.ok) return { ok: false, error: { code: 'marketing_config', message: r.errors.join(' ') } };
        return {
          result: JSON.stringify(r, null, 2),
          meta: { currency: r.currency, campaigns: r.campaigns.length, analysisOnly: true },
          summary: r.campaigns.length + ' campaigns analyzed, no Meta changes made',
        };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'marketing_api', message: error.message },
          summary: 'Meta analysis unavailable — check connection and economics',
        };
      }
    },
  }),
];
