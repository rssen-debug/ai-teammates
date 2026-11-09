// Omega tab automation: chrome.scripting works in existing background tabs.
// Never activate a tab or window; no native mouse or keyboard injection.
"use strict";
const ENDPOINT = "ws://127.0.0.1:18783";
let socket = null;
let retryTimer = null;

function visibleNodes() {
  const nodes = [...document.querySelectorAll(
    'button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]'
  )];
  const selector = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    let node = el, parts = [];
    for (let i=0; node && i<8; i++, node=node.parentElement) {
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter(e=>e.tagName===node.tagName) : [node];
      let segment = node.tagName.toLowerCase();
      if (same.length>1) segment += ':nth-of-type('+(same.indexOf(node)+1)+')';
      parts.unshift(segment);
      if (node.id) {parts[0]='#'+CSS.escape(node.id);break;}
    }
    return parts.join(' > ');
  };
  return nodes.filter(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';
  }).slice(0,70).map(el=>({
    selector:selector(el),tag:el.tagName.toLowerCase(),
    label:(el.getAttribute('aria-label')||el.getAttribute('placeholder')||
      el.innerText||el.getAttribute('title')||'').trim().slice(0,110),
    role:el.getAttribute('role')||'',type:el.getAttribute('type')||'',
    checked:el.matches('[role="checkbox"],input[type="checkbox"]') ?
      (el.checked===true||el.getAttribute('aria-checked')==='true'):null
  }));
}
function readTab(selector) {
  const el=document.querySelector(selector||'body');
  if(!el) throw Error("Selector not found");
  return {url:location.href,text:(el.innerText||el.value||'').slice(0,12000)};
}
function clickTab(selector) {
  if(!selector||selector.length>400) throw Error("Invalid selector");
  const el=document.querySelector(selector);
  if(!el) throw Error("Selector not found");
  if(el.matches('input[type="submit"],button[type="submit"]')) {
    throw Error("Form submission is not available through this quick click.");
  }
  const before=el.matches('input[type="checkbox"],[role="checkbox"]')?
    (el.checked===true||el.getAttribute('aria-checked')==='true'):null;
  el.click(); // DOM dispatch, NOT Windows mouse.
  return {clicked:true,selector,before,after:before===null?null:
    (el.checked===true||el.getAttribute('aria-checked')==='true')};
}
function clickMany(selectors) {
  if(!Array.isArray(selectors)||selectors.length<1||selectors.length>5) throw Error("Choose 1-5 selectors");
  const elements=selectors.map(selector=>{
    if(typeof selector!=='string'||selector.length>400) throw Error("Invalid selector");
    const el=document.querySelector(selector);
    if(!el) throw Error("Selector not found: "+selector);
    if(el.matches('input[type="submit"],button[type="submit"]')) throw Error("Submitting forms is blocked");
    return el;
  });
  // Preflight ALL selectors before changing anything.
  return elements.map((el,i)=>{
    const before=el.matches('input[type="checkbox"],[role="checkbox"],input[type="radio"]') ?
      (el.checked===true||el.getAttribute('aria-checked')==='true'):null;
    el.click();
    const after=before===null?null:
      (el.checked===true||el.getAttribute('aria-checked')==='true');
    return {selector:selectors[i],clicked:true,before,after};
  });
}
function typeTab(selector,value) {
  if(!selector||selector.length>400||typeof value!=='string'||value.length>4000)
    throw Error("Invalid input");
  const el=document.querySelector(selector);
  if(!el) throw Error("Selector not found");
  if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement) {
    const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  } else if(el.isContentEditable) {
    el.textContent=value;
    el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
  } else throw Error("Target is not an input");
  return {written:true,readback:(el.value??el.innerText??'').slice(0,4000)};
}
async function handleTask(task) {
  const {action,args={}}=task;
  if(action==='tabs') {
    const tabs=await chrome.tabs.query({});
    return {tabs:tabs.filter(t=>/^https?:\/\//i.test(t.url||'')).map(t=>({
      id:t.id,title:(t.title||'').slice(0,150),url:(t.url||'').slice(0,500),
      windowId:t.windowId,active:t.active
    }))};
  }
  if(!Number.isInteger(args.tab_id)) throw Error("Specify exact tab_id from background_tabs");
  const tab=await chrome.tabs.get(args.tab_id);
  if(!/^https?:\/\//i.test(tab.url||'')) throw Error("Only http/https tabs supported");
  const func={elements:visibleNodes,text:readTab,click:clickTab,click_many:clickMany,type:typeTab}[action];
  if(!func) throw Error("Unsupported action");
  const callArgs=action==='text'?[args.selector||'body']:
    action==='elements'?[]:
    action==='click'?[args.selector]:
    action==='click_many'?[args.selectors]:[args.selector,args.text];
  const results=await chrome.scripting.executeScript({
    target:{tabId:tab.id},world:"ISOLATED",func,args:callArgs
  });
  if(!results?.length) throw Error("Tab script returned no result");
  return {tab_id:tab.id,tab_title:(tab.title||'').slice(0,120),
    result:results[0].result};
}
function scheduleRetry() {
  if(retryTimer) clearTimeout(retryTimer);
  retryTimer=setTimeout(connect,3000);
}
async function connect() {
  if(socket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(socket.readyState)) return;
  const saved=await chrome.storage.local.get(['pairing']);
  if(!saved.pairing) return;
  const ws=new WebSocket(ENDPOINT);
  socket=ws;
  let heartbeat = null;
  ws.onopen=()=>{
    ws.send(JSON.stringify({type:'hello',token:saved.pairing}));
    // Chrome MV3 can suspend idle service workers. Keep a small local
    // WebSocket heartbeat (<30 seconds) during pairing, not network polling.
    heartbeat=setInterval(()=>{
      if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'heartbeat'}));
    },20000);
  };
  ws.onmessage=async (event)=>{
    let msg;
    try {msg=JSON.parse(event.data);} catch {return;}
    if(msg.type!=='task'||typeof msg.id!=='string')return;
    let answer;
    try {answer={type:'result',id:msg.id,ok:true,data:await handleTask(msg)};}
    catch(err){answer={type:'result',id:msg.id,ok:false,error:String(err.message||err).slice(0,250)};}
    if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(answer));
  };
  ws.onclose=()=>{
    if(heartbeat)clearInterval(heartbeat);
    scheduleRetry();
  };
  ws.onerror=()=>{try{ws.close();}catch{}};
}
// Do not automatically open a tab or steal focus when the extension installs.
chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.pairing){
    try {socket?.close();} catch {}
    socket=null;
    connect();
  }
});
chrome.alarms.create('omega-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener((alarm)=>{if(alarm.name==='omega-reconnect')connect();});
connect();
