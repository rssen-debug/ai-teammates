# MAJIN V3 known limitations

**Checkpoint:** first local vertical slice; date 2026-10-22.

## Works now (narrow scope)

- A local, deterministic request can create one new file in an explicitly supplied workspace.
- The V3 wrapper reuses the existing V2 Goal state machine, acceptance gate, receipt model and independent file verifier.
- The file is checked against its SHA-256 before the goal can complete; existing files are never overwritten.
- A loopback preview page returns the real result and digest. It has inline assets, labeled fields, visible focus rules, a reduced-motion rule and no external network assets.
- Seven V3 unit/integration checks cover the success flow, rejection, no-overwrite behavior, request-size limits and loopback API/UI path.

## Not implemented / not proven

- No V3 conversational LLM planning, streaming chat, model selection or provider-key onboarding.
- No V3 browser automation, desktop control, Windows accessibility API, app launching or live real-site/browser acceptance.
- No real-time microphone capture, VAD, streaming STT/TTS, true barge-in, Swedish/English voice acceptance, echo suppression or audio reconnection.
- No general-purpose tool router, permission UI, approval broker, multi-agent scheduler or user interruption/replanning loop.
- No V3 memory migration/retrieval, correction, deletion/export UI or retention controls.
- No crash/restart fault injection or deduplication proof beyond the V2 Goal persistence contract used by the single slice.
- No production CLI integration, installer, executable, updater, clean Windows install, or release artifacts.
- The UI is a local proof surface, not the finished conversational product. The first task requires the user to provide content explicitly; it does not generate content with a model.
- Browser-rendered accessibility and visual behavior were not run in a browser during this round. Static/source tests are not equivalent to visual/assistive-technology acceptance.
- Real Windows desktop/voice/browser validation was unavailable in this Linux sandbox.
- Node `>=22.0.0` is aligned across package/lock, install preflights, doctor, V3 runtime and V3 CI. The clean locked install, full suite, syntax scan and i18n scan pass on Node `22.23.4`. Windows installer/doctor behavior has not been executed on a Windows host, and the GitHub workflow itself has not run remotely.
- Push was attempted without credentials and failed because Git could not read a GitHub username with terminal prompts disabled. Remote `v3/main` is still not published. This environment has no GitHub connector. Do not use the chat-exposed credentials; revoke/rotate them and use a secure auth path.
