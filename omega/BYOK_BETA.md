# Omega BYOK public beta — installation and release limitations

This is a **bring your own key (BYOK)** Windows alpha/beta deployment,
not a validated production release for 1 million users. The user pays their
own AI provider charges and should set limits at that provider. The agent
runs locally; an AI provider still receives prompts sent to its API and
may receive content from explicitly authorized tools.

## Install from trusted repo

Install **Git for Windows** and **Python 3.10–3.13**, clone this repository,
then from repository root run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1
```

The script itself checks it is on Windows, verifies the repository origin,
fetches `main`, chooses the exact immutable SHA, creates a versioned Git
worktree and an isolated Python venv under AppData. It installs required
Python packages if missing and starts Omega. User data remains in the
existing StuddyBuddy directory.

Optional features:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1 -WithVoice
powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1 -WithBrowser
powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1 -DoctorOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1 -NoInstall
```

Run once with `-WithVoice` for mic/STT packages. Voice is off until
explicitly enabled using `/voice on`. For tutoring run `/voice study on`.

## Provider setup

1. Inside Omega, run `/models`.
2. Select `/models 1` for OpenRouter, `/models 2` for OpenCode Go,
   or `/models 3` for existing Kilo.
3. Use `/api openrouter` or `/api go`, paste the API key into Omega, then
   `/testapi`. The key is stored using Windows DPAPI where available.
4. Never share API keys in logs, screenshots, chat transcripts or support
   tickets. Windows terminal input may show the key as you paste it.

The application does not include free unlimited model inference. The
user/provider is responsible for limits, quotas, availability and billing.
No hidden cross-provider fallback should be assumed.

## What is NOT covered by this beta release

- Signed installer, notarized updates, public auto-update channel or rollback.
- Hardware-level Windows E2E on every OS/mic/GPU configuration.
- Real-time latency SLA for voice.
- VM provisioning: VNC is client code only; use a separate guest VM.
- Third-party security audit, supply-chain audit or adversarial testing.
- 1-million-user load and availability benchmarks.
- Guaranteed safety of autonomous file/shell/browser execution.
- Compliance/legal/privacy review for broad public distribution.

Recommended distribution is **limited opt-in beta** with explicit warnings
for machine-control permissions and a documented feedback/bug-report path.
Do not promise GA readiness until the P0–P4 release gates are measured.
