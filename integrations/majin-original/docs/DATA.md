# Data MAJIN can keep about its own work

This is the whole story of the one feature that records MAJIN rather than your files: **dataset
capture**. It exists because an agent improves from its own trajectories — the plan, the tool calls
with their arguments, what failed, what the answer was, and whether you were happy with it. There
is no other reason to keep any of it.

## What is not here

* No telemetry. No "improvement program". No analytics ping, no crash reporter, no update check.
* No upload path at all — there is no `fetch` to anywhere in `src/core/dataset.js`, and there is no
  `dataset.upload` key: `validatePatch` rejects it. If you want to share a set, you export the file
  and send it yourself.
* Nothing is recorded unless `dataset.capture` is `true`, which is not the default.

## Turning it on

```
majin dataset on                       # or: say "learn from my runs" in the window
majin dataset off                      # or: "stop recording my runs"
majin dataset list [n]                 # newest records
majin dataset export [--clean]          # JSONL next to the trajectories
majin dataset purge                     # delete everything captured
```

Natural language is the primary switch, because that is how you talk to MAJIN: "learn from my runs",
"record my turns as training data" turn it on; "stop recording my runs", "do not capture my
sessions", "dataset off" turn it off. A turn that only says `good`, `thanks`, `wrong`, `👍` or `👎`
is spent labelling the previous record instead of calling a model.

## What one record holds

One line per turn in `<data dir>/dataset/trajectories.jsonl`:

| field | what it is |
|---|---|
| `id`, `at`, `day`, `session` | identity and time, nothing else |
| `instruction` | your message, after redaction |
| `plan[]` | the todo list MAJIN set for the turn (`{text,status}`) |
| `job`, `model` | which route was chosen and which model answered |
| `moa` | whether Mixture-of-Agents ran, how many references |
| `steps[]` | `{i,name,args,ok,ms}` — the tool sequence with its arguments |
| `answer` | the final text (capped at 4000 chars) |
| `usage`, `costUsd` | tokens and money for the turn |
| `stopped`, `error` | whether you aborted, and the failure text |
| `rating` | `1`, `-1` or `null`. Nobody rated it is *not* a good example |

Tool **result bodies are never stored** — only their size in `chars`. The interesting half of a
trajectory is which tool was called with what arguments and whether it worked; the output is your
data, and it stays on disk where it belongs. `dataset.include` lets you drop `answer`, `toolArgs`
or `plan` too (only the field is dropped; the sequence stays).

## Redaction

Applied before anything is written, with no switch to turn it off:

`sk-…`/`pk-…`/`AIza…`/`ghp_…` keys · `Authorization:`/`x-api-key:`/`password:` values · bearer and
basic tokens · JWTs · MAJIN's own server token · the config folder path · `$HOME`/`%USERPROFILE%` ·
your username · card numbers · addresses on common personal mail providers.

Each becomes a typed placeholder (`<API_KEY>`, `<HOME>`, …) so a reader still knows something stood
there. Redaction is a floor, not a ceiling: the export prints a reminder to read it before you
share it, because "redacted" is not "anonymous".

## Per-turn opt-out

Even with capture on, a turn whose text says `do not save this`, `don't record this`, `never store
that` or `hemliga` is skipped and nothing is written for it (`{ skipped: 'opt-out' }`). That is
checked before the file is touched, so an opt-out turn leaves no trace.

## Retention

`dataset.keepDays` (default 90) is applied on start-up: records older than that are dropped, so a
year of daily driving does not become a permanent archive of your machine. `majin dataset purge`
removes everything now; `majin.dataset({action:'purge',before:'2026-01-01'})` removes a slice.
`<data dir>/dataset/CONSENT.json` documents the switch state for whoever inspects the folder.

## Using the export

`majin dataset export` writes JSONL, one turn per line — the shape most fine-tuning and preference
pipelines want. A typical use:

```bash
majin dataset export            # then feed the file to your own trainer
majin dataset export --clean     # ids, jobs, models, tool names, ratings — no prose at all
```

`--clean` is the one to publish or hand to a colleague: it keeps the *structure* of a run (which
tools in which order, whether they worked, how it was rated) and throws away your questions and
MAJIN's answers.

## Why the rating matters

A trajectory without a label teaches nothing about whether it was good. That is why the label is
`null` until you say something, why a verdict-only message is caught before any model call, and why
`majin.dataset({action:'rate',query:'chrome',score:-1})` exists for labelling after the fact. If
MAJIN misread your files or picked a bad tool sequence, that is exactly the record worth keeping.
