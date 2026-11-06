import { spawn, type ChildProcess } from 'node:child_process';
import type { VoiceSettings } from '@studdy/shared';
import { WindowsNativeProvider, voiceAvailability, toSpokenText } from '@studdy/voice-engine';

/**
 * Speech playback in the main process.
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
    if (this.platform !== 'win32') {
      return { ok: false, error: 'Uppläsning stöds bara på Windows med SAPI-röster.' };
    }
    const provider = new WindowsNativeProvider(this.platform);
    if (!provider.isConfigured()) return { ok: false, error: 'Inga Windows-röster hittades.' };

    // Long answers are spoken in chunks so the student can stop between them and
    // so a single utterance does not block the process for minutes.
    const spoken = toSpokenText(text, { language: settings.language }).slice(0, 4000);
    const { command, args } = provider.buildCommand({ text: spoken, settings });

    return new Promise((resolve) => {
      try {
        const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
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
