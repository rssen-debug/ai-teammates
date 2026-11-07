# MAJIN V4 — updates without PowerShell

The requirement: approved releases install and activate without the owner opening a terminal again.
That is only safe if an update is provably the release the owner approved, and if a failed update
cannot leave the installation unable to start. This is how, and what is verified where.

## The chain

```
you approve a release
        │
release tool  ── signs manifest.json with the private key ──┐
        │                                                   │
release host:  manifest.json, manifest.sig, files/<path>    │
        │                                                   │
scheduled task / v4:update apply                            │
        ├─ verify the signature with the PINNED public key ─┘
        ├─ hash every file BEFORE it is written     (a bad byte never lands)
        ├─ stage beside the live tree
        ├─ back up every file the release will replace
        ├─ journal the plan (recovery if the process dies)
        ├─ overlay each file through a temp file + rename
        ├─ if package-lock changed: npm ci --ignore-scripts
        ├─ health check the running host
        └─ if unhealthy: restore every backed-up file, delete added ones, report ROLLED_BACK
```

Two design choices matter more than the rest:

1. **Overlay, not directory swap.** An earlier version renamed the whole live directory away and
   the staged tree in. That deleted `node_modules` and `.git` — a release ships source, not an
   installation — so a “successful” update produced a host that could not boot, and every real
   update rolled back. Moving dependencies aside first only narrowed the window: a crash inside it
   left the installation unstartable. The overlay never moves anything out of the live tree, backs
   up every file before touching it, and writes each file atomically.
2. **The channel is a file, not an environment variable.** A Windows scheduled task starts with no
   environment. `v4/update.json` (`majin.v4.update-config/v1`, mode 0600) stores the release URL and
   the daily time; setup writes it, both the CLI and the task read it. `MAJIN_V4_RELEASE_URL` still
   wins when set.

## One-time setup — the single command

```powershell
cd C:\MAJINCLI
git pull
npm ci
npm run v4:setup -- --autostart --accept --release-url https://<release-base> --auto-update --update-time 04:00
```

What it does, in one run:

- checks Node and the data/workspace directories;
- creates the pairing record and prints the code **once**;
- seeds Owner Mode with the read-only network lanes (files/shell/desktop are granted from the phone);
- pins the release public key if `release-public-key.pem` (or `MAJIN_V4_RELEASE_KEY_PUB`) exists;
- writes `v4/update.json` with the release channel and the daily time;
- registers the per-user logon task (`MAJIN V4 Host`) and the daily update task (`MAJIN V4 Update`);
- runs `v4:accept --write` and writes the evidence file;
- prints exactly what only the owner can do (tunnel, provider key) with one action each.

After that, no new PowerShell command is needed for updates.

## Publishing a release (you or a trusted machine)

```bash
node scripts/v4/release.mjs --key ~/majin-release.pem
# -> dist/release/{manifest.json, manifest.sig, files/, public-key.pem}
```

Host the output at the base URL from setup. The updater fetches `<base>/manifest.json`,
`<base>/manifest.sig` and `<base>/files/<path>`.

## Applying

```powershell
npm run v4:update check     # what is available, changes nothing
npm run v4:update apply     # verify, stage, overlay, health check, rollback on failure
```

The scheduled task runs exactly:

```
node scripts\v4\update.mjs apply --quiet --log
```

`--quiet` prints nothing on success; `--log` appends every line to
`%LOCALAPPDATA%\MAJIN\v4\logs\update.log`. The task runs only when a network is available, does not
start a second instance while one is running, and has a 20-minute limit.

## Dependencies

Dependencies are never shipped in a release and are never touched unless the release changes
`package-lock.json`. In that case the updater runs `npm ci --ignore-scripts --no-audit --no-fund`
before the health check, with a 10-minute limit; a failed install counts as an unhealthy release and
is rolled back. `--ignore-scripts` is deliberate: a release signature proves which code you approved,
not that a package's install script is safe.

## Recovery from an interrupted update

The journal (`%LOCALAPPDATA%\MAJIN\v4\update-journal.json`) is written before the first live file is
touched. `v4:update` and the supervisor both call the recovery routine at boot: if a journal exists,
every backed-up file is restored and the files the release added are deleted. A half-updated install
is never treated as current.

## What is refused

| Situation | Result |
|---|---|
| signature does not match the pinned key | `BAD_SIGNATURE`, nothing staged |
| no key pinned and `--allow-unsigned` not given | refused |
| a file's bytes do not match the manifest | `HASH_MISMATCH`, nothing written |
| a manifest path escapes the release (`..`) | `BAD_MANIFEST_PATH` |
| the release is older than what runs | `DOWNGRADE_REFUSED` |
| the same version | `NOOP` |
| the new version fails its health check | automatic rollback, previous files restored |
| the dependency install fails | treated as unhealthy, rolled back |
| no previous release to roll back to | `FAILED`, stated plainly |

## Evidence, and what is still the owner's

Verified in this repository (`test/v4/update-auto.test.js`, `test/v4/updater.test.js`):

- a real signed release, served over HTTP, installs through the CLI from the saved channel;
- `node_modules` survives the activation;
- a release that fails its health check restores the previous version, including dependencies;
- an interrupted update is rolled back on the next run;
- tampering, downgrade, unsigned mode and path traversal are refused.

Not verified here: Windows Task Scheduler actually firing the task, and `npm ci` on the owner's
machine. Both are one-time checks: after the first scheduled run, `v4/logs/update.log` must contain a
line with `[updated]` or `[noop]`.
