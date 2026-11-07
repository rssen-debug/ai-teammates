// Compact semantic observations and bounded recovery on the existing CDP engine.
// Field contents are compared locally but never included in observations.
const observed = new Map();
export const FORM_SNAPSHOT_JS = String.raw`(() => {
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,160);
 const text=n=>{const c=n.cloneNode(true);c.querySelectorAll('input,select,textarea,button').forEach(x=>x.remove());return norm(c.textContent)};
 const label=el=>norm(el.getAttribute('aria-label'))||norm((el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '))||(el.labels?.length?text(el.labels[0]):'')||norm(el.getAttribute('placeholder'))||norm(el.getAttribute('title'))||norm(el.closest('label')?.textContent)||norm(el.name);
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&!el.closest('[hidden],[inert],[aria-hidden="true"]')};
 const doc=window.__majinFormDocument ||= Math.random().toString(36).slice(2);
 let next=window.__majinFormSequence||0;const fields=[],buttons=[];
 for(const el of document.querySelectorAll('input,select,textarea,button,[role="button"]')){
  if(fields.length+buttons.length>=100)break;
  const type=String(el.type||el.getAttribute('role')||el.tagName).toLowerCase();
  if(type==='hidden'||el.disabled||el.readOnly)continue;
  const labelTarget=['file','radio','checkbox'].includes(type)?Array.from(el.labels||[]).find(visible):null;
  if(!visible(el)&&!labelTarget)continue;
  let ref=el.getAttribute('data-majin-form-ref');if(!/^f[1-9][0-9]*$/.test(ref||'')){ref='f'+(++next);el.setAttribute('data-majin-form-ref',ref)}
  const selector='[data-majin-form-ref="'+ref+'"]';
  if(labelTarget)labelTarget.setAttribute('data-majin-form-click-ref',ref);
  const clickSelector=!visible(el)&&labelTarget?'[data-majin-form-click-ref="'+ref+'"]':selector;
  if(el.tagName==='BUTTON'||['submit','button','reset'].includes(type)||el.getAttribute('role')==='button'){
   buttons.push({ref,selector,label:norm(el.innerText||el.getAttribute('aria-label')||el.value),type,submit:type==='submit',form:el.form?.id||''});continue;
  }
  const v=el.validity;
  fields.push({ref,selector,label:label(el),type,tag:el.tagName.toLowerCase(),name:norm(el.name),form:el.form?.id||'',
   ...(type==='radio'?{option:norm(el.closest('label')?.textContent)||norm(labelTarget?.textContent)||norm(el.value),group:norm(el.name),value:norm(el.value)}:{}),
   ...(['radio','checkbox'].includes(type)?{clickSelector}:{}),
   required:Boolean(el.required),filled:type==='file'?Boolean(el.files?.length):['checkbox','radio'].includes(type)?Boolean(el.checked):Boolean(el.value),
   problems:v?['valueMissing','typeMismatch','patternMismatch','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError','tooShort','tooLong'].filter(k=>v[k]):[],
   ...(el.tagName==='SELECT'?{options:Array.from(el.options).filter(o=>!o.disabled&&!o.parentElement?.disabled).slice(0,30).map(o=>norm(o.label))}:{}),
   ...(['number','range','date'].includes(type)?{min:el.min,max:el.max,step:el.step}:{}),
   sensitive:type==='password'||el.autocomplete==='one-time-code'});
 }
 window.__majinFormSequence=next;
 const alerts=Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"],.error,.validation-error')).filter(visible).slice(0,5).map(text).filter(Boolean);
 const barriers=[];if(fields.some(f=>f.sensitive))barriers.push('Authentication: owner must complete password/one-time-code fields');
 if(Array.from(document.querySelectorAll('iframe')).some(f=>/recaptcha|hcaptcha|captcha/i.test(f.src)&&visible(f)))barriers.push('CAPTCHA: owner handoff required; do not bypass');
 return {document:doc,url:location.href,title:document.title,fields,buttons,alerts,barriers};
})()`;

export async function observeForm(browser,session){
 const snapshot=await browser.eval(FORM_SNAPSHOT_JS);
 if(observed.size>=100&&!observed.has(String(session)))observed.delete(observed.keys().next().value);
 observed.set(String(session),snapshot);
 return snapshot;
}
export function describeForm(s){
 let bytes=0;const fields=[];
 for(const {ref,label,type,required,filled,problems,options,min,max,step,option,group} of s.fields){
  const row={ref,label,type,required,filled,problems,...(option?{option}:{}),...(group?{group}:{}),...(options?{options}:{}),...(min?{min}:{}),...(max?{max}:{}),...(step?{step}:{})};
  bytes+=JSON.stringify(row).length;if(bytes>7000)break;fields.push(row);
 }
 return JSON.stringify({url:s.url,title:s.title,fields,omittedFields:s.fields.length-fields.length,buttons:s.buttons.slice(0,10),alerts:s.alerts.map(a=>a.slice(0,300)),barriers:s.barriers,next:'Use browser.form_fill({values:{"exact observed label or f-ref":"value"}}). Batch already observed fields. Use true/false for checkboxes, use a radio group name as the key with an exact observed option label as its string value (or an f-ref with true), visible option labels for selects, workspace path for files. Conditional fields require another observation. Prefer browser.form_submit({button:"exact button label"}) to advance/submit once. A click is not server acceptance.'});
}
export function clearForm(session){observed.delete(String(session));}
export async function submitForm({browser,session,button,run}){
 const prior=observed.get(String(session));
 if(!prior)return {ok:false,error:{code:'observe_required',message:'Observe browser.form before choosing a next/submit button.'}};
 const chosen=prior.buttons.filter(b=>b.ref===button||b.label===button),current=await observeForm(browser,session);
 if(chosen.length!==1||current.document!==prior.document||current.url!==prior.url)return {ok:false,error:{code:'button_changed',message:'Button was not uniquely grounded in this document. Observe browser.form.'}};
 if(current.barriers.length)return {ok:false,error:{code:'owner_handoff',message:current.barriers.join('; ')}};
 const matches=current.buttons.filter(b=>b.label===chosen[0].label&&b.type===chosen[0].type&&b.form===chosen[0].form);
 if(matches.length!==1)return {ok:false,error:{code:'button_changed',message:'Button changed or is ambiguous. Observe browser.form.'}};
 const clicked=await run('browser.click',{selector:matches[0].selector});
 if(!clicked.ok)return clicked;
 await new Promise(r=>setTimeout(r,300));
 const after=await observeForm(browser,session),page=await run('browser.read',{});
 return {ok:true,result:JSON.stringify({action:'Button clicked once; submission success unproven',observation:JSON.parse(describeForm(after)),pageText:String(page.result||'').slice(0,3000)}),summary:'Navigation/submission observed; inspect errors or actual receipt',meta:{submitRetried:false}};
}
const identity=f=>JSON.stringify([f.label,f.type,f.tag,f.name,f.form]);

/**
 * Real keyboard input for framework-controlled fields that reject property setters.
 * Text is inserted in bounded chunks so event-driven UIs can apply their state
 * updates. No source text appears in a tool result, log or error.
 */
export async function typeWithNativeEvents({ browser, selector, value, signal, chunkSize = 160 }) {
 const sel=JSON.stringify(selector), expected=String(value);
 const read=async()=>browser.eval(`(() => {const el=document.querySelector(${sel});return el?{exists:true,value:el.value,disabled:el.disabled}: {exists:false};})()`);
 signal?.throwIfAborted?.();
 const focused=await browser.eval(`(() => {const el=document.querySelector(${sel});if(!el||el.disabled||el.readOnly||!['INPUT','TEXTAREA'].includes(el.tagName))return false;el.focus();el.select();return document.activeElement===el;})()`);
 if(!focused)return {ok:false,code:'field_not_focusable'};
 // Select via DOM, delete via Chrome's trusted native key input.
 await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
 await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
 let text='';
 for(let i=0;i<expected.length;i+=chunkSize){
  signal?.throwIfAborted?.();
  const chunk=expected.slice(i,i+chunkSize);
  await browser.send('Input.insertText',{text:chunk});
  text+=chunk;
  const current=await read();
  if(!current.exists||current.value!==text){
   return {ok:false,code:'framework_reverted',insertedChars:i+chunk.length};
  }
 }
 // Check again after the web framework's queued updates, then blur.
 await new Promise(resolve=>setTimeout(resolve,180));
 const retained=await read();
 if(!retained.exists||retained.value!==expected)return {ok:false,code:'framework_reverted_after_update'};
 await browser.eval(`document.querySelector(${sel})?.blur()`);
 await new Promise(resolve=>setTimeout(resolve,120));
 const final=await read();
 return final.exists&&final.value===expected
  ? {ok:true,insertedChars:expected.length}
  : {ok:false,code:'framework_reverted_on_blur'};
}

export async function fillForm({browser,session,values,run,signal}){
 const prior=observed.get(String(session));
 if(!prior)return {ok:false,error:{code:'observe_required',message:'Call browser.form first to observe live labels and references.'}};
 if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).length>12||Object.values(values).some(v=>!['string','boolean'].includes(typeof v)))return {ok:false,error:{code:'bad_input',message:'values must map 1–12 observed labels/refs to strings or checkbox booleans.'}};
 const results=[];
 for(const [key,value] of Object.entries(values)){
  signal?.throwIfAborted();
  const candidates=prior.fields.filter(f=>f.ref===key||f.label===key||f.type==='radio'&&f.group===key);
  const current=await observeForm(browser,session);
  const fail=(code,message)=>({ok:false,error:{code,message,hint:'Live form observation (values hidden): '+describeForm(current)},result:JSON.stringify({completed:results,observation:JSON.parse(describeForm(current))})});
  const radioGroup = candidates.length>1 && candidates.every(f=>f.type==='radio'&&f.group===key);
  const radioChoice = radioGroup && typeof value==='string' ? candidates.filter(f=>f.option===value||f.value===value||f.label===value) : [];
  if(radioGroup&&radioChoice.length!==1)return fail('radio_option_not_grounded','Radio group requires one exact observed option label/value. Inspect browser.form options and choose a unique value.');
  if(!radioGroup&&candidates.length!==1)return fail('field_not_grounded','Label/ref was absent or ambiguous in the prior observation; choose a current unique field.');
  if(current.document!==prior.document||current.url!==prior.url)return fail('document_changed','Navigation changed the document; inspect browser.form before acting.');
  const old=radioGroup?radioChoice[0]:candidates[0],matches=current.fields.filter(f=>identity(f)===identity(old));
  if(matches.length!==1)return fail('field_changed','Field identity changed or is ambiguous; re-observe and choose its current label/ref.');
  const f=matches[0];
  if(f.sensitive||current.barriers.length)return fail('owner_handoff','Authentication/CAPTCHA requires the owner; nothing changed.');
  let outcome,strategy=f.ref===old.ref?'live_field':'semantic_reground';
  if(['checkbox','radio'].includes(f.type)){
   if(!radioGroup && ![true,false,'true','false'].includes(value))return fail('checkbox_value','Use true or false for a checkbox/radio.');
   const desired=radioGroup||value===true||value==='true';
   if(f.type==='radio'&&!desired)return fail('radio_value','Select the desired radio option; do not clear a radio directly.');
   if(f.filled===desired)outcome={ok:true};
   else outcome=await run('browser.click',{selector:f.clickSelector||f.selector});
   if(outcome.ok){const checked=await browser.eval(`Boolean(document.querySelector(${JSON.stringify(f.selector)})?.checked)`);if(checked!==desired)outcome={ok:false,error:{code:'checked_reverted',message:'Checked state did not persist; re-observe.'}};}
  }else if(f.type==='file')outcome=await run('browser.upload',{selector:f.selector,path:String(value)});
  else{
   outcome=await run('browser.fill',{selector:f.selector,value:String(value)});
   // A different bounded strategy, never a blind replay of a reverted setter.
   if(!outcome.ok&&['value_rejected','value_reverted'].includes(outcome.error?.code)&&['text','email','search','tel','url','number','textarea'].includes(f.type)){
    const fresh=await observeForm(browser,session),again=fresh.fields.filter(x=>identity(x)===identity(f));
    if(fresh.document===prior.document&&again.length===1){
     const target=again[0];
     const typed=await typeWithNativeEvents({browser,selector:target.selector,value:String(value),signal});
     strategy='native_type_retry';
     outcome=typed.ok?{ok:true}:{ok:false,error:{code:'value_reverted',message:'Native input was not retained by the website. Preserve previously filled fields; inspect current form state.',reason:typed.code}};
    }
   }
  }
  results.push({field:old.label||old.ref,type:f.type,ok:outcome.ok,strategy,...(!outcome.ok?{failure:outcome.error}:{}),...(outcome.meta?.sha256?{uploadSha256:outcome.meta.sha256}:{})});
  const after=await observeForm(browser,session);
  if(!outcome.ok)return {ok:false,error:{...outcome.error,hint:'Live form observation (values hidden): '+describeForm(after)},result:JSON.stringify({completed:results,observation:JSON.parse(describeForm(after))})};
 }
 const after=await observeForm(browser,session);
 return {ok:true,result:JSON.stringify({completed:results,observation:JSON.parse(describeForm(after))}),meta:{verifiedFields:results.length,recoveries:results.filter(r=>r.strategy!=='live_field').length,strategies:[...new Set(results.map(r=>r.strategy))]},summary:`${results.length} form fields verified; submission not yet proven`};
}
