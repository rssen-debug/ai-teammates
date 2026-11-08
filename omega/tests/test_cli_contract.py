"""CLI contract tests: whatever the product tells you to run must actually work.

This exists because of a real defect. `buddy accept` was written into the help
text, referenced by the acceptance runner and by the installer — and was never
added to `main()`'s dispatch table. Running it fell through to the "treat it as a
one-shot question" branch, so the owner got `No KiloCode key is configured`
instead of their acceptance report. `buddy bench` was the same story: `level.py`
told users to run it, and it did not exist at all.

The invariant under test is one-directional and strict: **every command the
product documents or recommends must be dispatched.** The reverse direction
(implemented but undocumented) is checked too, because an unreachable feature is
a feature the owner does not have — but it carries an explicit allowlist so it
cannot be silenced by accident.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
BUDDY = OMEGA / "buddy.py"
SRC = BUDDY.read_text(encoding="utf-8")

#: Dispatched on purpose but not listed in USAGE: conventional or alias entries.
#: (`--help` is dispatched too, but the key regex only matches names starting with
#: a letter, so it never appears in either set.)
UNDOCUMENTED_OK = {"help", "selftest", "version"}


def _block(pattern: str, flags=re.S) -> str:
    m = re.search(pattern, SRC, flags)
    assert m, f"could not locate {pattern!r} in buddy.py"
    return m.group(1)


def dispatch_keys() -> set[str]:
    return set(re.findall(r'"([a-z][a-z0-9_-]*)":', _block(r"table = \{(.*?)\n        \}")))


def documented_commands() -> set[str]:
    usage = _block(r'USAGE = r?"""(.*?)"""')
    return set(re.findall(r"^\s*buddy ([a-z][a-z0-9_-]*)", usage, re.M))


def recommended_commands() -> dict[str, list[str]]:
    """Every `buddy X` the code recommends to a human, per file."""
    out: dict[str, list[str]] = {}
    for f in sorted(OMEGA.rglob("*.py")):
        if "node_modules" in f.parts or "__pycache__" in f.parts:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        found = re.findall(r"`buddy ([a-z][a-z0-9_-]*)", text)
        if found:
            out[str(f.relative_to(OMEGA))] = sorted(set(found))
    return out


def handled_slash_commands() -> set[str]:
    """Both dispatch shapes the REPL uses: `cmd == "/x"` and `cmd in ("/a", "/b")`."""
    out = set(re.findall(r'cmd == "(/[a-z]+)"', SRC))
    for group in re.findall(r'cmd in \(([^)]*)\)', SRC):
        out |= set(re.findall(r'"(/[a-z]+)"', group))
    return out


def documented_slash_commands() -> set[str]:
    return set(re.findall(r"(/[a-z]+)", _block(r'    HELP = """(.*?)"""')))


def doctor_sections() -> tuple[set[str], set[str]]:
    valid = set(re.findall(r'"([a-z]+)"', _block(r"    valid = \((.*?)\)\n")))
    usage = _block(r'USAGE = r?"""(.*?)"""')
    # The section list wraps onto a second line in USAGE, so capture up to the
    # next command rather than stopping at the newline.
    m = re.search(r"sections: (.*?)\n  buddy ", usage, re.S)
    return valid, set(m.group(1).split()) if m else set()


def migrate_actions() -> tuple[set[str], set[str]]:
    actions = set(re.findall(r'"([a-z]+)"', _block(r'    actions = \((.*?)\)\n')))
    usage = _block(r'USAGE = r?"""(.*?)"""')
    return actions, set(re.findall(r"buddy migrate ([a-z]+)", usage))


def _import_level():
    """Import level.py the normal way.

    Loading it through importlib without registering it in sys.modules breaks
    @dataclass, which looks up cls.__module__ there — a trap worth not repeating.
    """
    import sys
    if str(OMEGA) not in sys.path:
        sys.path.insert(0, str(OMEGA))
    import level
    return level


class TestDocumentedCommandsAreDispatched(unittest.TestCase):
    """The direction that actually bit us."""

    def test_dispatch_table_was_found(self) -> None:
        self.assertGreater(len(dispatch_keys()), 10, "the dispatch table looks wrong")

    def test_every_usage_command_is_dispatched(self) -> None:
        missing = sorted(documented_commands() - dispatch_keys())
        self.assertEqual(missing, [],
                         f"USAGE promises commands main() does not dispatch: {missing}")

    def test_every_recommended_command_is_dispatched(self) -> None:
        table = dispatch_keys()
        bad = {f: [c for c in cmds if c not in table]
               for f, cmds in recommended_commands().items()}
        bad = {f: c for f, c in bad.items() if c}
        self.assertEqual(bad, {},
                         f"code tells the user to run commands that do not exist: {bad}; "
                         f"dispatched: {sorted(table)}")

    def test_the_two_known_regressions_are_really_wired(self) -> None:
        """Named explicitly so a future refactor cannot quietly drop them again."""
        for cmd in ("accept", "bench"):
            self.assertIn(cmd, dispatch_keys(), f"`buddy {cmd}` regressed out of the dispatch table")
            self.assertIn(cmd, documented_commands(), f"`buddy {cmd}` is no longer documented")
            self.assertRegex(SRC, rf"def cmd_{cmd.replace('-', '_')}\b",
                             f"`buddy {cmd}` has no cmd_ handler")

    def test_every_table_entry_points_at_a_real_callable(self) -> None:
        handlers = set(re.findall(r'"[a-z][a-z0-9_-]*": (\w+),', _block(r"table = \{(.*?)\n        \}")))
        undefined = sorted(h for h in handlers
                           if h.startswith("cmd_") and not re.search(rf"^def {h}\(", SRC, re.M))
        self.assertEqual(undefined, [], f"dispatch table references undefined handlers: {undefined}")


class TestEveryCommandIsReachable(unittest.TestCase):
    """An implemented command nobody can discover is a command nobody has."""

    def test_every_dispatched_command_is_documented(self) -> None:
        undocumented = sorted(dispatch_keys() - documented_commands() - UNDOCUMENTED_OK)
        self.assertEqual(undocumented, [],
                         f"dispatched but absent from USAGE (add them, or justify in "
                         f"UNDOCUMENTED_OK): {undocumented}")

    def test_the_allowlist_has_no_dead_entries(self) -> None:
        stale = sorted(UNDOCUMENTED_OK - dispatch_keys())
        self.assertEqual(stale, [], f"UNDOCUMENTED_OK lists commands that no longer exist: {stale}")


class TestSubcommandSurfaces(unittest.TestCase):
    def test_doctor_sections_documented_are_valid(self) -> None:
        valid, documented = doctor_sections()
        self.assertTrue(valid, "no doctor sections found")
        self.assertEqual(sorted(documented - valid), [],
                         f"USAGE documents doctor sections that do not exist: {sorted(documented - valid)}")
        self.assertEqual(sorted(valid - documented - {"all"}), [],
                         f"doctor sections exist but are undocumented: {sorted(valid - documented - {'all'})}")

    def test_migrate_actions_documented_are_valid(self) -> None:
        actions, documented = migrate_actions()
        self.assertTrue(actions, "no migrate actions found")
        self.assertEqual(sorted(documented - actions), [],
                         f"USAGE documents migrate actions that do not exist: {sorted(documented - actions)}")
        self.assertEqual(sorted(actions - documented), [],
                         f"migrate actions exist but are undocumented: {sorted(actions - documented)}")


class TestReplCommands(unittest.TestCase):
    def test_every_documented_slash_command_is_handled(self) -> None:
        handled = handled_slash_commands()
        documented = documented_slash_commands()
        self.assertTrue(handled, "no REPL slash commands found")
        self.assertEqual(sorted(documented - handled), [],
                         f"/help lists commands the REPL does not handle: {sorted(documented - handled)}")

    def test_every_handled_slash_command_is_documented(self) -> None:
        handled = handled_slash_commands()
        documented = documented_slash_commands()
        self.assertEqual(sorted(handled - documented), [],
                         f"the REPL handles commands /help never mentions: {sorted(handled - documented)}")


class TestBenchmarkAndAcceptanceRunnersExist(unittest.TestCase):
    """`buddy bench` and `buddy accept` shell out; their targets must be there."""

    def test_runner_files_exist(self) -> None:
        for rel in ("acceptance.py", "benchmarks/runner.py", "benchmarks/tasks.py",
                    "level.py", "majin_bridge.py", "memory_migration.py", "install/install.ps1"):
            self.assertTrue((OMEGA / rel).is_file(), f"missing {rel}")

    def test_bench_report_feeds_level_axis_e(self) -> None:
        """The whole point: a benchmark report must move axis E from unmeasured."""
        level = _import_level()

        without = level.compute(evidence={"runs_decided": 4, "runs_verified": 3})
        with_bench = level.compute(evidence={"runs_decided": 4, "runs_verified": 3},
                                   benchmarks={"passed": 9.0, "run": 10})
        e = next(a for a in with_bench.axes if a.key == "E")
        self.assertTrue(e.measured, "a benchmark report must make axis E measured")
        self.assertAlmostEqual(e.value or 0, 0.9, places=6)
        self.assertFalse(next(a for a in without.axes if a.key == "E").measured,
                         "with no report, axis E must stay unmeasured — never zero")

    def test_skipped_benchmarks_are_excluded_not_punished(self) -> None:
        level = _import_level()
        # 9 of 10 ran and passed; 4 more could not run on this host at all.
        partial = level.compute(evidence={"runs_decided": 4, "runs_verified": 3},
                                benchmarks={"passed": 9.0, "run": 10, "skipped": 4, "tasks": 14})
        e = next(a for a in partial.axes if a.key == "E")
        self.assertAlmostEqual(e.value or 0, 0.9, places=6,
                               msg="skipped tasks must not enter the denominator")


def _in_cp1252(ch: str) -> bool:
    try:
        ch.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


class TestRendering(unittest.TestCase):
    """Help text and colour are user-facing contracts, so they get tested too.

    These run the real CLI as a subprocess. Importing buddy in-process would make
    the colour decision untestable, because `C.on` is computed once at import from
    the environment that happens to be there.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.home = tempfile.mkdtemp(prefix="omega-cli-render-")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.home, ignore_errors=True)

    def run_cli(self, args: list[str], env_extra: dict) -> tuple[int, str]:
        env = {k: v for k, v in os.environ.items()
               if k not in ("NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE", "TERM")}
        env.update({"BUDDY_HOME": self.home, **env_extra})
        p = subprocess.run([sys.executable, str(BUDDY), *args], capture_output=True,
                           text=True, timeout=180, env=env, cwd=str(OMEGA.parent))
        return p.returncode, p.stdout + p.stderr

    def test_help_renders_every_documented_command(self) -> None:
        rc, out = self.run_cli(["help"], {"NO_COLOR": "1"})
        self.assertEqual(rc, 0, out[-400:])
        missing = sorted(c for c in documented_commands() if f"buddy {c}" not in out)
        self.assertEqual(missing, [], "help must surface every command USAGE documents")

    def test_no_color_wins_over_force_color(self) -> None:
        rc, out = self.run_cli(["help"], {"NO_COLOR": "1", "FORCE_COLOR": "1"})
        self.assertEqual(rc, 0)
        self.assertNotIn("\033[", out, "NO_COLOR must win: it is a user's explicit request")

    def test_force_color_enables_escapes_without_a_tty(self) -> None:
        rc, out = self.run_cli(["help"], {"FORCE_COLOR": "1", "TERM": "xterm-256color"})
        self.assertEqual(rc, 0)
        self.assertIn("\033[", out, "a pipe with FORCE_COLOR is how `buddy | less -R` works")

    def test_decorated_output_survives_a_cp1252_console(self) -> None:
        """A stock Windows console encodes cp1252, which has an em-dash but none of
        ●, ·, ✗ or ✓ — and this CLI prints ● thousands of times.

        The stream reconfiguration used to live in CLI.__init__, which only the
        interactive REPL constructs, so every one-shot subcommand raised
        UnicodeEncodeError on its first decorated line, on the product's own primary
        platform. Worst instance: run_all.py died on the line that prints a failure
        bullet, so a failing suite crashed the reporter instead of being reported and
        the identities of 14 failing tests were lost.
        """
        for args in (["level"], ["legacy", "status"], ["help"], ["companion", "status"]):
            rc, out = self.run_cli(args, {"PYTHONIOENCODING": "cp1252", "NO_COLOR": "1"})
            self.assertNotIn("UnicodeEncodeError", out,
                             f"`buddy {' '.join(args)}` crashed on a cp1252 console:\n{out[-500:]}")
            self.assertNotIn("charmap", out)
            self.assertEqual(rc, 0, out[-400:])
            # Not "contains ●" — `buddy level` has no dot. The property that matters
            # is that at least one character cp1252 CANNOT represent came out intact,
            # which is the thing that used to raise.
            exotic = sorted({ch for ch in out if not _in_cp1252(ch)})
            self.assertTrue(exotic, f"`buddy {' '.join(args)}` emitted nothing outside cp1252, "
                                    "so this case would pass even if the guard were removed")

    def test_the_reporters_reconfigure_their_streams(self) -> None:
        """Source-level, deliberately.

        A reporter that crashes while reporting a failure cannot tell you it crashed
        for that reason — the symptom is a traceback and a lost exit code, which on
        CI looks like "the harness is broken". So the guard is pinned here rather
        than left to a test that would need a failing suite to exercise it.
        """
        for rel in ("tests/run_all.py", "acceptance.py"):
            src = (OMEGA / rel).read_text(encoding="utf-8")
            self.assertRegex(src, r'reconfigure\(encoding="utf-8"|force_utf8_output\(\)',
                             f"{rel} must widen stdout/stderr before printing decorated output")

    def test_a_dumb_terminal_gets_no_escapes(self) -> None:
        rc, out = self.run_cli(["help"], {"TERM": "dumb"})
        self.assertEqual(rc, 0)
        self.assertNotIn("\033[", out, "TERM=dumb must not receive literal escape codes")

    def test_a_plain_pipe_gets_no_escapes(self) -> None:
        rc, out = self.run_cli(["status"], {})
        self.assertEqual(rc, 0)
        self.assertNotIn("\033[", out, "captured output is read by scripts, not eyes")


if __name__ == "__main__":
    unittest.main(verbosity=2)
