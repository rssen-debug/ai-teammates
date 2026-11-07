import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});});
import { StuddyRuntime } from '@studdy/core';

function runtime() {
  const dir=mkdtempSync(join(tmpdir(),'buddy-voice-screen-test-'));dirs.push(dir);
  const rt=new StuddyRuntime({dataDir:dir,platform:'win32'});
  rt.services.permissions.grant('application.observe');
  rt.services.permissions.grant('provider.dataShare');
  return rt;
}
function setScreen(rt:StuddyRuntime,label:string,elements:Array<{name:string;value?:string;role?:string}>,observing=true) {
  vi.spyOn(rt,'liveStatus').mockReturnValue({
    state:observing?'active':'no-window',observing,windowTitle:label,windowId:'w1',
    elementCount:elements.length,lastObservedAt:Date.now(),activity:'Measured',
    level:2,openWindowCount:1,openWindows:[label],foregroundWindow:label,observationScope:'foreground',
  });
  vi.spyOn(rt.observer,'lastSnapshot').mockReturnValue({
    windowId:'w1',accessible:true,note:null,takenAt:new Date().toISOString(),
    elements:elements.map((e,i)=>({ref:'@w1:e'+i,role:e.role??'text',name:e.name,
      value:e.value??'',enabled:true,stale:false,bounds:null})),
  });
}
describe('screen-grounded live voice',()=>{
  it('uses actual UIA study observations in Kilo model context, not in user message',async()=>{
    const rt=runtime();
    try {
      setScreen(rt,'Packet Tracer',[
        {name:'OSI Layer 3 Router'},
        {name:'Subnet mask 255.255.255.0'},
        {name:'API key: secret-123'},
        {name:'Password',role:'password',value:'dont-send'},
        {name:'text field',role:'edit',value:'private-notes'},
      ]);
      const ask=vi.spyOn(rt.services,'ask').mockResolvedValue({ok:true,data:{message:{text:'Learning',id:'1'}},} as never);
      const c=rt.voiceScreenContext();
      expect(c.proof).toBe('verified-accessible-ui');
      expect(c.text).toContain('OSI Layer 3 Router');
      expect(c.text).not.toContain('secret-123');
      expect(c.text).not.toContain('dont-send');
      expect(c.text).not.toContain('private-notes');
      await rt.chatWithScreen('Help me understand what I am studying');
      expect(ask).toHaveBeenCalledOnce();
      const sent=ask.mock.calls[0]![0];
      expect(sent.text).toBe('Help me understand what I am studying');
      expect(sent.selectedText).toContain('OSI Layer 3 Router');
    } finally {await rt.close();}
  });
  it('does not send private page or ChatGPT conversation contents to Kilo',async()=>{
    const rt=runtime();
    try {
      setScreen(rt,'Webbläsare · AI-chatt',[{name:'Private ChatGPT dialogue'}]);
      expect(rt.voiceScreenContext()).toMatchObject({text:null,proof:'private-content-not-transmitted'});
      setScreen(rt,'Privat fönster',[{name:'Your bank account'}]);
      expect(rt.voiceScreenContext().text).toBeNull();
    }finally{await rt.close();}
  });
  it('rejects stale or nonmatching observations',async()=>{
    const rt=runtime();
    try {
      setScreen(rt,'Packet Tracer',[{name:'Network protocol'}],false);
      expect(rt.voiceScreenContext().text).toBeNull();
      setScreen(rt,'Packet Tracer',[{name:'Network protocol'}]);
      vi.spyOn(rt.observer,'lastSnapshot').mockReturnValue({
        windowId:'different',accessible:true,elements:[],takenAt:new Date().toISOString(),note:null,
      });
      expect(rt.voiceScreenContext().proof).toBe('no-matching-snapshot');
    }finally{await rt.close();}
  });
});
