/**
 * MAJIN cross-channel ad analytics. ZERO campaign mutations, ZERO LLM calls.
 * Ad conversions != paid orders. Never treat mixed channel attribution as profit.
 * API schemas follow TikTok Business Reporting v1.3 and Google Ads REST v25.
 */
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const validNum = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Ads API returned an invalid or negative metric. Aborting analysis.');
  return n;
};
const positiveInteger = v => /^[0-9]{3,25}$/.test(String(v || ''));
const oauth = key => {
  const raw = String(key || '').trim();
  const match = /^\{env:([A-Z0-9_]+)\}$/.exec(raw);
  return match ? String(process.env[match[1]] || '').trim() : raw;
};
const requireConfig = (platform, cfg) => {
  const s = cfg?.[platform] || {};
  if (!positiveInteger(platform === 'tiktok' ? s.advertiserId : s.customerId)) {
    throw new Error(platform + ' account ID missing or invalid. Connect your own ad account first.');
  }
  if (!/^[A-Z]{3}$/.test(String(s.currency || ''))) {
    throw new Error(platform + ' account currency missing. Use the currency shown inside the ad account.');
  }
  if (!oauth(s.accessToken)) throw new Error(platform + ' OAuth/access token missing. Connect your account with an authorized token.');
  if (platform === 'google') {
    if (!oauth(s.developerToken)) throw new Error('Google Ads requires a separate developer token from Google Ads Manager, plus OAuth access.');
    if (s.loginCustomerId && !positiveInteger(s.loginCustomerId)) throw new Error('Google loginCustomerId is invalid.');
  }
  return s;
};

export function channelStatus(config) {
  return Object.fromEntries(['tiktok','google'].map(platform => {
    const settings=config?.[platform]||{};
    let connected=false;
    try { requireConfig(platform,config); connected=true; } catch { /* no credentials */ }
    return [platform,{
      configured:connected, // not a successful API handshake
      currency:settings.currency||'',
      accountId:platform==='tiktok' ? settings.advertiserId||'' : settings.customerId||'',
      mode:'read_only',
      authorization:connected?'credentials_saved_not_verified':'missing_credentials',
    }];
  }));
}

function sampleWindow(now=new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1));
  const start = new Date(end.getTime() - 6 * 86400000);
  const fmt = d => d.toISOString().slice(0,10);
  return {start:fmt(start),end:fmt(end),warning:'UTC calendar days, may differ from ad-account reporting timezone'};
}

async function safeJson(res,platform) {
  if (!res.ok) {
    const message=[401,403].includes(res.status)?'Authorization denied. Reconnect the correct read-only account credentials.':
      res.status===429?'Rate limited: try later without repeated AI retries.':
      'Ad reporting API returned HTTP '+res.status+'.';
    throw new Error(platform+': '+message);
  }
  const json=await res.json();
  if (!json || typeof json!=='object')throw new Error(platform+' returned invalid JSON.');
  return json;
}

export async function readTikTokAds(config,{transport=fetch,now=new Date(),pages=3}={}) {
  const s=requireConfig('tiktok',config);
  const window=sampleWindow(now);
  const maxPages=Math.max(1,Math.min(3,Number(pages)||3));
  const results=[];
  for(let page=1;page<=maxPages;page++){
    const url=new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
    const p=url.searchParams;
    p.set('advertiser_id',String(s.advertiserId));
    p.set('report_type','BASIC');
    p.set('data_level','AUCTION_CAMPAIGN');
    p.set('dimensions',JSON.stringify(['campaign_id']));
    p.set('metrics',JSON.stringify(['spend','clicks','impressions']));
    p.set('start_date',window.start);
    p.set('end_date',window.end);
    p.set('page',String(page));
    p.set('page_size','100');
    const res=await transport(url.toString(),{
      method:'GET',headers:{'Access-Token':oauth(s.accessToken),Accept:'application/json'},
      redirect:'error',signal:AbortSignal.timeout(20000),
    });
    const json=await safeJson(res,'TikTok Ads');
    if(json.code!==0)throw new Error('TikTok Ads reporting failed (code '+String(json.code).slice(0,20)+'). Check advertiser permissions and query compatibility.');
    const list=json.data?.list;
    if(!Array.isArray(list))throw new Error('TikTok Ads returned an invalid campaign report.');
    for(const row of list){
      const m=row.metrics||{};
      results.push({
        id:String(row.dimensions?.campaign_id||''),
        spend:validNum(m.spend),clicks:validNum(m.clicks),impressions:validNum(m.impressions),
      });
    }
    if(results.length>300)throw new Error('Too many TikTok campaigns. Refusing an incomplete or excessive report.');
    const pagesTotal=Number(json.data?.page_info?.total_page);
    if((Number.isFinite(pagesTotal)&&pagesTotal<=page)||(!Number.isFinite(pagesTotal)&&list.length<100))break;
    if(page===maxPages)throw new Error('TikTok Ads report exceeds the three-page safety limit; no partial totals reported.');
  }
  return summarize('tiktok',results,s.currency,window,{
    currencyVerified:false, note:'Account currency comes from user configuration and has NOT been independently verified by TikTok.',
  });
}

export async function readGoogleAds(config,{transport=fetch,pages=3}={}) {
  const s=requireConfig('google',config);
  const maxPages=Math.max(1,Math.min(3,Number(pages)||3));
  const url='https://googleads.googleapis.com/v25/customers/'+s.customerId+'/googleAds:search';
  const rows=[];
  let nextPageToken='';
  let actualCurrency='';
  for(let i=0;i<maxPages;i++){
    const query='SELECT campaign.id, campaign.name, customer.currency_code, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != REMOVED';
    const res=await transport(url,{
      method:'POST',
      headers:{
        Authorization:'Bearer '+oauth(s.accessToken),
        'developer-token':oauth(s.developerToken),
        ...(s.loginCustomerId?{'login-customer-id':String(s.loginCustomerId)}:{}),
        'Content-Type':'application/json',Accept:'application/json',
      },
      body:JSON.stringify({query,pageSize:100,...(nextPageToken?{pageToken:nextPageToken}:{})}),
      redirect:'error',signal:AbortSignal.timeout(20000),
    });
    const json=await safeJson(res,'Google Ads');
    if(!Array.isArray(json.results)&&json.results!==undefined)throw new Error('Google Ads returned invalid campaign data.');
    for(const row of json.results||[]){
      const c=String(row.customer?.currencyCode||'').toUpperCase();
      if(c&&actualCurrency&&c!==actualCurrency)throw new Error('Google Ads report contains mixed currencies.');
      if(c)actualCurrency=c;
      const m=row.metrics||{};
      rows.push({
        id:String(row.campaign?.id||''),name:String(row.campaign?.name||'').slice(0,140),
        spend:validNum(m.costMicros||0)/1e6,
        clicks:validNum(m.clicks||0),
        impressions:validNum(m.impressions||0),
        reportedConversions:validNum(m.conversions||0),
      });
    }
    if(rows.length>300)throw new Error('Google Ads report exceeds 300 rows; no incomplete totals reported.');
    nextPageToken=String(json.nextPageToken||'');
    if(!nextPageToken)break;
    if(i===maxPages-1)throw new Error('Google Ads results exceed the three-page limit; no partial totals reported.');
  }
  if(actualCurrency&&actualCurrency!==s.currency)throw new Error('Google Ads currency ('+actualCurrency+') does not match configured currency ('+s.currency+').');
  const r=summarize('google',rows,s.currency,{label:'LAST_7_DAYS'},{
    currencyVerified:Boolean(actualCurrency),
    note:actualCurrency?'Currency checked against Google Ads API response.':'No Google currency returned; currency not verified. Not comparable to other accounts.',
  });
  r.reportedConversions=round(rows.reduce((a,v)=>a+(v.reportedConversions||0),0));
  r.conversionWarning='Google conversion goals may include non-purchase actions. These are NOT verified WooCommerce orders or proof of profit.';
  return r;
}

function summarize(platform,rows,currency,window,detail) {
  const spend=round(rows.reduce((sum,r)=>sum+r.spend,0));
  const clicks=rows.reduce((sum,r)=>sum+r.clicks,0);
  const impressions=rows.reduce((sum,r)=>sum+r.impressions,0);
  return {
    ok:true,platform,mode:'read_only',currency,window,
    ...detail,
    totals:{spend,clicks,impressions,cpc:clicks?round(spend/clicks):null,ctrPercent:impressions?round(clicks/impressions*100):null},
    campaigns:rows.map(r=>({...r,spend:round(r.spend)})),
    verdict:'Insufficient independent sales data to declare any channel profitable.',
    protection:'READ ONLY. No ad budgets, campaigns or billing settings were changed. No extra model calls made for calculations.',
  };
}
