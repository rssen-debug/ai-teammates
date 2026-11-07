/**
 * MAJIN V4 — voice policy, kept out of the DOM so it can be unit tested.
 *
 * Describes the Web Speech lane only. Foreground MediaRecorder/server STT
 * lives in recorder.js and needs an explicit microphone session. Neither
 * lane promises background listening or physical voice acceptance.
 */
import { t } from './strings.js?v=12';

/** Recognition language follows the phone, defaulting to Swedish. */
export function recognitionLang(navigatorLanguage = 'sv-SE') {
  const lang = String(navigatorLanguage || '').toLowerCase();
  if (lang.startsWith('sv')) return 'sv-SE';
  if (lang.startsWith('en')) return 'en-US';
  return 'sv-SE';
}

/** What the current browser can actually do. */
export function detectVoiceSupport(scope = globalThis) {
  const recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
  const synthesis = Boolean(scope.speechSynthesis && scope.SpeechSynthesisUtterance);
  return {
    recognition: Boolean(recognition),
    synthesis,
    // Capability labels are deliberately precise.
    mode: recognition ? 'tap-to-talk' : 'text-only',
    continuous: false,
    bargeIn: false,
  };
}

/** Error code -> honest, actionable sentence. Empty string = stay silent. */
export function voiceErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return t('voice.blocked');
    case 'no-speech':
      return t('voice.noSpeech');
    case 'audio-capture':
      return t('voice.noMic');
    case 'network':
      return t('voice.needsNetwork');
    case 'aborted':
      return '';
    default:
      return code ? t('voice.error', { code }) : '';
  }
}

/** Auto-send only a final transcript, and never during an active turn. */
export function shouldAutoSend({ finalTranscript, autosend, streaming }) {
  return Boolean(finalTranscript && autosend && !streaming);
}

/** Strip markdown so speech does not read punctuation names aloud. */
export function speechText(text, maxChars = 1200) {
  return String(text || '')
    .replace(/[*`#_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** Play complete WAV segments as they arrive, using the gesture-unlocked iOS
 * element. Only the current segment is decoded; abort releases the stream,
 * element and object URL immediately. A missing done frame is not success.
 */
export async function playNarratorStream({ response, audio, signal, scope = globalThis, onStart = () => {} }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', sequence = 0, complete = false;
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  async function play(bytes) {
    signal.throwIfAborted();
    const url = scope.URL.createObjectURL(new scope.Blob([bytes], { type: 'audio/wav' }));
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true; clearTimeout(timeout);
          signal.removeEventListener('abort', cancel);
          audio.onended = null; audio.onerror = null;
          if (error) { audio.pause(); reject(error); } else resolve();
        };
        const cancel = () => finish(signal.reason || new Error('Aborted'));
        const timeout = setTimeout(() => finish(new Error('Voice segment playback timed out')), 90000);
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('Voice segment playback failed'));
        signal.addEventListener('abort', cancel, { once: true });
        audio.src = url;
        try {
          Promise.resolve(audio.play()).then(() => { if (!settled) onStart(sequence); }).catch(finish);
        } catch (error) { finish(error); }
      });
    } finally { scope.URL.revokeObjectURL(url); }
  }
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Voice frame too large');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (complete) throw new Error('Unexpected data after voice completion');
        const frame = JSON.parse(line);
        if (frame.type === 'done' && frame.chunks === sequence && sequence > 0) { complete = true; continue; }
        if (frame.type !== 'audio' || frame.sequence !== sequence || typeof frame.data !== 'string') throw new Error('Invalid voice stream');
        const encoded = scope.atob(frame.data);
        if (encoded.length < 45 || encoded.slice(0, 4) !== 'RIFF' || encoded.slice(8, 12) !== 'WAVE') throw new Error('Invalid WAV segment');
        const bytes = Uint8Array.from(encoded, (c) => c.charCodeAt(0));
        await play(bytes); sequence += 1;
      }
      if (chunk.done) break;
    }
    if (!complete || buffer.trim()) throw new Error('Incomplete voice stream');
    return { chunks: sequence };
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
