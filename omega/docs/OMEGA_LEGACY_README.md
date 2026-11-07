# Studdy Buddy Omega (one file)

`buddy.py` is a single-file AI companion for Windows 11: it sees the screen, controls the
computer, remembers, works while you are away and talks. Run it with `python buddy.py`.

```
python buddy.py            # setup on first run, then chat
python buddy.py --doctor   # real diagnostics, honest PASS/FAIL/BLOCKED
python buddy.py --self-test# automated acceptance tests (no Windows needed for the engine parts)
python buddy.py --prove    # self-test + live Windows scenarios (needs Windows + Kilo key)
python buddy.py --voice-test
```

## What is verified, and where

Verified in this repository on Linux (Python 3.11, no Windows, no API key):

| Test | Result |
| --- | --- |
| T1 dynamic tool discovery | 61 tools, search loads them |
| T2 vault + secrets never logged | round-trip OK, secret absent from log |
| T3 activity durations | 300 s measured, media "unknown" not "watched" |
| T4 background permissions | denied without grant, allowed with grant |
| T5 model router | escalation + rejects unlisted model ids |
| T6 skill lifecycle | draft → test → approve → use; tamper and unapproved refused |
| G crash recovery | child killed at step 2, resumes, no duplicated steps |
| H memory across restart | new process finds the memory |
| I privacy | private mode and bank windows recorded nowhere |
| K verification gate | a lying model is never marked complete |
| L autopilot | scheduled task runs alone, writes a record |

Independently re-checked by hand (not only by its own suite): a model that writes a file and
claims "done" gets `status=unverified, verified=False`; `finish(complete)` without evidence ids
is rejected; a run that reads the file back gets `complete, verified=True`; a secret written to
the log is redacted.

## What is NOT verified here

Everything marked BLOCKED in `--self-test` output: real Windows screen reading, screenshots,
microphone, speech recognition, voice playback, Notepad typing/read-back, and all live-model
scenarios (`T7`, `T8`, `F`, `A`–`E`). This machine is Linux with no Kilo key and no desktop
session, so those are reported BLOCKED rather than claimed.

## Note on the Kilo endpoint

`Gateway` tries both known OpenAI-compatible base URLs and remembers the one that answers, so a
stale default cannot silently break the key flow. Network failures are reported as network
failures with a network fix, not as "check your key".
