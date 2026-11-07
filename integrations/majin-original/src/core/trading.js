/**
 * MAJIN optional TradingAgents bridge. Research + cash-sizing ONLY:
 * no broker client, no orders, no live or paper fills, no leveraged positions.
 * Upstream TauricResearch/TradingAgents is Apache-2.0; not vendored or installed.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

const round = x => Math.round((x + Number.EPSILON) * 100) / 100;
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const SYMBOL = /^[A-Z0-9][A-Z0-9.^-]{0,24}$/;
const today = () => {
  const d=new Date();
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
};

export function tradingPlan({budget,currency='USD',symbol='',price=null,feePerOrder=null,allowFractional=false}={}) {
  if (!number(budget) || budget === 0 || budget > 100000000) throw new Error('budget must be a positive finite capital amount (not an LLM cost cap).');
  const iso=String(currency).toUpperCase();
  if(!/^[A-Z]{3}$/.test(iso))throw new Error('currency must be a three-letter ISO code');
  const ticker=String(symbol||'').trim().toUpperCase();
  if(ticker&&!SYMBOL.test(ticker))throw new Error('Ticker must be a simple exchange symbol, not a URL or shell command.');
  if(price!==null&&(!number(price)||price===0))throw new Error('price must be a positive, explicitly supplied and verified market quote');
  if(feePerOrder!==null&&!number(feePerOrder))throw new Error('feePerOrder must be nonnegative');
  if(typeof allowFractional!=='boolean')throw new Error('allowFractional must be a boolean');
  // Conservative illustration, NOT a stop order or guaranteed loss maximum.
  const maxExposure=budget*0.25, riskReserve=budget*0.01;
  const affordable=Math.max(0,Math.min(maxExposure,(riskReserve-2*(feePerOrder||0))/0.05));
  const units=price===null?0:allowFractional?Math.floor(affordable/price*1e6)/1e6:Math.floor(affordable/price);
  const notional=price===null?null:round(units*price);
  const questions=[];
  if(!ticker)questions.push('Which asset and symbol do you want to research? No ticker is chosen automatically.');
  if(price===null)questions.push('Provide a verified, current quote with timestamp. This tool has no live price feed.');
  if(feePerOrder===null)questions.push('What are the brokerage/exchange, FX and minimum-order fees?');
  if(price!==null&&units===0)questions.push('One whole share is unaffordable under the 25% allocation cap. Confirm broker fractional-share support or keep cash.');
  return {
    ok:true,mode:'HYPOTHETICAL_PLAN_ONLY',budget,currency:iso,ticker:ticker||null,
    quote:price===null?null:{value:price,source:'caller_supplied_not_independently_verified'},
    limits:{maxIllustrativePositionPercent:25,illustrativeRiskPercent:1,illustrativeStopDistancePercent:5,noLeverage:true},
    position:price===null?null:{units,allowFractional,notional,
      hypotheticalLossAtFivePercentMove:round(notional*0.05+2*(feePerOrder||0)),
      note:'Real losses can exceed stop estimates due to gaps, slippage and fees.'},
    readyForIllustration:Boolean(ticker&&price!==null&&feePerOrder!==null&&units>0),
    questions,ordersSent:0,brokerConnected:false,
    nextStep:'This is not a trade or quote. No buy/sell/paper-fill is executed. Ask for broker authorization separately for any future live feature.',
    warning:'Trading can lose all capital; this is not proven profitable. Investment capital and AI-provider charges are different costs.',
    modelCalls:0,networkCalls:0,
  };
}

// Self-contained embedded Python: bundled MAJIN EXE does NOT require Python.
// When a user opts into research, the external Python 3.11+ TradingAgents
// package must already be installed; missing dependencies fail gracefully.
export const PYTHON_BRIDGE = [
  'import sys, json, os, tempfile, contextlib',
  'def reply(x): print(json.dumps(x, ensure_ascii=True, default=str), flush=True)',
  'try:',
  ' from tradingagents.default_config import DEFAULT_CONFIG',
  ' from tradingagents.graph.trading_graph import TradingAgentsGraph',
  'except ImportError:',
  ' reply({"ok":False,"code":"not_installed"})',
  ' sys.exit(0)',
  'try:',
  ' ticker, day, asset = sys.argv[1:4]',
  ' with tempfile.TemporaryDirectory(prefix="majin-ta-") as folder:',
  '  cfg=DEFAULT_CONFIG.copy()',
  '  cfg["llm_provider"]=os.environ["MAJIN_TA_PROVIDER"]',
  '  cfg["quick_think_llm"]=os.environ["MAJIN_TA_MODEL"]',
  '  cfg["deep_think_llm"]=os.environ["MAJIN_TA_MODEL"]',
  '  if os.environ.get("MAJIN_TA_BACKEND"): cfg["backend_url"]=os.environ["MAJIN_TA_BACKEND"]',
  '  cfg["max_debate_rounds"]=1',
  '  cfg["max_risk_discuss_rounds"]=1',
  '  cfg["max_tool_rounds"]=2',
  '  cfg["max_recur_limit"]=50',
  '  cfg["max_tokens"]=700',
  '  cfg["llm_max_retries"]=0',
  '  cfg["checkpoint_enabled"]=False',
  '  cfg["data_cache_dir"]=os.path.join(folder,"cache")',
  '  cfg["results_dir"]=os.path.join(folder,"results")',
  '  cfg["memory_log_path"]=os.path.join(folder,"memory.md")',
  '  with open(os.devnull,"w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):',
  '   graph=TradingAgentsGraph(selected_analysts=("market",),debug=False,config=cfg)',
  '   state,signal=graph.propagate(ticker,day,asset_type=asset)',
  '  reply({"ok":True,"decision":str(signal)[:200],"analysts":["market"]})',
  'except Exception:',
  ' reply({"ok":False,"code":"upstream_failure"})',
].join('\n');

const providers={
  openai:['openai','OPENAI_API_KEY'],
  deepseek:['deepseek','DEEPSEEK_API_KEY'],
  openrouter:['openrouter','OPENROUTER_API_KEY'],
  anthropic:['anthropic','ANTHROPIC_API_KEY'],
  google:['google','GOOGLE_API_KEY'],
  gemini:['google','GOOGLE_API_KEY'],
  ollama:['ollama',null],
};
const getKey=key=>{
  const v=String(key||'');
  const m=/^\{env:([A-Z0-9_]+)\}$/.exec(v);
  return m?String(process.env[m[1]]||''):v;
};
export function researchProvider(cfg){
  const selected=cfg?.resolveModel?.(null,'tools');
  if(!selected||selected.kind==='mock'||selected.providerName==='demo')
    throw new Error('Select a real AI model in MAJIN first. Demo cannot run TradingAgents.');
  const name=selected.providerName.toLowerCase();
  const p=providers[name]||(selected.kind==='openai'&&selected.baseUrl?['openai_compatible','OPENAI_COMPATIBLE_API_KEY']:null);
  if(!p)throw new Error('Selected MAJIN provider is not supported by TradingAgents. Choose a supported provider.');
  const key=getKey(selected.apiKey);
  if(!key&&p[1])throw new Error('Selected MAJIN provider needs its API key; there is no silent paid-model fallback.');
  const base=p[0]==='openai_compatible'?String(selected.baseUrl||''):null;
  if(base&&!/^https?:\/\/\S+$/i.test(base))throw new Error('Invalid custom provider backend URL.');
  return {name:p[0],envName:p[1],model:selected.model,key,base};
}

/** Calls upstream with a strict wall timeout and bounded response. */
export async function tradingResearch({budget,currency='USD',symbol,date=''}={},cfg,{spawnImpl=spawn,timeoutMs=90_000}={}){
  const plan=tradingPlan({budget,currency,symbol});
  const ticker=String(symbol||'').trim().toUpperCase();
  if(!ticker||!SYMBOL.test(ticker))throw new Error('Ask the user which ticker to research. Capital alone does not identify an investment.');
  const day=String(date||today());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||day>today())throw new Error('Choose a valid, non-future analysis date.');
  const chosen=researchProvider(cfg);
  const python=process.env.MAJIN_TRADING_PYTHON||(process.platform==='win32'?'python':'python3');
  // The QA bridge uses a REAL spawned Node process as a portable fixture.
  // Windows cannot execute a Unix shebang-only "fake-python" file. This
  // explicit test-only flag cannot activate during ordinary user workflows.
  const qaNodeBridge=process.env.MAJIN_TRADING_QA_STUB==='1' && /\.m?js$/i.test(python);
  const crypto=/^(BTC|ETH|SOL|DOGE|XRP|ADA|LTC|AVAX)-USD$/.test(ticker);
  const keys=['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','SYSTEMROOT','SystemRoot','WINDIR','SSL_CERT_FILE','REQUESTS_CA_BUNDLE','VIRTUAL_ENV'];
  const env=Object.fromEntries(keys.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',TRADINGAGENTS_NO_UPDATE_CHECK:'1',MAJIN_TA_PROVIDER:chosen.name,MAJIN_TA_MODEL:chosen.model});
  if(chosen.base)env.MAJIN_TA_BACKEND=chosen.base;
  if(chosen.envName)env[chosen.envName]=chosen.key;
  return new Promise(resolve=>{
    let finished=false,output='',timedOut=false,overflow=false,child;
    let timer;
    const done=r=>{if(finished)return;finished=true;clearTimeout(timer);resolve(r)};
    try{child=spawnImpl(qaNodeBridge?process.execPath:python,
      qaNodeBridge?[python]:['-E','-c',PYTHON_BRIDGE,ticker,day,crypto?'crypto':'stock'],
      {env,cwd:os.tmpdir(),stdio:['ignore','pipe','pipe'],windowsHide:true});}
    catch{return done({ok:false,error:'Python 3.11+ interpreter unavailable. Install the optional TradingAgents package only if desired.'})}
    timer=setTimeout(()=>{timedOut=true;child.kill?.('SIGKILL')},Math.min(120_000,Math.max(1000,timeoutMs)));
    timer.unref?.();
    child.stdout?.on('data',chunk=>{
      output+=String(chunk);
      if(output.length>12000){overflow=true;child.kill?.('SIGKILL')}
    });
    // Suppress all 3rd-party stderr to avoid echoing tokens or raw API requests.
    child.stderr?.on('data',()=>{});
    child.on('error',()=>done({ok:false,error:'Python was not found. TradingAgents is optional and never auto-installed.'}));
    child.on('close',code=>{
      if(timedOut)return done({ok:false,error:'TradingAgents analysis timed out; no trade was made.'});
      if(overflow)return done({ok:false,error:'Research output too large; incomplete report refused.'});
      let result;
      try{result=JSON.parse(output.trim())}catch{return done({ok:false,error:'TradingAgents did not return a valid result. No trading occurred.'})}
      if(result.code==='not_installed')return done({ok:false,error:'Optional TradingAgents not installed in the selected Python. With Python 3.11+, run: python -m pip install tradingagents. No automatic installation or provider spending.'});
      if(code!==0||!result.ok)return done({ok:false,error:'TradingAgents research failed. Check model/provider compatibility and data access. No trading occurred.'});
      return done({ok:true,source:'TauricResearch/TradingAgents',analysisDate:day,ticker,assetType:crypto?'crypto':'stock',
        decision:String(result.decision||'').slice(0,200),analysts:result.analysts||['market'],
        budget:plan.budget,currency:plan.currency,mode:'RESEARCH_ONLY',ordersPlaced:0,brokerConnected:false,
        warnings:['LLM-based research is not proven profitable.','Selected AI provider and upstream data calls may be billed separately from the investment budget.','No independently verified live quote, fills or fees are included.','Live order execution is disabled.'],
      });
    });
  });
}
