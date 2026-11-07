# MAJIN voice: GitHub research and integration (2026-10-21)

The user wants to talk naturally while a TV is playing, without a local GPU, and to keep the single expressive orb.

## Existing open-source systems worth adopting

- **ricky0123/vad** — https://github.com/ricky0123/vad — browser-side Silero VAD + ONNX runtime Web. Correct dependency for speech on/off and a more reliable end-of-turn signal. This is NOT speaker identification. Bundle JS/WASM/ONNX locally, pin the package version and verify licensing; do not load arbitrary latest CDN scripts at runtime.
- **TigreGotico/speakeronnx** — https://github.com/TigreGotico/speakeronnx — CPU-compatible speaker embeddings + cosine comparison. Requires explicit enrollment with 5–30 seconds of the user's speech, local model assets, a secure local audio bridge, opt-in storage and a delete-profile action. Avoid assuming similarity thresholds generalize to TV/background without calibration. Not integrated in this PR.
- **livekit/agents** — https://github.com/livekit/agents — real-time agent sessions and semantic end-of-turn; their complete Python server stack is not a drop-in browser widget. Turn-detector inference and its model licenses require assessment.
- **pipecat-ai/pipecat** — https://github.com/pipecat-ai/pipecat — complete realtime audio pipelines; useful reference for interruption and speech streaming. Replacing MAJIN's agent engine is not necessary.

## What this PR does now

- Adds a CPU-light foreground-proximity heuristic with an adaptive ambient baseline, exposed as a standalone UI script and tested.
- Couples browser transcripts to recently observed near-mic acoustic activity; stops ineligible transcripts instead of dispatching TV noise.
- Fixes mismatch wake-word handling that previously could leave the microphone hanging indefinitely.
- Keeps clear, honest UI feedback. **It does not claim biometric speaker identification, Silero VAD, or ChatGPT Voice parity.**

## Required next production-quality integration

1. Bundle **@ricky0123/vad-web** and ONNX WASM/models within the packaged Windows application's UI directory; expose speech start/end through a tested adapter rather than a CDN.
2. Feed VAD decisions into the existing voice turn state machine, and stop dispatching transcript guesses on timer alone. Handle ASR partials, finals, end-of-turn and 12s idle limit separately.
3. Add opt-in voice enrollment and CPU ONNX embeddings (speakeronnx or equivalent); test multiple recordings with TV speech, reverberation, and overlapping voices; allow the user to disable/delete the profile.
4. Add echo cancellation and true audio barge-in to the TTS path. Web Speech API alone does not provide reliable audio output levels or conversational full duplex.
5. Run tests on an actual Windows microphone and speakers: whisper/normal speech, Swedish and English, TV at realistic volume, long quiet periods, interrupted speech, headphones vs speakers, device hotplug, and stopped microphone permissions. Measure false triggers, missed commands, response-start latency and audio output.
6. Gate release on measurable acceptance evidence. Never label a heuristic as voice identity.

## Security / UX

Microphone audio and speaker profiles are personal data. Prefer on-device processing. Do not automatically persist speech audio, and provide clear consent and an erase option if enrollment is implemented. Nothing in this note authorizes recording the user's TV or other speakers.
