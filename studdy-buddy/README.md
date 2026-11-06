# Studdy Buddy

A small monkey that sits on your desktop while you study, watches the course page
you have open, and explains things briefly — in Swedish or English, in text by
default, out loud only when you ask.

It is a real Windows Electron app, not a webpage. It works for **whatever you are
studying**: Canvas, NetAcad, Moodle, Itslearning, a university portal, a docs site.
Networking and Packet Tracer are a deep special case, not the only case.

---

## What it actually does today

| | |
| --- | --- |
| **Tutor** | Short, structured answers with per-mode length budgets (QUICK 1–2 sentences … DEEP). Never starts with filler, never invents what it saw. |
| **Memory** | SQLite: sessions, transcript, discovered curriculum, topics, evidence, mastery, review schedule, usage, permission grants. The last ~10 turns of the conversation and a labelled summary of your recorded progress go into every request. |
| **Course discovery** | Reads the navigation tree and headings of the page you allow and derives whatever structure that page exposes. Module count is whatever the site shows — 6, 9, 17, 21 — never a hardcoded number. |
| **Progress** | Three separate things, never conflated: what the platform reports as complete, what you were observed working on, and what evidence shows you know. Reading is never mastery. |
| **Quizzes** | Original questions, one at a time, targeted at your weakest concepts and due reviews. Graded assessments get concept help, never the answer. |
| **Packet Tracer** | Parses visible IOS output (`show ip interface brief`, `ip route`, `vlan brief`, `mac address-table`, ping) and refuses to state a cause it cannot see. |
| **Voice** | Off by default. Opt in per request, Swedish/English, with pronunciation rules for IPs, CIDR, MACs and `Gi0/1`. |
| **Privacy** | Nothing enabled by default. Per-site allow-list, granular permissions, no keylogging, no key in the renderer, no screenshot on disk. |

## Quick start

```bash
cd studdy-buddy
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install   # the Electron binary download needs network access
npm run typecheck
npm test
node apps/desktop/scripts/package-win.mjs     # builds renderer + main; makes the installer on Windows
```

Then: **Inställningar → AI-provider** (endpoint, model id, key), and
**Inställningar → Webbläsare** to allow the site you study on and copy the key the
browser extension needs.

The AI provider is never hardcoded. DeepSeek's official model id is
`deepseek-flash`; a third-party provider may call it something else, so the field is
yours to fill in. Capabilities are probed, not assumed.

## Layout

```
apps/
  desktop/           Electron main, preload, renderer, packaging
  browser-extension/ MV3 extension (any site you allow)
packages/
  shared/            types, IPC contract, settings schema, Result<T>
  database/          SQLite driver (node:sqlite), migrations, repos
  learning-engine/   BKT mastery, prerequisites, topics, review schedule
  curriculum/        page snapshot -> curriculum graph, assessment modes
  quiz-engine/       question bank, grading, adaptive selection
  ai-router/         provider client, budget, cache, structured answers
  agent-core/        permissions, context assembly, task loop, resume
  packet-tracer/     IOS parsing, fault diagnosis, simulation walkthrough
  screen-overlay/    DPI-aware geometry, highlights, tooltips
  mascot/            animation state machine, expression mapping
  voice-engine/      pronunciation, chunking, provider abstraction
  chat-ui/           bubble, settings panel, design tokens
  cli/               doctor / status / models / progress / logs
tests/               unit + integration (280 tests)
docs/                AGENT_DESKTOP.md, BROWSER_EXTENSION.md
```

## Read this before believing anything

* **`BUILD_STATUS.md`** — what is verified, what is implemented but unverified, what
  is blocked, and why. The unverified list is longer than the verified one on
  purpose: this was built on Linux without Windows, Packet Tracer, a browser or an
  API key.
* **`TEST_RESULTS.md`** — the actual commands, outputs and per-file test counts.
* **`SECURITY.md`** — the permission model, what is never collected, and the honest
  limitations (the credential vault is not Windows DPAPI yet).

## Status in one line

The application is real, builds, typechecks, and its logic is covered by 280
passing tests including two end-to-end flows. Anything that depends on Windows, a
browser, Packet Tracer or a live AI provider is marked **BLOCKED** until someone
runs it there.
