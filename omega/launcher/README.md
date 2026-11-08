# `omega/launcher/` — how `buddy` becomes one command

The product promises **one command**: `buddy`. Python does not put executables on
PATH for you, and a Windows user should never have to type
`python C:\somewhere\omega\buddy.py`. This directory is the missing piece: small,
dependency-free shims that the installer copies somewhere on PATH.

| File | Platform | Notes |
|---|---|---|
| `buddy.cmd` | Windows | What `cmd.exe` and the Start menu run. Pure batch, no PowerShell dependency. |
| `buddy` | Linux / macOS / WSL | POSIX `sh`, not bash — a minimal install may not have bash as `/bin/sh`. |

Both do the same thing: **find a usable CPython, then hand every argument through
to `omega/buddy.py` unchanged.** No policy, no parsing, no behaviour of their own.
Anything smarter belongs in `buddy.py`, where it can be tested.

## Two rules that are not negotiable

**1. Never hardcode a Python version.**
The previous installer required *exactly* 3.12 and failed on machines that had
3.11 or 3.13 — the single reason the last install broke. `buddy.py` needs
`>= 3.10` and recommends 3.12; the launchers enforce only the floor, by asking
the candidate interpreter itself:

```
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
```

So a future 3.14 works without editing a launcher, and a too-old 3.8 is rejected
with a real message instead of a traceback.

**2. Never hardcode a machine-specific path.**
Everything resolves relative to the launcher's own location, or is read from
`install-manifest.json`. There is no `C:\Users\...` anywhere in these files, and
`omega/tests/test_launcher.py` fails the build if one appears.

## Interpreter discovery order

The same order on both platforms, so behaviour does not depend on the OS:

1. **`BUDDY_PYTHON`** — an explicit interpreter always wins. This is the escape
   hatch for conda environments, a corporate-locked-down Python, or a user who
   simply knows better than the search.
2. **`install-manifest.json`** → its `python` field. The installer records what it
   verified during setup, so a second run does not rediscover and possibly pick
   something different.
3. **`py -3`** (Windows only) — the standard launcher, newest registered first.
4. **PATH**, most specific first: `python3.13`, `python3.12`, `python3.11`,
   `python3.10`, `python3`, `python`.

Each candidate is version-checked before it is used. If none qualifies, the
launcher exits `127` and prints exactly what it looked for — an unexplained
failure here would look like a broken install rather than a missing interpreter.

## Exit codes

| Code | Meaning |
|---|---|
| *(from `buddy.py`)* | Passed through untouched. The launcher never invents one. |
| `2` | The launcher could not find `buddy.py` next to itself — broken install layout. |
| `127` | No usable CPython `>= 3.10` found. |

## Manual use, without the installer

```sh
# POSIX
chmod +x omega/launcher/buddy
ln -s "$PWD/omega/launcher/buddy" ~/.local/bin/buddy

# Windows (an admin shell is not required for a user PATH entry)
setx PATH "%PATH%;%CD%\omega\launcher"
```

`omega/tests/test_launcher.py` checks these scripts as text, because a `.cmd`
cannot be executed on a Linux CI runner. It verifies the rules above: no hardcoded
version floor other than 3.10, no absolute machine paths, every documented
discovery step actually present, and both launchers agreeing on the order.
