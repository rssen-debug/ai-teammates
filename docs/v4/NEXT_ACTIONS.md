# MAJIN V4 — next actions

Ordered by user value, not by elegance. Each item names the evidence that would
earn its matrix points.

## 0. Where the project stands now (2026-10-23)

The universal-agent integration is done and verified in this environment
(`PROGRESS.md` → "Universal-agent integration"; `TEST_EVIDENCE.md` §5). What
remains is **not more code** — it is proof on your machine and phone.

One command does the install and the acceptance run:

```powershell
cd C:\MAJINCLI
git pull
npm ci
npm run v4:setup -- --autostart --accept --release-url https://<release-base> --auto-update
```

Then send back two outputs:

```powershell
npm run v4:tools -- --probe
npm run v4:accept -- --url https://<your-address> --write
```

What each result would settle:

| Result | Matrix movement |
|---|---|
| `--probe` executes `control_list_windows`, `exec_start`, `sys_info`, `shell_env`, `net_dns`, `re_hash` | Windows tool lanes move from "structural" to verified (H1/H2 support) |
| `v4:e2e` passes on a host with Edge/Chromium | M11, G8 |
| `v4:accept` with a public URL from the phone | H3, H4, M10 |
| a real turn through your provider | A7 |
| the update task's log line `[updated]` after a release | automatic updates (no matrix row; reported in STATUS) |

## 1. First real private release (blocking, owner action)

- [ ] Run `scripts/v4/install-v4-windows.ps1 -AutoStart` on the Windows PC.
- [ ] Create the Cloudflare Tunnel + Access app (`DEPLOYMENT.md` §3–4).
- [ ] Set `MAJIN_V4_PUBLIC_ORIGIN` and `MAJIN_V4_TRUST_PROXY=1`.
- [ ] Open the URL on iPhone Safari **and** Android Chrome; run the §5 scenario.
- [ ] Append the observed results to `TEST_EVIDENCE.md`, then flip matrix
      `H3`, `H4`, `M10` to VERIFIED (or leave them unearned if they fail).

## 2. Real inference from the phone (blocking for product value)

- [ ] Confirm V1 config is readable from the V4 process (`npm run v4:doctor`).
- [ ] Send a turn with a selected model; capture the `liveVerified` flip.
- [ ] Add an explicit error surface when a provider key is revoked mid-session.
- [ ] Then flip `A7`.

## 3. Streaming polish and interruption

- [ ] Abort the upstream model request on cancel (currently the SSE closes and the
      turn is marked `CANCELLED`; the provider fetch is passed the signal but this
      needs a test with a slow endpoint).
- [ ] `G6` failure simulation: a tool that times out, one that returns bad output.
- [ ] `C8`: mid-task correction that re-plans the current goal instead of starting over.

## 4. Voice, measured

- [ ] Measure time-to-first-audio and barge-in stop latency on a real phone.
- [ ] Decide browser-native voice vs. V2 server-side TTS/STT; write the decision down.
- [ ] Wire `src/v2/voice/*` behind a flag only if it beats the browser on latency.

## 5. Platform hardening

- [ ] Process-level plugin sandbox (`P6`) — child process, no fs, explicit IPC.
- [ ] Quarantine directory for failed plugins (`P5`).
- [ ] Continuous benchmark harness (`P7`): task success, latency, cost, memory accuracy.
- [ ] Passkeys as a second auth factor (replacing the pairing code for daily use).

## 6. Deferred on purpose

Desktop control, browser automation, multi-agent swarms and always-listening
microphones are **not** started. Each needs its own evidence gate, approval
model and Windows session handling before it may exist. Adding stubs would
break the repo's honesty rule.
