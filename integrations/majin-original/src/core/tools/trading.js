/**
 * Two useful capabilities, no new screens or provider settings:
 * 1) deterministic risk/quantity math, 2) opt-in real TradingAgents research.
 * Neither tool is connected to a broker or capable of placing an order.
 */
import { def } from './registry.js';
import { tradingPlan, tradingResearch } from '../trading.js';

export const tradingTools = [
  def({
    name:'trading.plan',
    group:'trading',
    risk:'read',
    desc:'For "I have $50/$100 to trade" compute a conservative hypothetical cash allocation in the stated currency. No assumed live quote, broker, or fees. Ask for the asset and missing evidence; always abstain if no ticker/price/fees. No LLM calls, network requests or real/paper trades.',
    params:{
      budget:'number: money available as trading capital, NOT an AI fee limit',
      currency:'string: USD/SEK/EUR code (default: USD)',
      symbol:'string: optional asset ticker (e.g. AAPL or BTC-USD)',
      price:'number: optional confirmed user-provided market quote (NOT fetched)',
      feePerOrder:'number: optional broker/exchange fee per order in currency',
      allowFractional:'boolean: optional, if broker supports fractional shares (default false)',
    },
    required:['budget'],
    async run(args){
      try{
        const result=tradingPlan(args);
        return {result:JSON.stringify(result,null,2),
          meta:{capitalBudget:result.budget,currency:result.currency,mode:'paper_plan_only',noOrders:true},
          summary:'Cash-risk plan '+result.budget+' '+result.currency+'; no real or paper orders submitted'};
      }catch(e){return {ok:false,error:{code:'trade_plan_invalid',message:e.message}}}
    },
  }),
  def({
    name:'trading.research',
    group:'trading',
    risk:'read',
    desc:'ONLY when user requests deep analysis on a specific stock/crypto ticker: use genuine optional installed TauricResearch/TradingAgents (Apache-2.0) with existing MAJIN tools model and market data. Bounded subprocess, one market analyst and short debate. May incur LLM/provider fees; cannot guarantee an exact token cost. Does NOT trade, create/execute orders or install Python. Ask user to select a ticker before running.',
    params:{
      symbol:'string: selected ticker, e.g. AAPL or BTC-USD (required)',
      budget:'number: the user capital in stated currency (required, not LLM cost)',
      currency:'string: code like USD (default: USD)',
      date:'string: optional historical analysis date YYYY-MM-DD, default today',
    },
    required:['symbol','budget'],
    async run(args,ctx){
      try{
        const result=await tradingResearch(args,ctx.cfg);
        if(!result.ok)return {ok:false,error:{code:'trading_bridge',message:result.error}};
        return {result:JSON.stringify(result,null,2),meta:{mode:'RESEARCH_ONLY',ordersPlaced:0},
          summary:'TradingAgents research for '+result.ticker+'; no live orders and no promised profitability'};
      }catch(e){return {ok:false,error:{code:'trading_research_invalid',message:e.message}}}
    },
  }),
];
