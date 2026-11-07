import type { DesktopAccessibilityAdapter } from './desktop-adapter.js';
import type { UiElementInfo } from '@studdy/shared';

export interface ChatDraft {
  ok: boolean;
  detail: string;
  windowId?: string;
  inputRef?: string;
}
export type ChatUiAdapter = Pick<DesktopAccessibilityAdapter,'listWindows'|'snapshot'|'focusWindow'|'setValue'|'type'|'press'>;

/** User intent parsing, not a claim that a message was transmitted. */
export function extractChatGPTMessage(input: string): string | null {
  const text=input.trim().replace(/[.!]$/,'').trim();
  const command=/^(?:(?:hey\s+)?buddy[,! ]+\s*)?(?:(?:kan du|skulle du kunna|snälla|please|can you|could you)\s+)?(?:skriv|skriva|skicka|säg|write|send|say)\s+(.+)$/i.exec(text);
  if (!command) return null;
  const content=command[1]!.trim();
  if (/^(?:(?:till|to|i|in)\s+)?(?:chat\s*gpt|chatgpt|chatten|chat)$/i.test(content)) return null;
  // "skriv till chat gpt hej" / "send to ChatGPT: hello"
  const receiverFirst=/^(?:(?:till|to|i|in)\s+)?(?:chat\s*gpt|chatgpt|chatten|chat)\s*(?::|-|\s+att|\s+that)?\s+(.+)$/i.exec(content);
  // "skriv hej till chat" / "write hello to ChatGPT".
  const messageFirst=/^(.+?)\s+(?:till|to|i|in)\s+(?:chat\s*gpt|chatgpt|chatten|chat)$/i.exec(content);
  const raw=(receiverFirst?.[1]??messageFirst?.[1]??'').trim().replace(/^["“”']|["“”']$/g,'').trim();
  if (!raw || raw.length>500 || /^(?:till|to|i|in)\s*$/i.test(raw)) return null;
  return raw;
}
/** A conversation request without actual words is not a message to send.
 * Treat it as an interactive request, not as a claim that desktop tools fail.
 */
export function isChatGPTConversationRequest(input: string): boolean {
  return /^(?:(?:buddy[,! ]+)?(?:kan du|snälla|please|can you|could you)\s+)?(?:snacka|prata|konversera|chatta|talk|chat|converse)\s+(?:med\s+|with\s+)?(?:chat\s*gpt|chatgpt|chat)(?:\s+(?:nu|lite))?[.!?]?$/i.test(input.trim());
}
function editable(e: UiElementInfo): boolean {
  const label=e.name.trim();
  return e.enabled && !e.stale && /^@[^:]+:e\d+$/i.test(e.ref) &&
    /^(?:edit|textbox|text field|text input|text area|textarea|entry|editable text|combo box)$/i.test(e.role) &&
    /(?:ask anything|ask chatgpt|message chatgpt|send a message|fråga chatgpt|fråga vad som helst|skriv ett meddelande|message|prompt|chatgpt)/i.test(label) &&
    !/(?:password|lösenord|api.?key|token|secret|search)/i.test(label);
}
function provesChatGPT(elements: UiElementInfo[]): boolean {
  return elements.some(e=>/(?:^ChatGPT$|^chatgpt\.com(?:\/|$)|^Ny chatt$|^New chat$|^Fråga ChatGPT$|^Ask ChatGPT$|^Ask anything$)/i.test(e.name.trim()) || /^https:\/\/chatgpt\.com(?:\/|$)/i.test((e.value ?? '').trim()));
}
/** Uses real native accessible UI references. Never types into an arbitrary
 * Chrome window. Checks that the active page really exposes ChatGPT controls.
 * Existing user drafts are never overwritten.
 */
export async function prepareChatGPTDraft(
  message:string,
  adapter:ChatUiAdapter,
):Promise<ChatDraft>{
  if(!message.trim() || Buffer.byteLength(message,'utf8')>1500)
    return {ok:false,detail:'Meddelandet måste vara 1–1500 byte.'};
  const listed=await adapter.listWindows();
  if(listed.error) return {ok:false,detail:'Kan inte lista fönster: '+listed.error.slice(0,140)};
  const browsers=listed.windows.filter(w=>
    !w.minimized && /(?:chrome|msedge|brave|firefox|edge)/i.test(w.processName+' '+w.title))
    .sort((a,b)=>Number(b.focused)-Number(a.focused)).slice(0,8);
  if(!browsers.length)return {ok:false,detail:'Ingen öppen webbläsare hittades.'};
  for(const w of browsers){
    const snap=await adapter.snapshot(w.id);
    if(!snap.accessible || !provesChatGPT(snap.elements))continue;
    const input=snap.elements.find(editable);
    if(!input)continue;
    if(input.value?.trim())return {ok:false,detail:'ChatGPT har redan ett utkast. Jag skriver inte över det.'};
    const focused=await adapter.focusWindow(w.id);
    if(!focused.ok)return {ok:false,detail:'Kunde inte fokusera ChatGPT: '+focused.detail.slice(0,100)};
    const refreshed=await adapter.snapshot(w.id);
    const field=refreshed.accessible ? refreshed.elements.find(e=>e.ref===input.ref && editable(e)) : undefined;
    if(!field || field.value?.trim())return {ok:false,detail:'Skrivfältet förändrades. Ingen text skickades.'};
    let written=await adapter.setValue(field.ref,message);
    if(!written.ok) written=await adapter.type(field.ref,message,{headed:true});
    if(!written.ok)return {ok:false,detail:'Kunde inte skriva i ChatGPT: '+written.detail.slice(0,140)};
    const verified=await adapter.snapshot(w.id);
    const value=verified.elements.find(e=>e.ref===field.ref)?.value;
    if(value !== message) return {ok:false,detail:'Text skrevs men kunde inte verifieras i ChatGPT. Kontrollera fönstret manuellt.'};
    return {ok:true,detail:'Texten är verifierad i ChatGPTs skrivfält, men inte skickad.',windowId:w.id,inputRef:field.ref};
  }
  return {ok:false,detail:'Jag hittade inget verifierat ChatGPT-skrivfält. Öppna ChatGPT-fliken och försök igen.'};
}
export async function sendApprovedChatGPTDraft(
  draft:ChatDraft,
  message:string,
  adapter:ChatUiAdapter,
):Promise<ChatDraft>{
  if(!draft.ok || !draft.windowId || !draft.inputRef)return {ok:false,detail:'Inget verifierat utkast att skicka.'};
  // The user has just confirmed this exact message in the CLI.
  const before=await adapter.snapshot(draft.windowId);
  const field=before.elements.find(e=>e.ref===draft.inputRef);
  if(!before.accessible || field?.value!==message)return {ok:false,detail:'Utkastet har ändrats. Skickar inte.'};
  const focus=await adapter.focusWindow(draft.windowId);
  if(!focus.ok)return {ok:false,detail:'Kunde inte aktivera ChatGPT.'};
  const result=await adapter.press('enter',draft.windowId);
  if(!result.ok)return {ok:false,detail:'Sändningsförsöket misslyckades: '+result.detail.slice(0,120)};
  const after=await adapter.snapshot(draft.windowId);
  const input=after.elements.find(e=>e.ref===draft.inputRef);
  const visible=after.elements.some(e=>e.name.trim()===message || e.value?.trim()===message);
  const cleared=input?.value==='' || input?.value===null;
  if(!after.accessible || !visible || !cleared)
    return {ok:false,detail:'Enter skickades, men meddelandet är inte verifierat som skickat. Kontrollera ChatGPT.'};
  return {ok:true,detail:'Meddelandet syns i ChatGPT och skrivfältet har tömts.'};
}
