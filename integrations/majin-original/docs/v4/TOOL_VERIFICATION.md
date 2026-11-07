# Verify the tools on your Windows host

The bug report said: *"V4 can only use five workspace tools."* That was true, and the
cause was the agent sending a hardcoded tool list to the model. It is fixed in code.
This page is how you prove it on the machine that matters.

## 1. See what your host can do

```powershell
cd C:\MAJINCLI
git pull
npm ci
npm run v4:tools
```

The probe registers **every available lane**, granted or not, because it is a
diagnostic — it does not change Owner Mode. On a normal Windows 11 box expect
these lanes `ok`: `desktop`, `computer`, `screen`, `net`, `files`, `shell`,
`shelltools`, `sys`, `power`, `web`, `research`, `jobs`, `flows`, `github`,
`audit`, `learn`, `marketing`, `re`, `trading`, plus `browser` either `ok` with
the path to `msedge.exe` or `n/a` with a reason.

If a lane says `n/a`, it prints **why**. None of them fail silently.

## 2. Prove each tool actually executes

```powershell
npm run v4:tools -- --probe
```

This calls one tool per capability **through the same runner and approval layer
the agent uses**, and prints the outcome:

| Probe | Pass means |
|---|---|
| `workspace_list`, `memory_search` | the sandbox and the memory store answer |
| `fs_stat` | a real file on your disk was stat'ed |
| `exec_start` | a real child process started (harmless `echo`, explicit `local` backend) |
| `sys_info` | real OS/CPU/memory values came from the machine |
| `shell_env` | the environment was read through the shell lane |
| `net_dns` | a real DNS lookup answered (or an honest `NETWORK_FAILURE`) |
| `ma_lessons` | the durable-lessons store answered |
| `re_hash` | a real file was hashed through the binary-analysis lane |
| `control_list_windows` | **your desktop's real windows were enumerated** |
| `web_search` | a real search answered, or an honest `NETWORK_FAILURE` |
| `browser_open` | a real browser launched and loaded example.com |

## 3. Prove the model sees them

The phone uses the same agent. With the host tools enabled, ask MAJIN:

> Vilka verktyg har du? Lista dem kort.

Then ask something that requires a real one:

> Läs filen C:\Users\<du>\Documents\test.txt

If the model can name the tool and the call lands, the exposure is real.

## 4. The acceptance scenario

> Hitta mitt CV på Windows, sök fem riktiga jobb och öppna tre av dem i Edge.

What each step uses:

| Step | Tool | Needs |
|---|---|---|
| find the CV | `fs_search` over an allowed folder | host tools on, folder allowed |
| read it | `fs_read` | — |
| search jobs | `jobs_search` / `web_search` | internet |
| open listings | `browser_open` | Edge or a Playwright binary |
| approval | `process` tier tool pauses the turn | your tap on the phone |

Sensitive steps (anything with tier `process`, including the shell and the delete tool)
**pause and ask**, by design. That is the approval you asked for.

## 5. If something is missing

Run `npm run v4:tools --json` and send that output. It names every lane, every tool,
every tier and every skip reason — enough to fix it without guessing.
