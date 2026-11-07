# MAJIN V1 voice engine — reuse-first integration decision

## Decision (22 October 2026)
Do NOT rewrite a full-duplex voice stack from scratch. Evaluate **OpenLive** first (https://github.com/katipally/openlive), followed by LiveKit Agents, Pipecat and sherpa-onnx for narrower components. The existing MAJIN UI remains the product. Do not replace its agent/router/tool layers wholesale.

### Existing MAJIN implementation
- src/ui/app.js uses browser SpeechRecognition, browser speechSynthesis and optional local Kokoro TTS.
- Voice-state bugs observed: microphone shutoff during TTS, missing barge-in, repeated no-speech shutdown, stuck Thinking without inactive-stream watchdog.
- PR #393 provides incremental guards, but a browser SpeechRecognition loop is NOT yet proven to be reliable acoustic full-duplex voice. CI is not real microphone/speaker testing.

### Component choices (evaluate, do not claim integration)
1. **OpenLive** Apache-2.0 + NOTICE: primary reference for local desktop voice, WebRTC/audio I/O, VAD, streaming transcripts, speech interruption, voice permission questions, agent protocol interoperability (OpenCode / ACP), and UI status transitions.
2. **LiveKit Agents**: alternative backend for realtime speech sessions and turn detection, with additional service/runtime complexity.
3. **Pipecat**: optional Python conversational-pipeline runtime; avoid forcing Python for MAJIN default Windows installer before evaluating packaging.
4. **sherpa-onnx** Apache-2.0: local STT/TTS/VAD adapters on Windows/Node; evaluate CPU/RAM usage and Swedish models before adoption.

### Licensing and safety
Respect upstream license/NOTICE files and preserve third-party notices. Do not copy unrelated UI assets, logos, or brand identity. Get user consent before recording/transmitting microphone or desktop content. No automatic cloud audio upload. Keep machine actions gated by MAJIN's existing approvals.

### Adapter seam — architecture
- voiceTransport: capture/render audio, device permissions, PCM/frames, AEC where available
- voiceTurn: VAD, speech/endpoint detection, optional wake phrase, acoustic echo suppression
- speechToText: Swedish streaming transcript and language selection
- conversation: existing MAJIN task/session, cancel/replace goal with confirmed stop, context references
- textToSpeech: low-latency segmented audio, cancel/pause and resume
- events: listening/thinking/speaking/interrupted/error to current MAJIN orb

### Acceptance gates before shipping new default
1. First microphone permission, silence, offline, and audio-device errors never strand UI.
2. Can interrupt TTS by voice without clicking, and next spoken turn is retained.
3. Audio played from MAJIN speakers must not trigger recursive assistant responses.
4. Can say “sök fem jobb ... nej vänta, öppna fyra ... skapa en sida istället” without invoking stale tasks or losing referents.
5. Measure mic onset->TTS pause, end of speech->first reply audio, CPU and memory on Windows CPU-only PC, and monitor 20-minute session stability.
6. Test both sv-SE and en-US, headphones AND loudspeakers, 1 and 2 audio devices; include manual Windows hardware QA.
7. Compare demo and baseline latencies. Any unverified claims remain NOT_TESTED.
8. Maintain a toggle to fall back to original speech pipeline; prevent breaking offline typing.

### Next implementation
Build a thin voice engine adapter with a local capability probe and feature flag. Port **small, license-compliant parts** only after dependencies, binaries, audio permissions, and installer impact are verified. Use contract tests with fake PCM frames AND manual Windows tests.
