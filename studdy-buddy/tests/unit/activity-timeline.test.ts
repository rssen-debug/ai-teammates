import {describe,it,expect} from 'vitest';
import {ActivityTimeline} from '../../packages/core/src/activity-timeline.js';
function harness(){
  const data=new Map<string,unknown>();
  const store={get:<T>(key:string)=>data.get(key) as T|undefined,
    set:<T>(key:string,value:T)=>{data.set(key,value);}};
  let now=1_000_000;
  return {timeline:new ActivityTimeline(store,()=>now),advance:(ms:number)=>{now+=ms;}};
}
describe('consented local activity history',()=>{
  it('counts continuous foreground time and separates program switches',()=>{
    const h=harness();
    h.timeline.record('Rick and Morty - Chrome','chrome.exe',true);
    h.advance(5000);
    h.timeline.record('Rick and Morty - Chrome','chrome.exe',true);
    expect(h.timeline.recent()[0]?.elapsedMs).toBe(5000);
    h.advance(5000);
    h.timeline.record('Notes','notepad.exe',true);
    expect(h.timeline.recent()).toHaveLength(2);
  });
  it('does not count an unfocused window or a long unobserved gap',()=>{
    const h=harness();
    h.timeline.record('Show','chrome.exe',false);
    expect(h.timeline.recent()).toHaveLength(0);
    h.timeline.record('Show','chrome.exe',true);
    h.advance(120_000);
    h.timeline.record('Show','chrome.exe',true);
    expect(h.timeline.recent()).toHaveLength(2);
    expect(h.timeline.recent()[0]?.elapsedMs).toBe(0);
  });
  it('redacts private window titles and can be cleared locally',()=>{
    const h=harness();
    h.timeline.record('Password Manager - Login','chrome.exe',true);
    expect(h.timeline.recent()[0]?.label).toBe('Privat aktivitet');
    h.timeline.clear();
    expect(h.timeline.recent()).toHaveLength(0);
  });
});
