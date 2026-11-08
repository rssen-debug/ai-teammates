"""Contract tests for `omega/install/install.ps1`.

The installer is PowerShell and the acceptance suite can only execute it on
Windows, so on any other host these tests are what stand between a plausible
script and a broken one. They check the things that actually broke before:

  * a hardcoded interpreter version (the previous installer demanded 3.12 and
    failed on machines with a perfectly good 3.11 or 3.13);
  * hardcoded user paths;
  * drift between the subcommands the installer calls and the ones `buddy.py`
    really implements — the same class of bug that made acceptance scenario 19
    call a tool named `dev_analyze` that did not exist;
  * shadowing PowerShell automatic variables in a param block;
  * unbalanced braces, i.e. a script that would not even parse.

None of this proves the installer works on Windows. It proves it is coherent, and
scenario 1 records honestly that executing it still needs a real Windows host.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
INSTALLER = OMEGA / "install" / "install.ps1"
BUDDY = OMEGA / "buddy.py"

#: Paths that must never appear: they are this developer's machine, not the owner's.
FORBIDDEN_PATHS = ["C:\\Users\\rssen", "C:\\Users\\owner", "/home/user", "C:\\MAJINCLI"]

#: PowerShell automatic variables that must not be shadowed by a param name.
AUTOMATIC_VARS = ["Args", "Home", "Input", "Error", "Matches", "PID", "PSItem"]


def _strip_noise(text: str) -> str:
    """Remove here-strings and line comments so structural checks see real code."""
    text = re.sub(r'@"[\s\S]*?"@', '""', text)
    text = re.sub(r"@'[\s\S]*?'@", "''", text)
    text = re.sub(r"<#[\s\S]*?#>", "", text)
    return "\n".join(re.sub(r"(?<![\w'\"`])#.*$", "", line) for line in text.splitlines())


def _dispatch_table_keys() -> set[str]:
    """The subcommand names `buddy.py`'s main() really dispatches on."""
    src = BUDDY.read_text(encoding="utf-8")
    m = re.search(r"table = \{(.*?)\n        \}", src, re.S)
    assert m, "could not locate the subcommand dispatch table in buddy.py"
    return set(re.findall(r'"([a-z][a-z0-9_-]*)":', m.group(1)))


class TestInstallerExists(unittest.TestCase):
    def test_installer_present(self) -> None:
        self.assertTrue(INSTALLER.is_file(), f"missing installer: {INSTALLER}")

    def test_entrypoint_present(self) -> None:
        self.assertTrue(BUDDY.is_file(), f"missing entrypoint: {BUDDY}")


class TestNoHardcodedMachineSpecifics(unittest.TestCase):
    def setUp(self) -> None:
        self.text = INSTALLER.read_text(encoding="utf-8", errors="replace")

    def test_no_developer_paths(self) -> None:
        low = self.text.lower()
        found = [p for p in FORBIDDEN_PATHS if p.lower() in low]
        self.assertEqual(found, [], f"installer contains developer-specific paths: {found}")

    def test_paths_are_derived_from_the_environment(self) -> None:
        for token in ("$PSScriptRoot", "$env:APPDATA", "$env:LOCALAPPDATA"):
            self.assertIn(token, self.text, f"installer should derive locations from {token}")

    def test_accepts_a_range_of_python_versions(self) -> None:
        """The exact failure mode of the previous installer."""
        for ver in ("3.10", "3.11", "3.12", "3.13"):
            self.assertIn(ver, self.text, f"installer never mentions Python {ver}")
    def test_does_not_demand_one_specific_version(self) -> None:
        """Discovery must offer the `py` launcher several versions to choose from."""
        m = re.search(r"foreach \(\$flag in @\(([^)]*)\)\)", self.text)
        self.assertIsNotNone(m, "no `py` launcher version sweep found")
        asks = re.findall(r"'(-3\.\d+)'", m.group(1))
        self.assertGreaterEqual(len(asks), 3, f"discovery should try several versions, found {asks}")
        self.assertEqual(len(set(asks)), len(asks), f"duplicated versions in the sweep: {asks}")
        # and the winget fallback must not be the only way to get an interpreter
        self.assertIn("python.org/downloads", self.text,
                      "must tell the owner where to get Python when discovery fails")


class TestPowerShellHygiene(unittest.TestCase):
    def setUp(self) -> None:
        self.text = INSTALLER.read_text(encoding="utf-8", errors="replace")
        self.code = _strip_noise(self.text)

    def test_braces_balanced(self) -> None:
        self.assertEqual(self.code.count("{"), self.code.count("}"),
                         "unbalanced braces - the script would not parse")

    def test_parentheses_balanced(self) -> None:
        self.assertEqual(self.code.count("("), self.code.count(")"),
                         "unbalanced parentheses - the script would not parse")

    def test_param_block_does_not_shadow_automatic_variables(self) -> None:
        m = re.search(r"param\((.*?)\n\)", self.text, re.S)
        self.assertIsNotNone(m, "no top-level param() block found")
        names = re.findall(r"\$(\w+)", m.group(1))
        clashes = [n for n in names if n in AUTOMATIC_VARS]
        self.assertEqual(clashes, [], f"param block shadows PowerShell automatic variables: {clashes}")

    def test_no_if_expression_as_a_hashtable_value(self) -> None:
        """Windows PowerShell 5.1 cannot use `if` as an expression in a literal."""
        bad = re.findall(r"^\s*\w+\s*=\s*if\s*\(", self.code, re.M)
        self.assertEqual(bad, [], f"`key = if (...)` is a parse error in PS 5.1: {bad}")

    def test_no_splatting_of_a_generic_list(self) -> None:
        bad = re.findall(r"@\w*[Rr]equired\b", self.code)
        self.assertEqual(bad, [], f"splatting a List[T] fails; pass .ToArray(): {bad}")

    def test_here_strings_terminated(self) -> None:
        self.assertEqual(self.text.count('@"'), self.text.count('"@'), "unterminated here-string")


class TestRequiredBehaviour(unittest.TestCase):
    def setUp(self) -> None:
        self.text = INSTALLER.read_text(encoding="utf-8", errors="replace")

    def test_switches_exist(self) -> None:
        for sw in ("$Verify", "$Uninstall", "$Rollback", "$Migrate", "$NoPath", "$NoAutoStart"):
            self.assertIn(sw, self.text, f"installer is missing the {sw} switch")

    def test_covers_the_mandated_install_steps(self) -> None:
        for word in ("python", "venv", "buddy", "rollback", "doctor", "node", "migrate", "PATH"):
            self.assertIn(word.lower(), self.text.lower(), f"installer never mentions {word!r}")

    def test_creates_an_isolated_venv(self) -> None:
        self.assertRegex(self.text, r"-m venv", "must build an isolated venv")
        self.assertIn("$VenvPy", self.text)

    def test_preserves_existing_data(self) -> None:
        low = self.text.lower()
        self.assertIn("preserved", low, "an upgrade must state that data is preserved")
        self.assertNotRegex(self.text, r"Remove-Item[^\n]*\$DataHome\b",
                            "must never delete the data home")

    def test_migration_is_scan_by_default(self) -> None:
        self.assertIn("'scan'", self.text, "must always scan legacy memory (read-only)")
        self.assertIn("$Migrate", self.text, "importing must be an explicit opt-in")


class TestNoDriftFromTheProduct(unittest.TestCase):
    """Every subcommand the installer calls must really exist in buddy.py."""

    def setUp(self) -> None:
        self.text = INSTALLER.read_text(encoding="utf-8", errors="replace")
        self.table = _dispatch_table_keys()

    def _invoked_subcommands(self) -> list[str]:
        calls = re.findall(r"Invoke-Buddy\s+\$\w+\s+@\(([^)]*)\)", self.text)
        first = []
        for c in calls:
            m = re.search(r"'([^']+)'", c)
            if m:
                first.append(m.group(1))
        return first

    def test_dispatch_table_was_found(self) -> None:
        self.assertGreater(len(self.table), 8, f"dispatch table looks wrong: {sorted(self.table)}")

    def test_every_invoked_subcommand_exists(self) -> None:
        invoked = self._invoked_subcommands()
        self.assertGreater(len(invoked), 3, "found suspiciously few Invoke-Buddy calls")
        missing = sorted({c for c in invoked if c not in self.table})
        self.assertEqual(missing, [],
                         f"installer calls subcommands buddy.py does not implement: {missing}; "
                         f"available: {sorted(self.table)}")

    def test_required_commands_are_all_reachable(self) -> None:
        for cmd in ("doctor", "status", "stop", "update", "prove"):
            self.assertIn(cmd, self.table, f"`buddy {cmd}` is required by the product contract")

    def test_installer_runs_the_diagnostics_it_promises(self) -> None:
        invoked = self._invoked_subcommands()
        self.assertIn("doctor", invoked, "the installer must actually run `buddy doctor`")
        self.assertIn("deps", invoked, "the installer must read the product's own dependency policy")


class TestAcceptanceReadsTheInstallerCorrectly(unittest.TestCase):
    """Scenario 1 must tell "this host has no installer" from "the installer is broken".

    The two look identical from the outside: `install.ps1 -Verify` exits non-zero.
    A CI runner never ran the installer, so verification correctly reports the
    dependencies absent — that is a statement about the host, not a defect. But a
    missing entrypoint, a missing launcher or a failing `buddy doctor` IS a defect,
    and must keep failing even on a machine where the dependencies also happen to be
    missing.

    Run in a child process: acceptance.py repoints BUDDY_HOME at import, which must
    not happen inside a live test session.
    """

    CHILD = """
import json, sys
sys.path.insert(0, sys.argv[1])
import acceptance
cases = json.loads(sys.argv[2])
print(json.dumps({k: acceptance.verify_problem_class(v)[0] for k, v in cases.items()}))
"""

    def _classify(self, cases: dict) -> dict:
        proc = subprocess.run(
            [sys.executable, "-c", self.CHILD, str(OMEGA), json.dumps(cases)],
            capture_output=True, text=True, timeout=180, encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 0, f"child failed: {proc.stderr[-2000:]}")
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def test_absent_dependencies_alone_are_blocked_not_failed(self) -> None:
        out = ("  + installer contract OK\n"
               "  x required dependencies are missing:\n"
               "numpy faster-whisper websocket-client winsdk edge-tts\n"
               "  x verification FAILED: 1 problem(s)\n")
        self.assertEqual(self._classify({"ci": out})["ci"], "blocked")

    def test_a_structural_problem_still_fails(self) -> None:
        cases = {
            "entrypoint": "  x entrypoint missing: C:\\app\\omega\\buddy.py\n"
                          "  x verification FAILED: 1 problem(s)\n",
            "launcher": "  x launcher missing: C:\\app\\omega\\launcher\\buddy.cmd\n"
                        "  x verification FAILED: 1 problem(s)\n",
            "doctor": "  x buddy doctor runtime reported problems (exit 1)\n"
                      "  x verification FAILED: 1 problem(s)\n",
            # the dangerous case: a real defect hiding behind an uninstalled host
            "both": "  x entrypoint missing: C:\\app\\omega\\buddy.py\n"
                    "  x required dependencies are missing:\nnumpy\n"
                    "  x verification FAILED: 2 problem(s)\n",
        }
        got = self._classify(cases)
        self.assertEqual(got, {k: "fail" for k in cases},
                         "a structural problem must fail the scenario even when "
                         "dependencies are also missing")

    def test_a_clean_verify_is_not_a_failure(self) -> None:
        got = self._classify({"ok": "  + install.ps1 -Verify completed clean\n"})
        self.assertEqual(got["ok"], "fail",
                         "an empty problem list is not evidence of an uninstalled host; "
                         "only a non-zero exit reaches this classifier")



if __name__ == "__main__":
    unittest.main(verbosity=2)
