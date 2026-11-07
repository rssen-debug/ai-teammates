# MAJIN v1.0.1 release acceptance

This document distinguishes CI-proven behavior from outstanding interactive desktop evidence. **A green workflow is never equivalent to a person-operated Windows desktop being verified.**

## Verified on PR #208

- **Real OpenCode Go inference:** a GitHub-hosted runner with the repository's Go secret obtained live outputs for GLM-5.3-Flash (Chat Completions), Qwen3.8-Flash (Anthropic Messages), and Grok 4.6 (Responses API). The same live test verified a Qwen `qa_echo` tool call; another Go live smoke verified a GLM tool call. Three wire protocols passed.
- **Provider routing:** session-stable `x-opencode-session` across steps, distinct session IDs per conversation, and no silent Go/Zen-to-DeepSeek fallback.
- **Real Windows automated UI:** Playwright Chromium exercised the running MAJIN server, model picker, persisted routing, small/wide layouts, request errors and update controls.
- **Windows runtime and installer:** GitHub Windows runner compiled a fresh executable and Inno Setup installer, installed it, launched its installed executable, uninstalled and reinstalled; recorded build SHA256.
- **Windows JS suite:** 909 total tests, 889 pass, zero fail, 20 skipped as reported by the runner. The earlier 17 Windows-only file URL path failures were fixed.
- **Offline Go protocol tests:** fast CI passed with mocked HTTP responses, streaming tools, missing-key behavior, and fail-closed responses.

## Not verified by those CI passes

- W11 agent-driven, real graphical desktop interaction, and W12 pink-cursor visual interaction in a genuine interactive Windows session are **NOT VERIFIED** by service-session runners.
- Exhaustive live checks of every Go catalog model, every account tier, and third-party login/provider capability are **NOT VERIFIED**. The documented three protocol families were sampled with real models.
- End-to-end automatic update delivery to an already installed end-user machine must be separately observed after v1.0.1 publication. CI verifies release scripts and update UI behavior, not every user's update installation.

## Deployment rule

Publishing v1.0.1 requires merging the validated code to `main` and receiving a green `build-exe` workflow on that branch. `package.json` and `package-lock.json` must both declare `1.0.1`; a new GitHub release with the MAJIN-Setup.exe and checksum assets is required for users to see the update.

This is a transparent patch release candidate, **not** evidence of a blanket 100/100 interactive desktop certificate.
