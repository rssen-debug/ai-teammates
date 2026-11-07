/* MAJIN voice direction classifier: deterministic control verbs, not invented completions. */
(function(){
'use strict';
function classify(input, busy){
 const raw=String(input||'').trim(); const s=raw.toLocaleLowerCase('sv-SE').replace(/[!?.,]+/g,' ').replace(/\s+/g,' ').trim();
 if(!raw)return {kind:'empty',text:''};
 // Match standalone interrupts only. Do not mistake "nej" inside a normal prompt for cancellation.
 if(/^(?:nej(?: vänta| stopp)?|vänta|stopp|stop|avbryt|cancel|hold on|wait|never mind|stop that)$/.test(s))return {kind:'cancel',text:''};
 const change=raw.match(/^(?:nej[!,]?\s*(?:vänta[!,]?\s*)?|vänta[!,]?\s*|istället[!,]?\s*)(?:gör|öppna|sök|visa|skapa|bygg|hitta|gå till|open|search|show|create|build)\b[\s\S]*/i);
 if(busy && change) return {kind:'replace',text:raw.replace(/^(?:nej[!,]?\s*(?:vänta[!,]?\s*)?|vänta[!,]?\s*|istället[!,]?\s*)/i,'').trim()};
 return {kind:'send',text:raw};
}
window.MAJIN_VOICE_INTENT={classify};
})();
