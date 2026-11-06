# WINDOWS_PROOF

The rule this document exists to enforce: **"Arena says it works" is not evidence.**
A green checkmark from a machine that has no Windows, no display, no browser and no
Packet Tracer proves nothing about a student double-clicking an installer.

So the product proves itself instead. This file lists exactly what must be observed,
where the observation is stored, and what counts as failure — and the CI job
`Windows launch proof` refuses to pass without it.

---

## 1. What the pipeline already produces

| Job | Runner | Produces | Fails when |
| --- | --- | --- | --- |
| `verify` | ubuntu + windows | lint, typecheck, 297 tests, renderer + main bundles | any test or type error |
| `package` | windows-latest | `studdy-buddy/dist/win/*.exe` (NSIS) | electron-builder exits non-zero |
| `proof` | windows-latest | `evidence/` artifact: `smoke.log`, `installer-info.txt`, study DB | **the app does not start, the renderer never reports, or the mascot element is missing** |

The `proof` job installs the app like a student would, launches the real
`electron.exe`, and the app itself prints what it found:

```
[bridge] Brygga lyssnar på ws://127.0.0.1:8765 (endast denna dator).
[smoke] window visible: true
[smoke] renderer loaded: true
[smoke] bridge running: true on port 8765
[smoke] renderer probe: {"title":"Studdy Buddy","mascot":true,"readinessButton":true}
```

That output is the first *evidence* in this project that a window exists. The
`STUDDY_SMOKE_EXIT_MS` hook that produces it is inert unless the variable is set, so
normal use is unaffected.

## 2. What only a human can verify (and how to record it)

Run these on the Windows machine, in order, and paste the result next to each line.
Anything without a recorded observation stays BLOCKED in `BUILD_STATUS.md` — that is
the deal.

### A. Install and launch
1. Run the `.exe` from the proof artifact. Does SmartScreen appear? (Expected until
   the build is code-signed; note it.)
2. Does the monkey appear on the desktop after install?
3. Drag it. Restart the app. Is it in the same place?
4. Set display scaling to 150 %, repeat steps 2–3, then 200 %.

### B. First-run configuration
5. Settings → AI provider: endpoint, model id (`deepseek-flash` for the official API),
   key. Press *Testa anslutning*.
6. Press *Testa funktioner*. Which of text / streaming / JSON / vision / tools came
   back true? Record what it reported, not what you hoped.
7. Ask one question. Does a short answer appear in the bubble (2–4 sentences)?

### C. Any course site (this is the point)
8. Settings → Webbläsare: add the site you actually study on. Copy the key.
9. Load `apps/browser-extension` unpacked in Edge/Chrome, paste the key, enable.
10. Open a lesson page. Does the panel show "Läser nu: …" with a node count?
11. Compare that node count with what the site really shows. If they differ, the
    reader is wrong — record both numbers.
12. Mark one module complete on the site. Does the app show it as platform-complete
    **without** claiming any knowledge?
13. Select a paragraph and ask about it. Is the answer grounded in that text?
14. Restart the app. Does it resume the same course and position?

### D. Packet Tracer
15. Open a `.pkt` file. Does the app detect the window as Packet Tracer?
16. Run `show ip interface brief` in a device CLI, then ask why a ping fails. Does
    the answer quote the real output?
17. Hide the CLI, ask again. Does it refuse to name a cause instead of guessing?

### E. Voice
18. Leave voice off. Ask three questions. Confirm **no audio** ever plays.
19. Enable voice, ask one question, press stop mid-sentence.

### F. The 0–100 scale
20. With a fresh profile, open Framsteg. It must show `–`, not `0`.
21. Answer five quiz questions correctly without hints. Reopen. Does the number move,
    and does the derivation match what you actually did?
22. Read three lessons without answering anything. The number must **not** move.

## 3. How to record the result

Append a dated section to `BUILD_STATUS.md` with one row per item above:

```
| # | Check | Observed | Evidence |
| 4 | 150 % scaling, position persists | yes | screenshot 2026-11-07 |
| 11 | Node count: app 17, site 17 | match | screenshot |
```

If an item fails, it becomes a FAILED row with the error text. There is no "mostly
works".

## 4. Known blockers that this document does not fix

- **Code signing.** Without it, Windows shows a SmartScreen warning. That is a
  budget/identity decision, not a code bug.
- **Packet Tracer integration surface.** Whether the installed version exposes UIA
  nodes for its topology is still unverified; item 15 answers it.
- **Native messaging.** The bridge is a loopback WebSocket today. Native messaging
  removes the port but needs installer-time registry work, which belongs in the same
  Windows packaging step.
