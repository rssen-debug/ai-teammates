# Omega live study voice (experimental)

Use the local Omega Windows CLI:

```text
/voice study on
/voice on
/voice study status
/voice study off
/voice off
```

Voice starts **off** unless a user explicitly enables it. Study mode is
also opt-in and persistent. No microphone data is saved by this feature.

## What works

- Local faster-whisper on the user computer for speech recognition.
- Voice-specific turn routing around the heavyweight tool-planning loop.
- Streaming OpenAI-compatible response with the currently selected model.
- Start synthesizing the first completed sentence **before** the full answer
  is complete; subsequent sentences are spoken sequentially.
- Interruption of playing speech when the user speaks over it, using the
  existing speech amplitude detection and cancellation.
- Compact conversational context from earlier exchanges and optional
  owner-selected text, with no invented claims of reading the NetAcad page.
- Speech error and first-token/sentence-ready timings shown in the Omega UI.

## Not yet guaranteed

- This is a *streaming pipeline*, not a native WebRTC full-duplex speech model.
- Latency depends on CPU Whisper decoding, speech endpointing, network
  round-trip, first-model-token latency and Windows speech synthesis.
- The current first-silence VAD waits around 0.84 s in normal mode.
- Whisper model load on first activation can be slow; subsequent turns avoid it.
- Existing barge-in is amplitude-based and can be triggered by speaker echo.
- **No measured sub-second or 15-second-to-1-second SLA exists.**
- Study mode answers from the selected model and supplied context. To inspect
  an actual NetAcad screen, use authorized agent/screen tools separately.
- Running study voice must not authorize unattended browsing or clicks.

## Windows manual acceptance gate (not covered by CI)

Test on a machine with an actual microphone, speaker and provider API key:

1. Enable mic explicitly, ask 20 NetAcad questions in Swedish, record
   speech-stop→STT, STT→first model token, first token→first spoken audio.
2. Ask a second question while the assistant is speaking: old audio must
   stop and the next utterance must be answered, not queued silently.
3. Use /voice study off. Verify normal full-agent voice handling returns.
4. Stop voice completely. Verify microphone stops and stays off at restart.
5. Run with no API key or network, mic denied and no TTS voice: fail visibly.
6. Check that selected page text is never misrepresented as independently seen.

The mode is experimental until this hardware-level acceptance passes.
