/** Foreground-only voice capture. One stream, 20 Hz VAD, bounded utterances.
 * Each upload is a complete container: individual MediaRecorder chunks are
 * not standalone MP4 files. Never restart permission requests in a loop.
 */
import { t } from './strings.js?v=12';

export function recordingType(Recorder) {
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((type) => Recorder.isTypeSupported?.(type)) || '';
}

export class VoiceActivity {
  constructor() { this.reset(); }
  reset(now = 0) { this.started = now; this.lastVoice = now; this.loudSince = null; this.speaking = false; }
  update(level, now) {
    let onset = false;
    if (level > 0.025) {
      this.loudSince ??= now;
      this.lastVoice = now;
      if (!this.speaking && now - this.loudSince >= 180) { this.speaking = true; onset = true; }
    } else this.loudSince = null;
    return { onset, end: this.speaking && (now - this.lastVoice > 800 || now - this.started > 20000) };
  }
}

export class VoiceCapture {
  constructor({ scope = globalThis, onSegment, onSpeech = () => {}, onState = () => {}, onError = () => {} }) {
    Object.assign(this, { scope, onSegment, onSpeech, onState, onError });
    this.active = false; this.generation = 0;
  }
  async start() {
    if (this.active) return;
    const s = this.scope; const generation = ++this.generation;
    this.active = true; this.onState('requesting');
    try {
      const Context = s.AudioContext || s.webkitAudioContext;
      this.context = new Context();
      const resumed = this.context.resume().catch((err) => err);
      this.oldSession = s.navigator.audioSession?.type;
      if (s.navigator.audioSession) { try { s.navigator.audioSession.type = 'play-and-record'; } catch {} }
      const stream = await s.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!this.active || generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const resumeError = await resumed;
      if (resumeError instanceof Error) throw resumeError;
      if (!this.active || generation !== this.generation) return;
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 1024;
      this.source.connect(this.analyser); // no speaker connection: never monitor the microphone
      this.samples = new Float32Array(this.analyser.fftSize);
      this.activity = new VoiceActivity();
      this.lastSpeech = Date.now();
      for (const track of stream.getTracks()) track.onended = () => this.stop();
      this.record();
      this.timer = s.setInterval(() => this.sample(), 50);
      this.onState('listening');
    } catch (err) { if (this.active && generation === this.generation) { this.stop(); this.onError(err); } }
  }
  record() {
    if (!this.active) return;
    const generation = this.generation;
    const s = this.scope; const parts = []; let bytes = 0;
    const type = recordingType(s.MediaRecorder);
    const recorder = new s.MediaRecorder(this.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 64000 });
    this.recorder = recorder; this.activity.reset(Date.now());
    recorder.ondataavailable = (e) => {
      bytes += e.data.size;
      if (bytes > 4 * 1024 * 1024) { this.stop(); this.onError(new Error(t('voice.capture.size'))); }
      else if (e.data.size) parts.push(e.data);
    };
    recorder.onerror = () => { this.stop(); this.onError(new Error(t('voice.capture.interrupted'))); };
    recorder.onstop = async () => {
      if (!this.active || this.recorder !== recorder) return;
      const hadSpeech = this.activity.speaking;
      this.recorder = null;
      try {
        if (hadSpeech && parts.length) {
          this.onState('transcribing');
          await this.onSegment(new s.Blob(parts, { type: recorder.mimeType || type }));
        }
        if (this.active && generation === this.generation) { this.record(); this.onState('listening'); }
      } catch (err) { if (this.active && generation === this.generation) { this.stop(); this.onError(err); } }
    };
    recorder.start(250);
  }
  sample() {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.lastSpeech > 60000) { this.stop(); return; }
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.analyser.getFloatTimeDomainData(this.samples);
    const rms = Math.sqrt(this.samples.reduce((sum, n) => sum + n * n, 0) / this.samples.length);
    const { onset, end } = this.activity.update(rms, now);
    if (this.activity.speaking) this.lastSpeech = now;
    if (onset) this.onSpeech();
    // Rotate silent containers every 20s; release the complete idle session at 60s.
    if (end || now - this.activity.started > 20000) this.recorder.stop();
  }
  stop() {
    this.active = false; this.generation += 1;
    this.scope.clearInterval(this.timer); this.timer = null;
    const rec = this.recorder; this.recorder = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch {} }
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); }); this.stream = null;
    this.source?.disconnect(); this.source = null;
    this.context?.close().catch(() => {}); this.context = null;
    if (this.oldSession && this.scope.navigator.audioSession) { try { this.scope.navigator.audioSession.type = this.oldSession; } catch {} }
    this.onState('idle');
  }
}
