import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SpeechPlayer, type StuddyRuntime } from '@studdy/core';
import { voiceSettingsSchema } from '@studdy/shared';

export interface VoiceInput {
  listen(): AsyncIterable<string>;
  close(): void;
}
export interface VoicePlayback {
  speak(text: string): Promise<void>;
  stop(): void;
}
export type VoiceStatus = (line: string) => void;

/** A single, long-lived Windows recognizer. No PCM files, no microphone audio
 * sent to Kilo, no recognizer restart per sentence. Microphone is live only
 * while the user is explicitly in /voice. System.Speech availability varies
 * with installed Windows speech languages and devices.
 */
const SCRIPT = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$installed=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()',
  'if ($installed.Count -eq 0) { Write-Output "ERROR:NO_RECOGNIZER"; exit 3 }',
  '$en=$installed | Where-Object { $_.Culture.Name -eq "en-US" } | Select-Object -First 1',
  'if ($null -eq $en) { $en=$installed[0] }',
  '$r=New-Object System.Speech.Recognition.SpeechRecognitionEngine($en)',
  'try {',
  '  $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '  $r.SetInputToDefaultAudioDevice()',
  '  Write-Output "READY"',
  '  [Console]::Out.Flush()',
  '  Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -SourceIdentifier BuddySpeech | Out-Null',
  '  $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
  '  while ($true) {',
  '    $event=Wait-Event -SourceIdentifier BuddySpeech -Timeout 1',
  '    if ($null -eq $event) { continue }',
  '    $heard=$event.SourceEventArgs.Result',
  '    Remove-Event -EventIdentifier $event.EventIdentifier',
  '    if ($null -ne $heard -and $heard.Confidence -ge 0.42 -and $heard.Text) {',
  '      $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($heard.Text))',
  '      Write-Output ("HEARD:"+$encoded)',
  '      [Console]::Out.Flush()',
  '    }',
  '  }',
  '} finally { try { $r.RecognizeAsyncCancel() } catch {}; Unregister-Event -SourceIdentifier BuddySpeech -ErrorAction SilentlyContinue; $r.Dispose() }',
].join('\n');

export class WindowsContinuousInput implements VoiceInput {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly platform: string;
  constructor(platform=process.platform) { this.platform=platform; }
  async *listen(): AsyncIterable<string> {
    if (this.platform!=='win32') throw new Error('Live voice kräver Windows System.Speech på den här versionen.');
    if (this.child) throw new Error('Mikrofonen används redan av Buddy.');
    const cmd=Buffer.from(SCRIPT,'utf16le').toString('base64');
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',cmd],
      {windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stdin.end();
    let errorText='', closed=false, ready=false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',(chunk:string)=>{errorText=(errorText+chunk).slice(-500);});
    child.once('error',()=>{closed=true;});
    child.once('close',()=>{closed=true;});
    const lineReader=createInterface({input:child.stdout,crlfDelay:Infinity});
    try {
      for await (const line of lineReader) {
        if (line==='READY'){ready=true;continue;}
        if (line.startsWith('ERROR:')) throw new Error('Windows taligenkänning: '+line.slice(6,140));
        if (!line.startsWith('HEARD:')) continue;
        const text=Buffer.from(line.slice(6),'base64').toString('utf8').trim().slice(0,700);
        if (text && ready) yield text;
      }
      if (!closed && !ready) throw new Error('Windows mikrofon kunde inte öppnas.');
      if (!ready) throw new Error('Taligenkänning kunde inte starta. '+errorText.slice(0,180));
    } finally {
      lineReader.close();
      this.close();
    }
  }
  close():void { const child=this.child; this.child=null; if(child && !child.killed) child.kill(); }
}
export async function listInstalledWindowsVoices(platform=process.platform):Promise<string[]>{
  if(platform!=='win32')return [];
  const command=Buffer.from([
    'Add-Type -AssemblyName System.Speech',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try { $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name } } finally { $s.Dispose() }',
  ].join('\n'),'utf16le').toString('base64');
  return new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command],
      {windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
    let body='',done=false;
    const finish=(names:string[])=>{if(done)return;done=true;clearTimeout(timer);resolve(names);};
    const timer=setTimeout(()=>{child.kill();finish([]);},6000);
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{body=(body+chunk).slice(0,4000);});
    child.once('error',()=>finish([]));
    child.once('close',code=>finish(code===0?body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,25):[]));
  });
}
/** Prefer an installed neural narrator if available. Never invent voices or
 * silently install an unsigned binary into the user's Windows account. */
export function chooseEnglishNarrator(available:string[],preferred=''):string {
  if(preferred && available.includes(preferred))return preferred;
  const priorities=[
    /kokoro michael/i,
    /kokoro.*(?:male|english)/i,
    /(?:neural|natural).*(?:male|english|en-us)/i,
    /microsoft david/i,
    /microsoft mark/i,
    /english/i,
  ];
  for(const pattern of priorities){
    const match=available.find(voice=>pattern.test(voice));
    if(match)return match;
  }
  return available[0]??'';
}
export const isVoiceStop=(text:string)=>/^(?:stop|stop voice|exit voice|end voice|avsluta|avsluta röst|stopp|stopp röst)$/i.test(text.trim());
const normalize=(s:string)=>s.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N} ]/gu,'').trim();
/** Heuristic acoustic-echo guard, not a claim to perfect echo cancellation. */
export function likelySpeakerEcho(input:string, lastOutput:string):boolean {
  const a=normalize(input),b=normalize(lastOutput);
  return a.length>=9 && b.length>=9 && (b.includes(a) || (a.length>25 && a.slice(0,25)===b.slice(0,25)));
}

export async function runContinuousVoice(
  runtime: Pick<StuddyRuntime,'chat'|'runDesktopGoal'> & { services: StuddyRuntime['services']; chatWithScreen?: StuddyRuntime['chatWithScreen']; voiceScreenContext?: StuddyRuntime['voiceScreenContext'] },
  status: VoiceStatus,
  options: { input?: VoiceInput; playback?: VoicePlayback; maxTurns?:number }={},
):Promise<void>{
  // The microphone permission is now enforced, not decorative. Without it the
  // mode stops with a clear instruction instead of silently listening.
  if(!options.input && !runtime.services.permissions.isGranted('microphone')){
    status('○ Mikrofonen är inte tillåten. Kör /access microphone on (eller /access all) och försök igen.');
    return;
  }
  const input=options.input??new WindowsContinuousInput();
  const player=options.playback??new SpeechPlayer();
  // This is an English-first voice product. The text model receives the same
  // English preference; local CPU voices are selected from actual SAPI inventory.
  runtime.services.db.checkpoints.set('buddy.chat.language.v1','en-US');
  const installed=options.playback ? [] : await listInstalledWindowsVoices();
  const preferred=runtime.services.db.checkpoints.get<string>('buddy.voice.voiceId.v1')??'';
  const voiceId=options.playback ? preferred : chooseEnglishNarrator(installed,preferred);
  // Neural voice by default: it is what makes the assistant sound like a person
  // without any key or download. The stored choice can pin either engine.
  const chosenProvider=runtime.services.db.checkpoints.get<string>('buddy.voice.provider.v1');
  const provider=chosenProvider==='windows-native'?'windows-native':'windows-neural';
  const settings=voiceSettingsSchema.parse({
    enabled:true,provider,language:'en-US',
    speed:runtime.services.db.checkpoints.get<string>('buddy.voice.style.v1')==='normal'?1.04:0.92,
    voiceId:provider==='windows-neural'?preferred:voiceId,
  });
  status(provider==='windows-neural'
    ? '● Röst: neural ('+(preferred||'standard')+') · kräver nät · fallback till SAPI om det misslyckas'
    : '● Röst: '+(voiceId||'Windows SAPI')+' · fungerar offline');
  const speaking=options.playback??{
    stop:()=>player.stop(),
    speak:async(text:string)=>{
      const result=await (player as SpeechPlayer).speak(text,settings);
      if(!result.ok)status('Röstuppspelning: '+result.error);
    },
  };
  let lastOutput='', pending:Promise<void>|null=null, turns=0, lastWasSpeaking=false;
  const bound=Math.max(1,Math.min(options.maxTurns??60,150));
  status('● LIVE VOICE · mikrofon aktiv · Windows CPU-tal ↔ Kilo ↔ Windows-röst');
  status('Prata normalt. Buddy använder verifierad skärmkontext när den kan läsas. Säg "stop voice" för att avsluta.');
  try {
    for await (const heard of input.listen()) {
      if(isVoiceStop(heard)){status('○ Röstläge stoppat med röstkommando.');break;}
      if(lastWasSpeaking && likelySpeakerEcho(heard,lastOutput))continue;
      if(pending){
        speaking.stop(); // Actual interruption, not a fake notification.
        await pending.catch(()=>{});
        pending=null;
        status('↪ Buddy avbruten · lyssnar på dig');
      }
      lastWasSpeaking=false;
      status('du 🎤 › '+heard);
      if(++turns>bound){status('Sessionens turgräns nådd.');break;}
      // Explicit remembered facts only, never automatic long-term recording
      // of what happens to be on the user's screen.
      const remember=/^(?:buddy[,]?\s*)?(?:remember that|remember|kom ihåg att)\s+(.{3,160})$/i.exec(heard);
      if(remember){
        const saved=runtime.services.memory?.rememberProfile(remember[1]!);
        const reply=saved?'I saved that preference to your Obsidian profile.':
          'I could not save that memory; check it contains no secrets.';
        status('studdy › '+reply);
        lastOutput=reply;lastWasSpeaking=true;
        pending=speaking.speak(reply).catch(error=>status('Röstfel: '+String(error).slice(0,160))).finally(()=>{pending=null;});
        continue;
      }
      const command=/^(?:buddy[,]?\s*)?(?:do|gör)\s+(.{3,600})$/i.exec(heard);
      let response='';
      if(command){
        const report=await runtime.runDesktopGoal(command[1]!,e=>
          status((e.ok?'● ':'○ ')+e.action+' · '+e.detail));
        response=report.summary;
      }else{
        const result=await (runtime.chatWithScreen ? runtime.chatWithScreen(heard) : runtime.chat(heard));
        response=result.ok?result.data.message.text:result.error.message;
      }
      if(!response.trim())continue;
      lastOutput=response.slice(0,1600);
      status('studdy › '+lastOutput);
      lastWasSpeaking=true;
      pending=speaking.speak(lastOutput).catch(error=>{
        status('Röstfel: '+String(error).slice(0,160));
      }).finally(()=>{pending=null;});
    }
  } finally {
    input.close();
    speaking.stop();
    await pending?.catch(()=>{});
    status('○ VOICE av · mikrofonprocess stoppad.');
  }
}
