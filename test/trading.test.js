import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tradingPlan, tradingResearch, researchProvider, PYTHON_BRIDGE } from '../src/core/trading.js';
import { tradingTools } from '../src/core/tools/trading.js';
import { ALL_TOOLS } from '../src/core/tools/index.js';

const fakeConfig=(name='deepseek',model='deepseek-flash')=>({
  resolveModel:()=>({kind:'openai',providerName:name,model,
    baseUrl:'https://api.deepseek.com',apiKey:'dont-print-provider-key'}),
});
function childWithResult(payload,record) {
  return (cmd,args,opts)=>{
    if(record) Object.assign(record,{cmd,args,opts});
    const ch=new EventEmitter();
    ch.stdout=new PassThrough();ch.stderr=new PassThrough();
    ch.kill=()=>ch.emit('close',1);
    process.nextTick(()=>{
      ch.stdout.write(JSON.stringify(payload));
      ch.stdout.end();
      ch.emit('close',0);
    });
    return ch;
  };
}

test('$50 with no symbol/market quote asks useful questions and executes NO order',()=>{
  const p=tradingPlan({budget:50});
  assert.equal(p.ok,true);
  assert.equal(p.mode,'HYPOTHETICAL_PLAN_ONLY');
  assert.equal(p.position,null);
  assert.equal(p.ordersSent,0);
  assert.equal(p.modelCalls,0);
  assert.equal(p.networkCalls,0);
  assert.equal(p.questions.length,3);
  assert.match(p.nextStep,/not a trade/i);
});

test('$100 or $50 position sizing is cautious; no leverage and no fills',()=>{
  const p=tradingPlan({budget:50,currency:'USD',symbol:'AAPL',price:2,feePerOrder:0});
  assert.equal(p.position.units,5);
  assert.equal(p.position.notional,10);
  assert.equal(p.position.hypotheticalLossAtFivePercentMove,0.5);
  assert.equal(p.brokerConnected,false);
  assert.equal(p.ordersSent,0);
  assert.equal(p.limits.noLeverage,true);
  const highPrice=tradingPlan({budget:50,symbol:'AAPL',price:300,feePerOrder:0});
  assert.equal(highPrice.position.units,0);
  assert.equal(highPrice.readyForIllustration,false);
  const fractional=tradingPlan({budget:100,symbol:'AAPL',price:300,feePerOrder:0,allowFractional:true});
  assert.ok(fractional.position.units>0);
  assert.ok(fractional.position.notional<=25);
});

test('currency, ticker injection, negative fees, impossible price/date are all rejected',async()=>{
  for(const bad of [0,-1,NaN,Infinity])assert.throws(()=>tradingPlan({budget:bad}),/budget/);
  assert.throws(()=>tradingPlan({budget:50,symbol:'$(touch /tmp/pwn)'}),/Ticker/);
  assert.throws(()=>tradingPlan({budget:50,price:0}),/price/);
  assert.throws(()=>tradingPlan({budget:50,feePerOrder:-1}),/feePerOrder/);
  assert.throws(()=>tradingPlan({budget:50,currency:'DOLLAR'}),/currency/);
  await assert.rejects(tradingResearch({budget:50,symbol:'AAPL',date:'2026-02-31'},fakeConfig()),/date/);
  await assert.rejects(tradingResearch({budget:50,symbol:'AAPL',date:'2099-01-01'},fakeConfig()),/date/);
  await assert.rejects(tradingResearch({budget:50,symbol:''},fakeConfig()),/ticker/);
});

test('no paid model silently selected; MAJIN selected provider is reused via env',async()=>{
  assert.throws(()=>researchProvider({resolveModel:()=>({kind:'mock',providerName:'demo'})}),/real AI model/);
  const cfg=fakeConfig();
  const p=researchProvider(cfg);
  assert.equal(p.name,'deepseek');
  assert.equal(p.model,'deepseek-flash');
  assert.equal(p.envName,'DEEPSEEK_API_KEY');
  assert.equal(p.key,'dont-print-provider-key');
  const rec={};
  const r=await tradingResearch({budget:100,symbol:'BTC-USD',date:'2026-09-09'},cfg,{
    spawnImpl:childWithResult({ok:true,decision:'Hold',analysts:['market']},rec)});
  assert.equal(r.ok,true);
  assert.equal(r.ordersPlaced,0);
  assert.equal(r.mode,'RESEARCH_ONLY');
  assert.equal(r.assetType,'crypto');
  assert.equal(rec.opts.env.DEEPSEEK_API_KEY,'dont-print-provider-key');
  assert.equal(rec.opts.env.MAJIN_TA_MODEL,'deepseek-flash');
  assert.equal(rec.opts.env.MAJIN_TA_PROVIDER,'deepseek');
  assert.ok(!JSON.stringify(r).includes('dont-print-provider-key'));
  assert.equal(rec.args[0],'-E');
  assert.equal(rec.args[1],'-c');
  assert.equal(rec.args[3],'BTC-USD');
  assert.ok(!rec.args.includes('dont-print-provider-key'));
  assert.ok(!rec.opts.env.OPENAI_API_KEY,'other-provider key must not be inherited');
});

test('genuine upstream TradingAgents graph is used; no mocked investment signal disguised',()=>{
  assert.match(PYTHON_BRIDGE,/from tradingagents.graph.trading_graph import TradingAgentsGraph/);
  assert.match(PYTHON_BRIDGE,/graph.propagate/);
  assert.match(PYTHON_BRIDGE,/max_tool_rounds/);
  assert.match(PYTHON_BRIDGE,/TemporaryDirectory/);
  assert.doesNotMatch(PYTHON_BRIDGE,/alpaca|binance|create_order|submit_order/i);
});

test('upstream absent or error fails closed and never asks for broker credentials',async()=>{
  const args={symbol:'AAPL',budget:50},cfg=fakeConfig();
  const missing=await tradingResearch(args,cfg,{spawnImpl:childWithResult({ok:false,code:'not_installed'})});
  assert.equal(missing.ok,false);
  assert.match(missing.error,/not installed/);
  assert.match(missing.error,/python -m pip install tradingagents/);
  const broken=await tradingResearch(args,cfg,{spawnImpl:childWithResult({ok:false,code:'upstream_failure'})});
  assert.equal(broken.ok,false);
  assert.match(broken.error,/failed/);
});

test('tools are live registered, valid read-only schemas and never place real trades',async()=>{
  const got=ALL_TOOLS.filter(t=>t.group==='trading');
  assert.deepEqual(got.map(t=>t.name).sort(),['trading.plan','trading.research']);
  assert.ok(got.every(t=>t.risk==='read'));
  const p=await tradingTools.find(t=>t.name==='trading.plan').run({budget:50,currency:'USD'});
  assert.equal(JSON.parse(p.result).ordersSent,0);
  const failure=await tradingTools.find(t=>t.name==='trading.research').run({budget:100,symbol:'none/invalid'},{cfg:fakeConfig()});
  assert.equal(failure.ok,false);
});
