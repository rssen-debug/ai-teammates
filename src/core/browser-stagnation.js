/**
 * Per-session browser stagnation sensor.
 *
 * Inspired by browser-use's page fingerprint loop detection. It records only
 * salted-in-process SHA256 fingerprints, never page text, passwords or tokens.
 * It is advisory: deliberate repeated actions remain possible.
 */
import { createHash, randomBytes } from 'node:crypto';
const sessions=new Map();
const salt=randomBytes(16);
const MAX_SESSIONS=64;
function hashPage({url='',title='',text='',controls=[]}={}){
  const h=createHash('sha256');
  h.update(salt);
  h.update(JSON.stringify([
    String(url).slice(0,1500),String(title).slice(0,300),
    String(text).slice(0,9000),String(text).slice(-3000),
    Array.isArray(controls)?[controls.length,...(controls.length>30?[...controls.slice(0,12),...Array.from({length:10},(_,i)=>controls[Math.floor((i+1)*(controls.length-1)/11)]),...controls.slice(-10)]:controls).map(c=>[
      String(c.selector||'').slice(0,100),
      String(c.label||'').slice(0,100),Boolean(c.checked),c.enabled===true?true:c.enabled===false?false:null
    ])]:[]
  ]));
  return h.digest('hex');
}
function entry(id){
  const key=String(id||'default');
  if(!sessions.has(key)){
    if(sessions.size>=MAX_SESSIONS)sessions.delete(sessions.keys().next().value);
    sessions.set(key,{last:null,pending:false,unchangedActions:0});
  }
  return sessions.get(key);
}
export function noteBrowserAction(session){entry(session).pending=true;}
export function observeBrowserPage(session,state){
  const e=entry(session),fp=hashPage(state);
  if(e.pending && e.last!==null){
    e.unchangedActions=e.last===fp?Math.min(20,e.unchangedActions+1):0;
  }else if(e.pending){e.unchangedActions=0;}
  e.last=fp;e.pending=false;
  return {stagnant:e.unchangedActions>=2,unchangedActions:e.unchangedActions};
}
export function clearBrowserStagnation(session){sessions.delete(String(session||'default'));}
