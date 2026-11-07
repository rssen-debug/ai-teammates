import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeMarketing, contributionEconomics, fetchMetaInsights, marketingStatus,
  analyzeMetaAccount, checkMarketingConfig, purchaseCount,
} from '../src/core/marketing.js';
import { Config, DEFAULTS, clone } from '../src/core/config.js';
import { ALL_TOOLS } from '../src/core/tools/index.js';

function settings() {
  return {
    meta: { accountId: 'act_123456789', currency: 'USD', accessToken: 'private-test-token' },
    economics: { price: 50, cogs: 15, shipping: 5, fees: 2, refundRate: 0.05, targetProfit: 6, dailyCap: 15 },
  };
}
function campaign({ id = '100', spend = 120, purchases = 10, currency = 'USD' } = {}) {
  return {
    campaign_id: id, campaign_name: 'Creative ' + id, account_currency: currency,
    spend: String(spend), actions: [
      { action_type: 'omni_purchase', value: String(purchases) },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases + 3) },
    ],
  };
}

test('profit math uses actual costs, refund assumptions and cash reserve', () => {
  const e = contributionEconomics(settings().economics);
  assert.deepEqual(e, { contributionPerOrder: 25.5, breakEvenCpa: 25.5, targetCpa: 19.5, targetProfit: 6 });
  assert.equal(purchaseCount(campaign().actions), 10, 'never sum multiple Meta attribution events');
});

test('small sample cannot become a made-up profit winner or auto-spend', () => {
  const r = analyzeMarketing([campaign({ spend: 15, purchases: 2 })], settings());
  assert.equal(r.ok, true);
  assert.equal(r.campaigns[0].decision, 'collect_data');
  assert.equal(r.campaigns[0].proposedChangePct, 0);
  assert.match(r.safety, /Read-only/);
  assert.match(r.attribution, /NOT independently verified/);
});

test('large strong attributed campaign only proposes a capped 10% test', () => {
  const r = analyzeMarketing([campaign({ spend: 100, purchases: 20 })], settings());
  assert.equal(r.campaigns[0].decision, 'scale_candidate');
  assert.equal(r.campaigns[0].proposedChangePct, 10);
  assert.equal(r.campaigns[0].estimatedContribution, 410);
});

test('zero conversions and waste prompt investigation, not automatic account edits', () => {
  const r = analyzeMarketing([campaign({ spend: 60, purchases: 0 })], settings());
  assert.equal(r.campaigns[0].decision, 'review_tracking_or_pause');
  assert.equal(r.campaigns[0].proposedChangePct, 0);
});

test('currency mismatch and bad margin refuse unsafe optimization', () => {
  assert.equal(analyzeMarketing([campaign({currency:'SEK'})], settings()).ok, false);
  const bad = settings();
  bad.economics.cogs = 999;
  assert.ok(checkMarketingConfig(bad).length);
  assert.equal(analyzeMarketing([campaign()], bad).ok, false);
});

test('advisory limit is clearly NOT a real Meta budget limiter', () => {
  const r = analyzeMarketing([campaign({ spend: 120 })], settings());
  assert.equal(r.totals.overAdvisoryCap, true);
  assert.match(r.safety, /not an enforced Meta Ads spending limit/);
});

test('Meta live transport reads a bounded campaign report with a bearer header, no token in URL', async () => {
  const s = settings();
  const urls = [];
  const transport = async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer private-test-token');
    assert.ok(!url.includes('private-test-token'));
    assert.ok(url.includes('graph.facebook.com/v23.0/act_123456789/insights'));
    assert.equal(new URL(url).searchParams.get('date_preset'), 'last_7d');
    return { ok:true, json:async()=> urls.length === 1
      ? { data:[campaign()], paging:{ next:'https://graph.facebook.com/v23.0/fake', cursors:{ after:'page2' } } }
      : { data:[campaign({ id:'200', spend:10 })] } };
  };
  const rows = await fetchMetaInsights(s, { transport });
  assert.equal(rows.length, 2);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get('after'), 'page2');
});

test('bad/expired Meta token yields no secret echoed in error', async () => {
  const s = settings();
  await assert.rejects(fetchMetaInsights(s, { transport: async()=>({ ok:false,status:401 }) }), (err) => {
    assert.match(err.message, /Meta rejected/);
    assert.ok(!err.message.includes('private-test-token'));
    return true;
  });
});

test('local config supports redaction; marketing tools are present, read-only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-marketing-'));
  t.after(()=>fs.rmSync(dir, {recursive:true,force:true}));
  const cfg = new Config(clone(DEFAULTS), path.join(dir, 'config.json'));
  const s = settings();
  const r = cfg.patch({ marketing:s });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!JSON.stringify(cfg.redacted()).includes('private-test-token'));
  assert.ok(marketingStatus(cfg).connected);
  const names = ALL_TOOLS.filter((x)=>x.group==='marketing');
  assert.deepEqual(names.map((x)=>x.name).sort(), ['marketing.analyze','marketing.channel_report','marketing.plan','marketing.status']);
  assert.ok(names.every((x)=>x.risk==='read'));
  const status = await names.find((x)=>x.name==='marketing.status').run({}, {cfg});
  assert.ok(!status.result.includes('private-test-token'));
  const analyzed = await analyzeMetaAccount(cfg, {transport:async()=>({ok:true,json:async()=>({data:[campaign()]})})});
  assert.equal(analyzed.ok,true);
});

test('malformed configuration fields are rejected by Config validator', () => {
  const c = new Config(clone(DEFAULTS));
  assert.equal(c.patch({marketing:{economics:{refundRate:2}}}, {dry:true}).ok,false);
  assert.equal(c.patch({marketing:{secretSink:'oops'}}, {dry:true}).ok,false);
});
