import { describe, it, expect, vi } from 'vitest';
import { runContinuousVoice } from '../../packages/cli/src/continuous-voice.js';

function makeRuntime() {
  const values=new Map<string,string>([['buddy.chat.language.v1','sv-SE']]);
  return {
    services:{
      permissions:{isGranted:vi.fn(()=>true)},
      db:{checkpoints:{
        get:<T>(key:string)=>values.get(key) as T|undefined,
        set:(key:string,value:string)=>{values.set(key,value);}
      }},
      memory:null
    },
    routeUserIntent:vi.fn(async(text:string)=>({
      kind:text.includes('skriv hej')?'desktop':'chat',goal:text,reason:'test'
    })),
    runDesktopGoal:vi.fn(async()=>({complete:true,blocked:false,summary:'Utkastet finns i fältet',events:[]})),
    chatWithScreen:vi.fn(async()=>({ok:true,data:{message:{text:'Jag ser en Google-sida.'}}})),
    chat:vi.fn(async()=>({ok:true,data:{message:{text:'chat'}}}))
  };
}
function input(...utterances:string[]){
  return {listen:async function*(){for(const text of utterances)yield text;},
    close:vi.fn(),onReady:vi.fn()};
}
function playback(){return {speak:vi.fn(async()=>{}),stop:vi.fn()};}
describe('continuous voice and desktop context',()=>{
  it('routes spoken desktop instructions through general agent, no hardcoded prefix',async()=>{
    const runtime=makeRuntime(), speech=input('skriv hej till chat','stop voice'), speaker=playback();
    await runContinuousVoice(runtime as never,()=>{}, {input:speech,playback:speaker,maxTurns:4});
    expect(runtime.routeUserIntent).toHaveBeenCalledWith('skriv hej till chat');
    expect(runtime.runDesktopGoal).toHaveBeenCalledWith('skriv hej till chat',expect.any(Function));
    expect(speech.close).toHaveBeenCalled();
  });
  it('uses screen-aware chat for spoken screen questions and preserves selected language',async()=>{
    const runtime=makeRuntime(), speaker=playback();
    await runContinuousVoice(runtime as never,()=>{}, {input:input('vad ser du på skärmen','stop voice'),playback:speaker,maxTurns:4});
    expect(runtime.chatWithScreen).toHaveBeenCalledWith('vad ser du på skärmen');
    expect(runtime.services.db.checkpoints.get('buddy.chat.language.v1')).toBe('sv-SE');
  });
});
