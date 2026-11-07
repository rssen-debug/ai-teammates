import { describe,expect,it,vi } from 'vitest';
import { parseAction,runAgent,safeUi,AGENT_SYSTEM } from '../../packages/core/src/desktop-agent.js';
import { runVoiceMode } from '../../packages/cli/src/voice-mode.js';

const win={id:'w1',title:'Editor',processName:'editor.exe',focused:true,minimized:false,appKind:'OTHER',bounds:{x:0,y:0,width:10,height:10},displayId:null};
const snap={
  windowId:'w1',accessible:true,note:null,takenAt:new Date().toISOString(),
  elements:[{ref:'@w1:e1',role:'text',name:'Notes editor',value:'',enabled:true,stale:false},
    {ref:'@w1:e2',role:'password',name:'Password',value:'very-secret',enabled:true,stale:false}],
};
const adapter=()=>{
  const calls:string[]=[];
  return {calls,
    listWindows:vi.fn(async()=>({windows:[win],error:null})),
    snapshot:vi.fn(async()=>snap),
    focusWindow:vi.fn(async()=>({ok:true,detail:'focused'})),
    click:vi.fn(async()=>{calls.push('click');return {ok:true,detail:'clicked'};}),
    setValue:vi.fn(async()=>{calls.push('type');return {ok:true,detail:'typed'};}),
    press:vi.fn(async()=>{calls.push('press');return {ok:true,detail:'pressed'};}),
    revalidate:vi.fn(async(_id:string,ref:string)=>snap.elements.find(e=>e.ref===ref)??null),
  };
};
describe('real Kilo tool loop',()=>{
  it('validates JSON-only model actions and refuses invalid refs',()=>{
    expect(parseAction('{"action":"windows"}')).toEqual({action:'windows'});
    expect(parseAction('junk')).toBeNull();
    expect(parseAction({action:'click',windowId:'w1',ref:'invented'})).toBeNull();
    expect(AGENT_SYSTEM).toContain('verified');
    expect(safeUi(snap as never)).not.toContain('very-secret');
  });
  it('uses actual window and UI refs before tool actions',async()=>{
    const native=adapter();
    const steps=[{action:'windows'},{action:'inspect',windowId:'w1'},
      {action:'type',windowId:'w1',ref:'@w1:e1',text:'Hello'},
      {action:'inspect',windowId:'w1'},{action:'finish',message:'done'}];
    const result=await runAgent('Type a greeting',native as never,async()=>steps.shift(),undefined,5);
    expect(result.complete).toBe(true);
    expect(native.setValue).toHaveBeenCalledWith('@w1:e1','Hello');
    expect(native.snapshot).toHaveBeenCalledTimes(2);
  });
  it('blocks shopping and outward messages before running any planner',async()=>{
    const native=adapter(),plan=vi.fn();
    const result=await runAgent('Buy something on Amazon',native as never,plan);
    expect(result.blocked).toBe(true);
    expect(plan).not.toHaveBeenCalled();
  });
  it('never trusts invented or protected refs',async()=>{
    const native=adapter();
    const steps=[{action:'windows'},{action:'inspect',windowId:'w1'},
      {action:'type',windowId:'w1',ref:'@w1:e2',text:'hi'},
      {action:'finish',message:'done'}];
    const result=await runAgent('Fill notes',native as never,async()=>steps.shift(),undefined,4);
    expect(result.complete).toBe(false);
    expect(native.setValue).not.toHaveBeenCalled();
  });
  it('does not claim success on planning without verified changes',async()=>{
    const result=await runAgent('Check a document',adapter() as never,
      async()=>({action:'finish',message:'Done'}),undefined,2);
    expect(result.complete).toBe(false);
    expect(result.summary).toMatch(/inte verifierat/i);
  });
});
describe('Kilo voice conversation',()=>{
  it('reuses the runtime chat and supports voice stop',async()=>{
    const output:string[]=[];
    const utterances=['hello','stop voice'];
    const runtime={services:{db:{checkpoints:{get:()=> 'en-US'}}},
      chat:vi.fn(async()=>({ok:true,data:{message:{text:'Hello!'}}}))};
    await runVoiceMode(runtime as never,s=>output.push(s),{
      capture:async()=>({text:utterances.shift()??null,error:null}),
      speak:async()=>{},maxTurns:3,
    });
    expect(runtime.chat).toHaveBeenCalledWith('hello');
    expect(runtime.chat).toHaveBeenCalledTimes(1);
    expect(output.join(' ')).toContain('VOICE avslutad');
  });
});
