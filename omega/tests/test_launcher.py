"""Tests for omega/launcher/ — how `buddy` becomes one command.

Two kinds of test, because the two files are not equally testable here.

The POSIX launcher is really executed: `sh launcher/buddy version` has to work,
arguments have to arrive intact, a too-old interpreter has to be rejected, and a
launcher separated from buddy.py has to say so. Running it is the only way to know.

buddy.cmd cannot run on a Linux CI runner, so it is checked as text against the
same contract — and that contract exists because of a real failure: the previous
installer required Python 3.12 specifically and broke on every machine with 3.11
or 3.13. A launcher that hardcodes a version, or a machine-specific path, is a
broken install waiting to happen.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
LAUNCHER = OMEGA / "launcher"
POSIX = LAUNCHER / "buddy"
CMD = LAUNCHER / "buddy.cmd"

#: The only version floor the product has. A launcher enforcing anything else is
#: repeating the mistake that broke the previous installer. Written as a regex
#: because batch and sh spell the tuple differently: `(3,10)` vs `(3, 10)`.
FLOOR_RE = r"\(3,\s*10\)"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def code_only(text: str, kind: str) -> str:
    """Drop comment lines, so a rule documented in prose is not mistaken for code.

    Three checks in this file failed on the launchers' own header comments — one
    said "No arrays, no [[ ]], no local", another said "or read from
    install-manifest.json", which made the manifest look like it was tried before
    BUDDY_PYTHON. A contract test that cannot distinguish a comment from an
    instruction is testing the wrong artifact.
    """
    out = []
    for line in text.splitlines():
        st = line.strip()
        if kind == "posix":
            if st.startswith("#"):
                continue
        elif st.lower().startswith("rem") or st.startswith("::"):
            continue
        out.append(line)
    return "\n".join(out)


class LauncherContract(unittest.TestCase):
    """What both launchers must contain, checked as text."""

    def setUp(self) -> None:
        self.posix, self.cmd = read(POSIX), read(CMD)
        self.posix_code = code_only(self.posix, "posix")
        self.cmd_code = code_only(self.cmd, "cmd")

    def pairs(self, code: bool = True):
        if code:
            return (("buddy", self.posix_code), ("buddy.cmd", self.cmd_code))
        return (("buddy", self.posix), ("buddy.cmd", self.cmd))

    def test_both_launchers_exist(self) -> None:
        self.assertTrue(POSIX.is_file(), f"{POSIX} missing")
        self.assertTrue(CMD.is_file(), f"{CMD} missing")

    @unittest.skipIf(os.name == "nt", "the executable bit is a POSIX concept; git does not preserve it on Windows")
    def test_the_posix_launcher_is_executable(self) -> None:
        mode = POSIX.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR, "launcher/buddy must be executable or PATH cannot run it")

    def test_neither_hardcodes_a_machine_specific_path(self) -> None:
        for name, text in self.pairs():
            for bad in (r"C:\\Users\\", r"C:/Users/", r"/home/[a-z]", r"/Users/[a-z]"):
                self.assertIsNone(re.search(bad, text),
                                  f"{name} hardcodes a machine-specific path matching {bad!r}")

    def test_both_enforce_the_3_10_floor_by_asking_the_interpreter(self) -> None:
        for name, text in self.pairs():
            self.assertIn("version_info", text, f"{name} must version-check its candidate")
            self.assertRegex(text, FLOOR_RE, f"{name} must enforce exactly the 3.10 floor")

    def test_neither_demands_one_specific_python_version(self) -> None:
        """The regression that broke the last installer: `python3.12` as a requirement.

        Naming a version among candidates to try is fine. Requiring one is not, so
        what is forbidden here is a version appearing in a *condition*.
        """
        for name, text in self.pairs():
            for bad in (r"==\s*3\.1\d", r"\(3,\s*1[123]\)\s*(?:else|or)",
                        r"requires?\s+python\s*3\.1\d"):
                self.assertIsNone(re.search(bad, text, re.I),
                                  f"{name} appears to require one specific Python version: {bad!r}")

    def test_both_let_BUDDY_PYTHON_win(self) -> None:
        for name, text in self.pairs():
            self.assertIn("BUDDY_PYTHON", text, f"{name} must honour an explicit interpreter")
            self.assertLess(text.index("BUDDY_PYTHON"), text.index("install-manifest"),
                            f"{name} must try BUDDY_PYTHON before the manifest")

    def test_both_read_the_installer_manifest(self) -> None:
        for name, text in self.pairs():
            self.assertIn("install-manifest.json", text, f"{name} must honour what the installer recorded")
            # buddy.cmd has to escape the quotes for findstr, so accept either form.
            self.assertRegex(text, r'\\?"python\\?"',
                             f"{name} must read the manifest's python field")

    def test_both_agree_on_the_discovery_order(self) -> None:
        """Same order on both platforms, so behaviour does not depend on the OS."""
        steps = ["BUDDY_PYTHON", "install-manifest.json", "python3"]
        for name, text in self.pairs():
            positions = []
            for step in steps:
                self.assertIn(step, text, f"{name} is missing discovery step {step!r}")
                positions.append(text.index(step))
            self.assertEqual(positions, sorted(positions),
                             f"{name} tries its interpreters in the wrong order")

    def test_both_explain_failure_instead_of_failing_silently(self) -> None:
        for name, text in self.pairs():
            self.assertIn("127", text, f"{name} must exit 127 when no interpreter qualifies")
            self.assertIn("3.10", text, f"{name} must tell the user what version is needed")
            self.assertIn("BUDDY_PYTHON", text)

    def test_the_windows_launcher_needs_no_powershell(self) -> None:
        """A .cmd that shells out to PowerShell fails on locked-down machines,
        which is exactly where a batch launcher is supposed to still work."""
        # A comment may mention PowerShell; invoking one may not. Only the
        # invocation forms are checked, so documenting the rule cannot trip it.
        for bad in (r"powershell\.exe", r"powershell\s+-", r"\bpwsh\b",
                    r"Get-Command", r"Import-Module", r"\$PSVersionTable"):
            self.assertIsNone(re.search(bad, self.cmd_code, re.I),
                              f"buddy.cmd must not invoke PowerShell ({bad})")

    def test_the_posix_launcher_is_sh_not_bash(self) -> None:
        self.assertTrue(self.posix.startswith("#!/bin/sh"),
                        "must run under a minimal /bin/sh, not assume bash")
        # Regexes, not substrings: the manifest parser legitimately contains
        # `[[:space:]]`, which is a POSIX character class and not a bash `[[` test.
        for bad in (r"\[\[(?!:)", r"\bdeclare\s", r"\blocal\s", r"\bfunction\s+\w"):
            self.assertIsNone(re.search(bad, self.posix_code),
                              f"POSIX sh has no construct matching {bad!r}")


@unittest.skipIf(os.name == "nt",
                 "there is no /bin/sh on a Windows runner, so the POSIX launcher cannot be "
                 "executed there — and skipping is honest, whereas passing it would not be")
class PosixLauncherExecuted(unittest.TestCase):
    """The POSIX launcher, actually run."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.home = tempfile.mkdtemp(prefix="omega-launcher-")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.home, ignore_errors=True)

    def run_launcher(self, args: list[str], env_extra: dict | None = None,
                     launcher: Path | None = None) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k != "BUDDY_PYTHON"}
        env.update({"BUDDY_HOME": self.home, "NO_COLOR": "1", **(env_extra or {})})
        return subprocess.run(["sh", str(launcher or POSIX), *args], capture_output=True,
                              text=True, timeout=180, env=env, cwd=str(OMEGA.parent))

    def test_it_runs_the_product_and_passes_arguments_through(self) -> None:
        p = self.run_launcher(["version"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("Studdy Buddy Omega", p.stdout + p.stderr)

    def test_it_reaches_a_real_subcommand(self) -> None:
        p = self.run_launcher(["trust", "status"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("trust", (p.stdout + p.stderr).lower())

    def test_an_explicit_interpreter_is_used(self) -> None:
        p = self.run_launcher(["version"], {"BUDDY_PYTHON": sys.executable})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_a_too_old_interpreter_is_refused_with_a_real_message(self) -> None:
        """Not a hypothetical: the previous installer failed this way, silently."""
        tmp = Path(tempfile.mkdtemp(prefix="omega-oldpy-"))
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        fake = tmp / "python-old"
        fake.write_text('#!/bin/sh\n'
                        '# Pretends to be CPython 3.8: fails the version probe, succeeds otherwise.\n'
                        'case "$*" in *version_info*) exit 1 ;; esac\nexit 0\n', encoding="utf-8")
        fake.chmod(0o755)
        p = self.run_launcher(["version"], {"BUDDY_PYTHON": str(fake)})
        self.assertEqual(p.returncode, 127)
        self.assertIn("not a usable CPython", p.stderr)
        self.assertIn("3.10", p.stderr, "the message must say what IS acceptable")

    def test_a_launcher_separated_from_buddy_py_says_so(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="omega-orphan-"))
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        orphan = tmp / "launcher" / "buddy"
        orphan.parent.mkdir(parents=True)
        orphan.write_text(read(POSIX), encoding="utf-8")
        orphan.chmod(0o755)
        p = self.run_launcher(["version"], launcher=orphan)
        self.assertEqual(p.returncode, 2)
        self.assertIn("cannot find", p.stderr)
        self.assertIn("omega/launcher/", p.stderr, "must explain the expected layout")

    def test_a_manifest_recorded_interpreter_is_honoured(self) -> None:
        """The installer records what it verified; a later run must not pick something else."""
        import json
        manifest = OMEGA / "install-manifest.json"
        existed = manifest.exists()
        backup = read(manifest) if existed else None
        self.addCleanup(lambda: (manifest.write_text(backup, encoding="utf-8") if existed
                                 else manifest.unlink(missing_ok=True)))
        manifest.write_text(json.dumps({"schema": "studdybuddy.omega.install-manifest/v1",
                                        "python": sys.executable}), encoding="utf-8")
        p = self.run_launcher(["version"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
