import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readTikTokAds,readGoogleAds,channelStatus} from '../src/core/marketing-channels.js';
import {Config,DEFAULTS,clone} from '../src/core/config.js';
import {marketingTools} from '../src/core/tools/marketing.js';

const config=()=>({
  tiktok:{advertiserId:'7123456789',currency:'SEK',accessToken:'private-tiktok-token'},
  google:{customerId:'1234567890',currency:'USD',accessToken:'private-google-oauth',developerToken:'private-developer-token',loginCustomerId:'9876543210'},
});
test('platform status tracks credentials but never falsely claims Meta API auth passed',()=>{
 const state=channelStatus(config());
 assert.equal(state.tiktok.configured,true);
 assert.equal(state.google.configured,true);
 assert.equal(state.google.authorization,'credentials_saved_not_verified');
 assert.ok(!JSON.stringify(state).includes('private-google-oauth'));
});

test('TikTok report uses official read-only reporting endpoint, exact fixed host, header token, bounded pages',async()=>{
 const urls=[];const headers=[];
 const transport=async(url,opts)=>{
  urls.push(url);headers.push(opts.headers);
  assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');
  assert.equal(opts.headers['Access-Token'],'private-tiktok-token');
  assert.ok(!url.includes('private-tiktok-token'));
  return {ok:true,json:async()=>({code:0,data:{list:[{dimensions:{campaign_id:'100'},
    metrics:{spend:'20.50',clicks:'40',impressions:'1000'}}],
    page_info:{total_page:1}}})};
 };
 const out=await readTikTokAds(config(),{transport,now:new Date('2026-10-18T05:00:00Z')});
 assert.equal(out.ok,true);assert.equal(out.mode,'read_only');
 assert.equal(out.currency,'SEK');
 assert.equal(out.currencyVerified,false);
 assert.equal(out.totals.spend,20.5);
 assert.equal(out.totals.cpc,0.51);
 assert.equal(urls.length,1);
 assert.match(urls[0],/^https:\/\/business-api\.tiktok\.com\/open_api\/v1\.3\/report\/integrated\/get\//);
 assert.equal(new URL(urls[0]).searchParams.get('start_date'),'2026-10-11');
 assert.equal(new URL(urls[0]).searchParams.get('end_date'),'2026-10-17');
 assert.equal(out.campaigns[0].id,'100');
 assert.match(out.verdict,/Insufficient independent sales data/);
});

test('TikTok invalid API code or excessive paging fails closed with zero made-up partial ROI',async()=>{
 await assert.rejects(readTikTokAds(config(),{transport:async()=>({ok:true,json:async()=>({code:40101,message:'secret',data:{list:[]}})})}),/reporting failed/);
 const pages=[];
 await assert.rejects(readTikTokAds(config(),{transport:async(url)=>{
  pages.push(url);return {ok:true,json:async()=>({code:0,data:{list:[{dimensions:{campaign_id:'42'},metrics:{spend:5,clicks:2,impressions:4}}],page_info:{total_page:4}}})};
 }}),/three-page/);
 assert.equal(pages.length,3);
});

test('Google Ads uses official v25 REST endpoint, correct headers, micro-cost and currency',async()=>{
 const calls=[];const transport=async(url,opts)=>{
  calls.push({url,opts});
  return {ok:true,json:async()=>({results:[
    {campaign:{id:'100',name:'Brand'},customer:{currencyCode:'USD'},metrics:{costMicros:'12340000',clicks:'100',impressions:'2000',conversions:'4.5'}},
  ]})};
 };
 const r=await readGoogleAds(config(),{transport});
 assert.equal(r.ok,true);assert.equal(r.totals.spend,12.34);
 assert.equal(r.totals.cpc,0.12);
 assert.equal(r.totals.ctrPercent,5);
 assert.equal(r.reportedConversions,4.5);
 assert.match(r.conversionWarning,/NOT verified WooCommerce orders/);
 assert.equal(r.currencyVerified,true);
 assert.equal(calls[0].url,'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
 assert.equal(calls[0].opts.method,'POST');
 assert.equal(calls[0].opts.headers.Authorization,'Bearer private-google-oauth');
 assert.equal(calls[0].opts.headers['developer-token'],'private-developer-token');
 assert.equal(calls[0].opts.headers['login-customer-id'],'9876543210');
 const body=JSON.parse(calls[0].opts.body);
 assert.match(body.query,/segments\.date DURING LAST_7_DAYS/);
 assert.match(body.query,/customer\.currency_code/);
 assert.ok(!JSON.stringify(body).includes('private-google-oauth'));
});

test('Google Ads blocks currency mismatch, bad tokens, malformed metrics and API 403',async()=>{
 const cfg=config();
 const mock=async()=>({ok:true,json:async()=>({results:[{customer:{currencyCode:'EUR'},metrics:{costMicros:'1000000'}}]})});
 await assert.rejects(readGoogleAds(cfg,{transport:mock}),/does not match/);
 const fail=async()=>({ok:false,status:403});
 await assert.rejects(readGoogleAds(cfg,{transport:fail}),/Authorization denied/);
 await assert.rejects(readGoogleAds(cfg,{transport:async()=>({ok:true,json:async()=>({results:[{metrics:{costMicros:'-50'}}]})})}),/negative metric/);
 cfg.google.developerToken='';
 await assert.rejects(readGoogleAds(cfg,{transport:mock}),/developer token/);
});

test('marketing.report is a real, guarded tool with no ad mutation access',async()=>{
 const t=marketingTools.find(t=>t.name==='marketing.channel_report');
 assert.ok(t);
 assert.equal(t.risk,'read');
 assert.match(t.desc,/READ ONLY/);
 const result=await t.run({platform:'pinterest'},{cfg:{get:()=>config()}});
 assert.equal(result.ok,false);
 assert.match(result.error.message,/Choose tiktok or google/);
});

test('Google and TikTok secrets are redacted from API-visible config',(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'majin-channel-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cfg=new Config(clone(DEFAULTS),path.join(dir,'config.json'));
 const c=config();
 const saved=cfg.patch({marketing:{tiktok:c.tiktok,google:c.google}}, {dry:false});
 assert.equal(saved.ok,true);
 const redacted=JSON.stringify(cfg.redacted());
 for(const secret of ['private-tiktok-token','private-google-oauth','private-developer-token'])assert.ok(!redacted.includes(secret));
 assert.equal(cfg.get('marketing.google.customerId'),'1234567890');
});
