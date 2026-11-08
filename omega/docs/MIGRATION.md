# Migration and legacy hand-over

Two directions, one concern: **the owner's history is not ours to lose, corrupt, or
quietly reinterpret.**

- **Backward** — `omega/memory_migration.py` inherits history from previous
  installations on this machine.
- **Forward** — `omega/legacy.py` encapsulates this installation so it can be handed to
  somebody else after the owner is gone.

---

# Part 1 — Importing legacy history

Omega is only as useful as what it remembers. The owner has several previous
installations, each with its own storage format. The migrator finds them, inspects
their **actual** schemas rather than an assumed one, backs the target up, imports
compatible records without touching a single source byte, deduplicates, preserves
timestamps and provenance, validates the result, proves retrieval works, and can roll
the whole thing back.

## Sources understood

Each of these was verified against the real source, not against documentation.

| Source | Location | Format |
|---|---|---|
| Previous/current Omega | `%APPDATA%\StuddyBuddy\buddy.db` | SQLite: `memories`, `runs`, `skills`, `conversation`, `summaries` |
| Old Study Buddy | `%APPDATA%\StuddyBuddy\studdy.db` | SQLite (node:sqlite): `concept`, `learning_evidence`, `chat_message`, `agent_task`, `misconception`, `mastery_estimate` |
| Obsidian vaults | any dir containing `.obsidian/`, plus `…\StuddyBuddy\Obsidian-Vault` | Markdown + YAML frontmatter |
| MAJIN V2/V5 memory | `<v5 data dir>/memory/<kind>.json` | `majin.v2.memory/v1` — conversation, project, task, preference, tool-success, failure-pattern, workflow, environment |
| MAJIN V5 learned procedures | `<v5 data dir>/learned-procedures.json` | `majin.v5.learning/v1` |
| MAJIN V6 | `%LOCALAPPDATA%\MAJIN\v6\…` | `majin.v6.jobs/v1`, `majin.v6.profiles/v1`, queue JSON, JSONL event log |
| MAJIN matrix workspaces | `.majin-matrix-ws-*/teams/*/memory.jsonl`, `missions/*/journal.jsonl` | JSONL |

## Hard rules

Enforced in code and covered by tests — not guidelines.

1. Sources are opened **read-only** (SQLite `mode=ro`; files are never written).
2. A **verified backup** of the target database is taken before any import.
3. **Nothing is deleted from any source. Ever.**
4. **Secrets are never migrated.** `provider_config`, API-key-looking values and
   anything a source marks `sensitive` are skipped — and the skip is *counted*, so a
   silent zero and a deliberate exclusion are distinguishable in the report.
5. Imported records land as `status='migrated'`, tagged `legacy`. Old or unverified
   information never becomes trusted current fact automatically.
6. Counts are validated and retrieval is tested after import; a mismatch fails the
   migration and offers rollback.
7. **Dry run is the default.**

## Commands

```
buddy migrate scan        what legacy data actually exists on this machine
buddy migrate plan        dry-run import plan (default; writes nothing)
buddy migrate run --yes   import, with a verified backup first
buddy migrate verify      re-check an import: record counts, provenance and retrieval
buddy migrate rollback --backup PATH
```

Standalone: `python omega/memory_migration.py scan|plan|run|verify|rollback`.

`buddy migrate run` **is a dry run unless you add `--yes`**. Read the plan first; it
writes nothing without it.

## What the report proves

`MigrationReport.ok` is not a vibe:

```python
ok = not errors and target_count_after == target_count_before + imported
```

Alongside it: `read`, `imported`, `duplicates`, `skipped_secret`, `skipped_empty`,
`backup` and `backup_sha256`, breakdowns `by_kind` and `by_source`, and
`retrieval_check`. Note that `backup == ""` when the target database did not
pre-exist — there was nothing to back up, which is different from failing to.

### The retrieval probe

Importing rows is not the same as being able to find them. `verify_retrieval` searches
the freshly imported store and requires a hit. `_auto_probe()` picks the probe word from
**the owner's own imported content** and never uses a synthetic word — a made-up term
would prove the query machinery works while proving nothing about whether the owner's
history survived in a findable form. A miss fails the migration.

### Source integrity

Sources are compared by `sha256` and `st_mtime_ns` before and after, so "opened
read-only" is a measured property rather than a promise.

## Two implementation traps worth recording

**`sqlite3.Connection.backup()` returns `None` and copies nothing in this build.**
`consistent_sqlite_snapshot` therefore verifies by per-table row counts, falling back to
`iterdump()` and then to a file copy plus `wal_checkpoint(TRUNCATE)`. A backup that
silently produced an empty file would have made every rollback useless.

**Replacing a SQLite file under a live connection leaves that connection on the old
inode.** `Migrator.rollback` closes the sink and deletes `-wal`/`-shm`; long-lived
callers must call `Store.reopen()` afterwards or they will keep reading a file that is
no longer there.

## What has been proven, and what has not

Proven on this host, with synthetic fixtures standing in for each format: imports land
as `status='migrated'` tagged `legacy` with provenance JSON; original timestamps are
preserved; sources come out byte-identical; a second run imports **0** duplicates; a
lying sink fails validation; a retrieval-probe miss fails validation; rollback restores
the exact pre-migration row set.

**Not proven here:** scenarios 11 and 12 of the acceptance suite — reading a *real*
Obsidian vault and retrieving *real* legacy project knowledge — are **BLOCKED**, because
this machine has no `.obsidian/` directory and no real legacy data. The formats are
implemented and unit-tested against fixtures; they have not been exercised against the
owner's actual history. That is a statement about this host and it is not upgraded to a
pass.

---

# Part 2 — Encapsulating for hand-over

`buddy legacy` is the forward direction. Full detail lives in `ARCHITECTURE.md` §6;
the operating summary is here.

## Commands

```
buddy legacy status       heir, heartbeat, grace period, what a bundle never contains
buddy legacy build [PATH] [--days N]
buddy legacy verify PATH
buddy legacy inspect PATH
buddy legacy heir set NAME [--email E] [--relation R] [--note N]
buddy legacy heartbeat
buddy legacy check [--grace-days N]
buddy legacy release PATH
buddy legacy import PATH [--dry-run]
```

## The bundle

`memories.jsonl`, `profile.json`, `skills.jsonl`, `level_history.jsonl`,
`settings.json`, `README.txt`, plus `manifest.json` carrying per-file SHA-256, the
schema `studdybuddy.omega.legacy-bundle/v1`, the heir record and the warnings.

`PATH` may be a directory or a `.tar`/`.tar.gz`. With no path, `build` writes under the
workspace, which `is_protected_path` already treats as writable — so the default cannot
fail on the product's own path policy.

Identity is `memorial_record` and the bundle carries a notice stating that it is a
**record of a person, not that person**. Any consumer must display it. This is not
decorative: a bundle that reads like the deceased is a harm to the people who talk to it.

## Credentials

Excluded **by construction**, not filtered afterwards. Settings are exported from a
14-key allowlist; `is_secret_key()` runs behind it as a second line; the credential
vault is never opened. A denylist fails on the day somebody adds a key, and that day
would come long after anybody remembered why the list existed.

## Encryption: deliberately plaintext

Python's standard library has no AES, and a home-grown cipher is worse than an honestly
plaintext file because it *looks* like protection.

Windows DPAPI is wrong for a different reason, and an obvious one in hindsight: it binds
ciphertext to the account that created it. A bundle sealed that way could never be
opened by the heir — **perfectly safe and permanently useless**, the exact opposite of
what this feature is for. The same applies to BitLocker-to-account and any platform
keyring.

So the bundle records `sealed: false`, says so out loud in the manifest warnings, and
tells the owner to seal it with a passphrase tool and escrow the passphrase:

```
gpg --symmetric --cipher-algo AES256 bundle.tar.gz
age -p -o bundle.tar.gz.age bundle.tar.gz
```

**The protection has to survive the person it protects.** Only a secret that somebody
else also holds can do that.

## Release, heartbeat and grace

`buddy legacy release PATH` is a **third-party action**: the recipient gets a working
model of someone who is not in the room to object. It therefore requires the phrase
`release to my heir` typed in — never as an argv flag, which would put it in shell
history, the process list and any supervisor's logs. It is **not** covered by
`buddy trust on`. It verifies the bundle first, records what was released with its
checksums, and **transmits nothing**. There is no network path in `omega/legacy.py` at
all.

`heartbeat` records that the owner is alive. `check` reports whether the grace period
(default **90 days**) has elapsed. Absence of a heartbeat concludes **nothing** —
missing evidence must not become evidence of death.

`check` returns a decision, never an action. Nothing is ever transmitted automatically,
in any state.

## Import — the receiving half

Without it the bundle would be write-only. `import` refuses a bundle that does not
verify, preserves **original** timestamps (a memory dated today would rewrite the
history it is supposed to carry), tags rows `legacy` with provenance back to the bundle,
and is idempotent — a second import adds nothing. Rows whose kind is not in
`Memory.KINDS` are rejected and counted rather than written, because a row the rest of
the product cannot handle is corruption wearing the costume of data. Importing without
supplying `valid_kinds` still works but reports that kinds were not validated; the
omission is surfaced rather than assumed fine.

Unpacking is guarded against `../` and absolute tar members. A bundle is imported by
someone who trusts it, so a crafted archive must not be able to overwrite the
importer's own files.

## Verification works on read-only media

`verify` and `inspect` unpack into a **temporary directory**, never beside the bundle.
An heir reading a bundle off a DVD, a mounted image or a lawyer's read-only share would
otherwise get a failure to create a scratch directory — which looks exactly like a
corrupted bundle, and would send them away believing the deceased's records were
damaged.

`inspect` does not unpack a bundle that fails verification at all. Reading payloads out
of it would invite someone to act on content that may have been altered.
