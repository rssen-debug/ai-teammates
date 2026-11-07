import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../packages/core/src/desktop-agent.js';

const windowInfo={id:'w1',title:'Browser',processName:'chrome.exe',focused:true,minimized:false};
const field=(value:string)=>({ref:'@w:e2',role:'edit',name:'Message',value,enabled:true,stale:false});
function makeAdapter(writesVisible:boolean) {
  let value='';
  const snapshot=vi.fn(async()=>({windowId:'w1',accessible:true,takenAt:new Date().toISOString(),note:null,
    elements:[{ref:'@w:e1',role:'text',name:'Composer',value:null,enabled:true,stale:false},
      field(writesVisible?value:'')]}));
  return {
    listWindows:vi.fn(async()=>({windows:[windowInfo],error:null})),
    snapshot,
    focusWindow:vi.fn(async()=>({ok:true,detail:'ok'})),
    click:vi.fn(async()=>({ok:true,detail:'ok'})),
    setValue:vi.fn(async(_ref:string,text:string)=>{value=text;return {ok:true,detail:'ok'};}),
    press:vi.fn(async()=>({ok:true,detail:'ok'})),
    revalidate:vi.fn(async()=>field('')),
  };
}
const plan=[
  {action:'windows'},
  {action:'inspect',windowId:'w1'},
  {action:'type',windowId:'w1',ref:'@w:e2',text:'hej'},
  {action:'inspect',windowId:'w1'},
  {action:'finish',message:'Written'},
];
describe('generic agent action verification',()=>{
  it('reports completed only when exact typed value is observable',async()=>{
    const adapter=makeAdapter(true);
    const result=await runAgent('Type hej into the chat field',adapter as never,async(_g,_o,step)=>plan[step-1],undefined,10);
    expect(result.complete).toBe(true);
  });
  it('does not fake success merely because a snapshot can be read',async()=>{
    const adapter=makeAdapter(false);
    const result=await runAgent('Type hej into the chat field',adapter as never,async(_g,_o,step)=>plan[step-1],undefined,10);
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('inte verifierat');
  });
});
