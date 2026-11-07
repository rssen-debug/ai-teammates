import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microMarketingPlan } from '../src/core/marketing-plan.js';
import { marketingTools } from '../src/core/tools/marketing.js';

test('50 SEK: defaults to organic marketing without inventing a profitable Meta campaign', () => {
  const p = microMarketingPlan({
    site:'wearmeoften.com', totalBudget:50, currency:'SEK',
    product:{name:'Bracelet',price:345,cogs:130,shipping:20,fees:12,refundRate:0.05,targetProfit:35},
  });
  assert.equal(p.ok,true);
  assert.equal(p.mode,'organic_first');
  assert.equal(p.totalBudget,50);
  assert.equal(p.proposedPaidTest,0);
  assert.equal(p.reservedBudget,50);
  assert.equal(p.economics.minOrdersToRecoverFullBudget,1);
  assert.equal(p.safeguards.neverAutoSpend,true);
  assert.equal(p.sevenDayPlan.length,7);
  assert.ok(p.sevenDayPlan.every(x=>x.cost===0));
  assert.match(p.disclaimer,/not advertising execution/);
  assert.equal(p.modelCalls,0);
});

test('a 50 SEK task without store economics is still actionable and honestly asks for costs', () => {
  const p = microMarketingPlan({ totalBudget:50, currency:'SEK' });
  assert.equal(p.ok,true);
  assert.equal(p.economics,null);
  assert.equal(p.mode,'organic_first');
  assert.equal(p.nextQuestions.length,3);
  assert.ok(p.nextQuestions.some(x=>x.includes('sale price')));
  assert.equal(p.sevenDayPlan.length,7);
});

test('reusing configured economics is possible only with the matching ad currency', () => {
  const settings = { meta:{currency:'USD'},economics:{price:50,cogs:15,shipping:5,fees:2,refundRate:0.05,targetProfit:6} };
  const usd = microMarketingPlan({totalBudget:50,currency:'USD'},settings);
  assert.equal(usd.economics.contributionPerOrder,25.5);
  const sek = microMarketingPlan({totalBudget:50,currency:'SEK'},settings);
  assert.equal(sek.economics,null, 'never compare USD item costs with SEK budget');
});

test('spending is a suggestion only after reported proof + budget for three target CPA purchases',()=>{
  const p=microMarketingPlan({
    totalBudget:100,currency:'USD',trackingReady:true,
    reportedPastOrders:6,historicalCpa:10,
    product:{price:50,cogs:15,shipping:5,fees:2,refundRate:0.05,targetProfit:6},
  });
  assert.equal(p.mode,'small_paid_test_candidate');
  assert.equal(p.proposedPaidTest,58.5);
  assert.equal(p.reservedBudget,41.5);
  assert.equal(p.safeguards.requireUserApproval,true);
  assert.match(p.safeguards.dataConfidence,/NOT been independently reconciled/);
  assert.ok(!p.sevenDayPlan.some(d=>d.cost>0),'even paid-test candidate is not execution');
});

test('weak prior CPA or no tracking cannot trigger paid marketing',()=>{
  const base={totalBudget:200,currency:'USD',trackingReady:true,reportedPastOrders:6,historicalCpa:40,
    product:{price:50,cogs:15,shipping:5,fees:2,refundRate:0.05,targetProfit:6}};
  assert.equal(microMarketingPlan(base).paidAdsRecommended,false);
  assert.equal(microMarketingPlan({...base,historicalCpa:10,trackingReady:false}).paidAdsRecommended,false);
  assert.equal(microMarketingPlan({...base,historicalCpa:10,reportedPastOrders:1}).paidAdsRecommended,false);
});

test('invalid inputs reject NaN, negative budgets and invalid fractions',()=>{
  for(const budget of [-1,NaN,Infinity,1000001])assert.throws(()=>microMarketingPlan({totalBudget:budget}),/totalBudget/);
  assert.throws(()=>microMarketingPlan({totalBudget:50,currency:'SEK',product:{price:100,refundRate:1.5}}),/refundRate/);
  assert.throws(()=>microMarketingPlan({totalBudget:50,reportedPastOrders:0.5}),/reportedPastOrders/);
  assert.throws(()=>microMarketingPlan({totalBudget:50,site:'http://localhost:8080'}),/public website/);
});

test('marketing.plan is an actual registered, free-to-calculate read-only tool',async()=>{
  const planner=marketingTools.find(t=>t.name==='marketing.plan');
  assert.ok(planner);
  assert.equal(planner.risk,'read');
  const fakeCfg={get:()=>({})};
  const result=await planner.run({site:'wearmeoften.com',totalBudget:50,currency:'SEK'}, {cfg:fakeCfg});
  const plan=JSON.parse(result.result);
  assert.equal(plan.modelCalls,0);
  assert.equal(plan.totalBudget,50);
  assert.equal(result.meta.analysisOnly,true);
  const bad=await planner.run({totalBudget:-12},{cfg:fakeCfg});
  assert.equal(bad.ok,false);
});
