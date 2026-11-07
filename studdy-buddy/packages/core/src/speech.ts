import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { VoiceSettings } from '@studdy/shared';
import { WindowsNativeProvider, voiceAvailability, toSpokenText } from '@studdy/voice-engine';

/**
 * Speech playback in the CLI process.
 *
 * Owns the child process so the student can STOP playback instantly (a hard
 * requirement). The renderer can only ask; it can never spawn processes.
 */
export class SpeechPlayer {
  private current: ChildProcess | null = null;

  constructor(private readonly platform: string = process.platform) {}

  availability() {
    return voiceAvailability({
      voiceSettings: { enabled: true, provider: 'windows-native' } as VoiceSettings,
      platform: this.platform,
    });
  }

  isSpeaking(): boolean {
    return this.current !== null;
  }

  async speak(text: string, settings: VoiceSettings): Promise<{ ok: boolean; error: string | null }> {
    this.stop();
    const spoken = toSpokenText(text, { language: settings.language }).slice(0, 4000);
    if (!spoken.trim()) return { ok: false, error: 'Ingen text att läsa upp.' };
    let command: string, args: string[];
    if (this.platform === 'win32') {
      ({ command, args } = new WindowsNativeProvider(this.platform).buildCommand({ text: spoken, settings }));
    } else if (this.platform === 'darwin') {
      command = 'say'; args = ['-r', String(Math.round(180 * settings.speed)), spoken];
    } else if (this.platform === 'linux') {
      command = ['espeak-ng', 'espeak'].find(binary => spawnSync(binary, ['--version'], { stdio: 'ignore' }).error === undefined) ?? '';
      if (!command) return { ok: false, error: 'Ingen lokal Linux-röst hittades. Installera espeak-ng eller espeak och försök igen.' };
      args = ['-v', settings.language === 'sv-SE' ? 'sv' : 'en', '-s', String(Math.round(175 * settings.speed)), '-a', String(Math.round(settings.volume * 100)), '--stdin'];
    } else return { ok: false, error: `Lokal uppläsning stöds inte på ${this.platform}.` };

    return new Promise((resolve) => {
      try {
        const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
        child.stdin.on('error', () => { /* child error is reported below */ });
        child.stdin.end(this.platform === 'linux' ? spoken : '');
        this.current = child;
        const timer = setTimeout(() => {
          this.stop();
          resolve({ ok: false, error: 'Uppläsningen tog för lång tid och avbröts.' });
        }, 120_000);

        child.on('error', (err) => {
          clearTimeout(timer);
          this.current = null;
          resolve({ ok: false, error: err.message });
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (this.current === child) this.current = null;
          resolve(code === 0 ? { ok: true, error: null } : { ok: false, error: `Röstprocessen avslutades med kod ${code}.` });
        });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  stop(): void {
    if (!this.current) return;
    try {
      this.current.kill();
    } catch {
      /* process may already be gone */
    }
    this.current = null;
  }
}
