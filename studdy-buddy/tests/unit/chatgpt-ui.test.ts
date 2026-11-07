import { describe, expect, it, vi } from 'vitest';
import { extractChatGPTMessage, isChatGPTConversationRequest, prepareChatGPTDraft, sendApprovedChatGPTDraft } from '../../packages/core/src/chatgpt-ui.js';

const w={id:'chrome1',title:'Repo status verifiering - Google Chrome',processName:'chrome.exe',focused:false,minimized:false};
const el=(ref:string,role:string,name:string,value:string|null='')=>({ref,role,name,value,enabled:true,stale:false});
const chatHeader=el('@w:e1','text','ChatGPT');
const editor=el('@w:e2','edit','Fråga ChatGPT');
function fake() {
  let current='', sent=false, exists=true;
  const adapter={
    listWindows:vi.fn(async()=>({windows:[w],error:null})),
    snapshot:vi.fn(async()=>({windowId:w.id,accessible:true,note:null,takenAt:new Date().toISOString(),
      elements:exists?[chatHeader,{...editor,value:current},...(sent?[el('@w:e3','text','hej')]:[])]:[el('@w:e7','text','Other page')]})),
    focusWindow:vi.fn(async()=>({ok:true,detail:'focused'})),
    setValue:vi.fn(async(_ref:string,value:string)=>{current=value;return {ok:true,detail:'typed'};}),
    type:vi.fn(async()=>({ok:false,detail:'blocked'})),
    press:vi.fn(async()=>{sent=true;current='';return {ok:true,detail:'pressed'};}),
  };
  return {adapter, changePage:()=>{exists=false;}, prefill:(value:string)=>{current=value;}};
}
describe('ChatGPT native UI message workflow',()=>{
  it('routes the real-world Swedish command, not arbitrary writing',()=>{
    expect(extractChatGPTMessage('skriv till chat gpt hej')).toBe('hej');
    expect(extractChatGPTMessage('skicka till ChatGPT: Vad är OSI?')).toBe('Vad är OSI?');
    expect(extractChatGPTMessage('write to ChatGPT hello')).toBe('hello');
    expect(extractChatGPTMessage('skriv en dikt om chat gpt')).toBeNull();
  });
  it('recognizes natural conversation invitation without fabricating a message',()=>{
    expect(isChatGPTConversationRequest('snacka med chat')).toBe(true);
    expect(isChatGPTConversationRequest('snacka med ChatGPT')).toBe(true);
    expect(isChatGPTConversationRequest('can you talk with ChatGPT')).toBe(true);
    expect(extractChatGPTMessage('snacka med chat')).toBeNull();
    expect(isChatGPTConversationRequest('prata med mig om ChatGPT')).toBe(false);
  });
  it('drafts only in a verified ChatGPT edit element and never sends without confirmation',async()=>{
    const f=fake();
    const draft=await prepareChatGPTDraft('hej',f.adapter as never);
    expect(draft.ok).toBe(true);
    expect(f.adapter.setValue).toHaveBeenCalledWith('@w:e2','hej');
    expect(f.adapter.press).not.toHaveBeenCalled();
    const sent=await sendApprovedChatGPTDraft(draft,'hej',f.adapter as never);
    expect(sent.ok).toBe(true);
    expect(f.adapter.press).toHaveBeenCalledWith('enter','chrome1');
  });
  it('recognizes Chromium text area role for a verified ChatGPT composer',async()=>{
    const f=fake();
    const original=f.adapter.snapshot;
    f.adapter.snapshot=vi.fn(async()=>{
      const snap=await original();
      return {...snap,elements:snap.elements.map(e=>e.ref==='@w:e2'?{...e,role:'text area'}:e)};
    });
    expect((await prepareChatGPTDraft('hej',f.adapter as never)).ok).toBe(true);
  });
  it('re-finds the composer when a fresh snapshot regenerates its element ref',async()=>{
    const f=fake();
    const original=f.adapter.snapshot;
    let count=0;
    f.adapter.snapshot=vi.fn(async()=>{
      const snap=await original();
      count++;
      return {...snap,elements:snap.elements.map(e=>e.ref==='@w:e2'?
        {...e,ref:count===1?'@w:e2':'@w:e9'}:e)};
    });
    const draft=await prepareChatGPTDraft('hej',f.adapter as never);
    expect(draft.ok).toBe(true);
    expect(f.adapter.setValue).toHaveBeenCalledWith('@w:e9','hej');
  });
  it('does not type in arbitrary Chrome pages',async()=>{
    const f=fake();f.changePage();
    expect((await prepareChatGPTDraft('hej',f.adapter as never)).ok).toBe(false);
    expect(f.adapter.setValue).not.toHaveBeenCalled();
  });
  it('does not overwrite an existing user draft',async()=>{
    const f=fake();f.prefill('my existing question');
    expect((await prepareChatGPTDraft('hej',f.adapter as never)).detail).toContain('redan ett utkast');
    expect(f.adapter.setValue).not.toHaveBeenCalled();
  });
  it('does not send when the field changed after draft',async()=>{
    const f=fake();const draft=await prepareChatGPTDraft('hej',f.adapter as never);
    f.prefill('changed');
    const result=await sendApprovedChatGPTDraft(draft,'hej',f.adapter as never);
    expect(result.ok).toBe(false);
    expect(f.adapter.press).not.toHaveBeenCalled();
  });
});
