import { spawn } from 'node:child_process';
import { SpeechPlayer, type StuddyRuntime } from '@studdy/core';
import { voiceSettingsSchema } from '@studdy/shared';

const ASR_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$available=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()',
  'if($available.Count -eq 0){Write-Output "NO_RECOGNIZER";exit 3}',
  '$culture=[System.Globalization.CultureInfo]::GetCultureInfo("en-US")',
  '$recognizer=$available | Where-Object {$_.Culture.Name -eq $culture.Name} | Select-Object -First 1',
  'if($null -eq $recognizer){$recognizer=$available[0]}',
  '$engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)',
  'try {',
  '  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '  $engine.SetInputToDefaultAudioDevice()',
  '  $result=$engine.Recognize([TimeSpan]::FromSeconds(8))',
  '  if($null -eq $result){Write-Output "NO_SPEECH"}',
  '  elseif($result.Confidence -lt 0.42){Write-Output "LOW_CONFIDENCE"}',
  '  else { Write-Output ("HEARD:"+$result.Text) }',
  '} finally {$engine.Dispose()}',
].join(';');

export type SpeechCapture = { text: string | null; error: string | null };
/** Windows system recognizer, not Kilo audio input. Does not upload microphone PCM. */
export async function recognizeWindowsSpeech(platform=process.platform): Promise<SpeechCapture> {
  if (platform !== 'win32') return { text:null, error:'Windows taligenkänning är inte tillgänglig på den här datorn.' };
  return new Promise(resolve => {
    const command = Buffer.from(ASR_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command],
      { windowsHide:true, shell:false, stdio:['ignore','pipe','pipe'] });
    let stdout='',stderr='',settled=false;
    const done=(r:SpeechCapture)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(r);};
    const timer=setTimeout(()=>{child.kill();done({text:null,error:'Mikrofonen svarade inte inom tidsgränsen.'});},16000);
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout=(stdout+chunk).slice(-4000);});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-1000);});
    child.once('error',e=>done({text:null,error:e.message}));
    child.once('close',code=>{
      const line=stdout.trim().split(/\r?\n/).at(-1)??'';
      if(code!==0)done({text:null,error:'Windows röstigenkänning kunde inte startas: '+(stderr.trim().slice(0,130)||line)});
      else if(line.startsWith('HEARD:'))done({text:line.slice(6).slice(0,600),error:null});
      else done({text:null,error:line==='NO_SPEECH'||line==='LOW_CONFIDENCE'?null:line||'Inget ljud uppfattades.'});
    });
  });
}
export async function runVoiceMode(
  runtime: StuddyRuntime,
  say: (line: string)=>void,
  options: { capture?:()=>Promise<SpeechCapture>; speak?: (text:string)=>Promise<void>; maxTurns?:number }={},
):Promise<void> {
  // Only the *real* microphone needs the grant. An injected capture (tests, or a
  // different audio source) is not the microphone and must not be blocked.
  if(!options.capture && !runtime.services.permissions.isGranted('microphone')){
    say('○ Mikrofonen är inte tillåten. Kör /access microphone on och försök igen.');
    return;
  }
  const player=new SpeechPlayer();
  const settings=voiceSettingsSchema.parse({ enabled:true,provider:'windows-native',
    language:runtime.services.db.checkpoints.get<string>('buddy.chat.language.v1')==='en-US'?'en-US':'sv-SE' });
  const speak=options.speak??(async text=>{const result=await player.speak(text,settings);
    if(!result.ok) say('Röstuppspelning: '+result.error);});
  say('● VOICE · Windows-mikrofon → Kilo-chatt → Windows-röst · halvduplex');
  say('Prata när mikrofonen lyssnar. Säg "stop voice" för att avsluta. Ingen permanent inspelning.');
  let silent=0;
  try {
    for(let turn=0;turn<Math.min(30,options.maxTurns??12);turn++){
      say('○ Lyssnar (upp till 8 sekunder)...');
      const heard=await (options.capture??recognizeWindowsSpeech)();
      if(heard.error){say('Röstfel: '+heard.error);break;}
      if(!heard.text){if(++silent>=3){say('Ingen röst upptäckt. Avslutar /voice.');break;}continue;}
      silent=0;
      say('du 🎤 › '+heard.text);
      if(/^(stop voice|exit voice|avsluta röst|stopp röst)$/i.test(heard.text.trim()))break;
      const result=await runtime.chat(heard.text);
      const response=result.ok?result.data.message.text:result.error.message;
      say('studdy › '+response);
      await speak(response.slice(0,1600));
    }
  } finally { player.stop();say('○ VOICE avslutad.'); }
}
