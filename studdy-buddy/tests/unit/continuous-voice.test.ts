import { describe, expect, it, vi } from 'vitest';
import { runContinuousVoice, isVoiceStop, likelySpeakerEcho, WindowsContinuousInput, listInstalledWindowsVoices, chooseEnglishNarrator } from '../../packages/cli/src/continuous-voice.js';
import { WindowsNativeProvider } from '../../packages/voice-engine/src/providers.js';
import { voiceSettingsSchema } from '@studdy/shared';

const runtime = () => ({
  services: { db: { checkpoints: { get: (key:string) =>
    key === 'buddy.chat.language.v1' ? 'en-US' : key === 'buddy.voice.style.v1' ? 'documentary' : '', set:vi.fn() } } },
  chat: vi.fn(async (text:string)=>({ok:true,data:{message:{text:'Response for '+text}}})),
  runDesktopGoal: vi.fn(async()=>({complete:false,blocked:true,summary:'Not verified',events:[]})),
});
function input(utterances:string[]) {
  return {
    close:vi.fn(),
    async *listen(){for(const phrase of utterances) yield phrase;},
  };
}
describe('continuous CPU voice through Kilo',()=>{
  it('uses one microphone session for multiple consecutive voice turns', async()=>{
    const rt=runtime(),mic=input(['Hello','Can you teach subnetting','stop voice']);
    const spoken:string[]=[],lines:string[]=[];
    await runContinuousVoice(rt as never,line=>lines.push(line),{
      input:mic,
      playback:{speak:async t=>{spoken.push(t);},stop:vi.fn()},maxTurns:8,
    });
    expect(rt.chat).toHaveBeenCalledTimes(2);
    expect(spoken).toEqual(['Response for Hello','Response for Can you teach subnetting']);
    expect(mic.close).toHaveBeenCalledOnce();
    expect(lines.join(' ')).toContain('mikrofonprocess stoppad');
  });
  it('interrupts speech playback when user speaks again',async()=>{
    const rt=runtime(),mic=input(['first','second','stop voice']);
    const stop=vi.fn(),lines:string[]=[];
    const playback={stop,speak:vi.fn(async()=>await new Promise<void>(resolve=>{
      // Playback stays active until user interruption invokes stop().
      resolvePlayback=resolve;
    }))};
    let resolvePlayback=()=>{};
    const activePlayback={stop:()=>{stop();resolvePlayback();},speak:playback.speak};
    await runContinuousVoice(rt as never,s=>lines.push(s),{input:mic,playback:activePlayback,maxTurns:5});
    expect(rt.chat).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls.length).toBeGreaterThan(0);
    expect(lines.some(x=>x.includes('avbruten'))).toBe(true);
  });
  it('supports hands-free desktop agent tasks but does not invent completion',async()=>{
    const rt=runtime();
    await runContinuousVoice(rt as never,()=>{},{input:input(['buddy do inspect the current window','stop voice']),
      playback:{speak:async()=>{},stop:()=>{}},maxTurns:2});
    expect(rt.runDesktopGoal).toHaveBeenCalledOnce();
    expect(rt.chat).not.toHaveBeenCalled();
  });
  it('auto-selects a real installed male neural narrator before old standard voices',()=>{
    expect(chooseEnglishNarrator(['Microsoft David Desktop','Kokoro Michael (en-US)'])).toBe('Kokoro Michael (en-US)');
    expect(chooseEnglishNarrator(['Microsoft David Desktop'])).toBe('Microsoft David Desktop');
    expect(chooseEnglishNarrator(['Microsoft David Desktop'],'Microsoft David Desktop')).toBe('Microsoft David Desktop');
    expect(chooseEnglishNarrator([])).toBe('');
  });
  it('recognizes voice stop and likely speaker echo',()=>{
    expect(isVoiceStop('stop voice')).toBe(true);
    expect(isVoiceStop('avsluta röst')).toBe(true);
    expect(isVoiceStop('start studying')).toBe(false);
    expect(likelySpeakerEcho('This is the explanation','This is the explanation you need')).toBe(true);
    expect(likelySpeakerEcho('Please go back','I think we should continue studying')).toBe(false);
  });
  it('does not pretend microphone is usable on Linux or Windows voices exist without checking',async()=>{
    expect(await listInstalledWindowsVoices('linux')).toEqual([]);
    const mic=new WindowsContinuousInput('linux');
    await expect(async()=>{for await(const _ of mic.listen()){void _;}}).rejects.toThrow(/Windows/);
  });
  it('selects configured Windows voice and documentary rate in the generated local TTS command',()=>{
    const settings=voiceSettingsSchema.parse({enabled:true,provider:'windows-native',language:'en-US',
      speed:0.7,voiceId:'Microsoft David Desktop'});
    const command=new WindowsNativeProvider('win32').buildCommand({text:'Hello',settings});
    expect(command.command).toBe('powershell.exe');
    expect(command.args.join(' ')).toContain("SelectVoice('Microsoft David Desktop')");
    expect(command.args.join(' ')).toContain('$s.Rate = -2');
  });
});
