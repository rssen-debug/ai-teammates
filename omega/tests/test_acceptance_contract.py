"""Every tool call in the product must name a real tool and pass arguments it accepts.

Three of the names `acceptance.py` used — `desktop_launch`, `desktop_focus` and
`keyboard_type` — were never registered tools at all. The real ones are `app_launch`,
`window_focus` and `type_text`, and `type_text` takes no `hwnd` because it types into
whatever already has the focus. Calling a name that does not exist raises "unknown
tool", and scenarios 7 and 8 reported that as a PRODUCT failure on Windows CI.

Nobody caught it because the mistake is invisible on every platform except the one
that runs last: on Linux the desktop gate returns BLOCKED before the call is reached,
and on Windows the annotations were capped. Parsing the sources statically instead of
executing them makes the same mistake visible here, on this machine, in milliseconds.

The same scan immediately found a second, older bug that no test had reached:
`CompanionSubsystem._backend` called `screen_describe` with `{}`, and `question` is a
required argument — so the always-on observer's screen capture was rejected by
argument validation on every tick, on every platform, however well configured.

`validate_args` ignores keys a schema does not declare, so an extra argument is not an
error at runtime; it is silently dropped. That is worse than an error, because the
caller believes it aimed at a window when it did not. This test is therefore stricter
than the product: an undeclared key fails here.
"""
from __future__ import annotations

import ast
import asyncio
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_SCRATCH = tempfile.mkdtemp(prefix="omega-tool-contract-test-")
os.environ["BUDDY_HOME"] = _SCRATCH

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
for p in (str(OMEGA), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import buddy  # noqa: E402

_REAL_HOME = (Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy"
              if os.name == "nt" else Path.home() / ".studdybuddy")
assert Path(buddy.HOME) != _REAL_HOME, (
    f"buddy resolved HOME to the owner's real data directory ({buddy.HOME}). "
    "Refusing to build a registry against real user data.")

#: Product sources only. This directory's own tests construct tool names on purpose.
SOURCES = [f for f in sorted(OMEGA.rglob("*.py")) if "tests" not in f.relative_to(OMEGA).parts]


def tearDownModule() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


def call_sites() -> list[tuple[Path, int, str, ast.Dict | None]]:
    """Every `exec_tool(<app>, "<literal name>", <args>)` in the product sources."""
    found: list[tuple[Path, int, str, ast.Dict | None]] = []
    for path in SOURCES:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            is_exec = (isinstance(fn, ast.Name) and fn.id == "exec_tool") or \
                      (isinstance(fn, ast.Attribute) and fn.attr == "exec_tool")
            if not is_exec or len(node.args) < 2:
                continue
            name = node.args[1]
            if not (isinstance(name, ast.Constant) and isinstance(name.value, str)):
                continue  # a computed name cannot be checked statically
            args = node.args[2] if len(node.args) > 2 and isinstance(node.args[2], ast.Dict) else None
            found.append((path, node.lineno, name.value, args))
    return found


def runtime_tool_names(path: Path) -> set[str]:
    """Tool names this file registers at runtime — legitimate, if not in the registry.

    The engine self-test proposes a skill called `adder_demo`, activates it, and then
    calls it through the same `exec_tool` path; tampering with it afterwards is the
    whole point of that check. `Skills.activate` registers an activated skill under
    `skill_<name>` (buddy.py), so both spellings count as declared by the file.
    """
    proposed = set(re.findall(r'propose\(\s*"([A-Za-z_0-9]+)"', path.read_text(encoding="utf-8")))
    return proposed | {f"skill_{n}" for n in proposed}


class TestToolNamesAreReal(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = buddy.Buddy(headless=True)
        cls.registry = cls.app.registry
        cls.sites = call_sites()

    @classmethod
    def tearDownClass(cls) -> None:
        asyncio.run(cls.app.close())

    def test_the_scan_actually_found_the_calls_it_is_supposed_to_check(self) -> None:
        """A vacuous scan passes forever. This is the guard against that."""
        self.assertGreater(len(self.sites), 30, f"only found {len(self.sites)} call sites")
        scanned = {p.name for p, *_ in self.sites}
        for expected in ("acceptance.py", "buddy.py"):
            self.assertIn(expected, scanned, f"the scan never reached {expected}")

    def test_every_tool_name_the_acceptance_harness_calls_is_registered(self) -> None:
        bad = [(p.name, ln, name) for p, ln, name, _ in self.sites
               if p.name == "acceptance.py" and self.registry.get(name) is None]
        self.assertEqual(bad, [], "acceptance.py called a tool that does not exist; on Windows that "
                                  "surfaces as 'unknown tool' and is reported as a product failure")

    def test_every_tool_name_anywhere_in_the_product_is_registered_or_proposed(self) -> None:
        bad = []
        for path, ln, name, _ in self.sites:
            if self.registry.get(name) is None and name not in runtime_tool_names(path):
                bad.append(f"{path.relative_to(OMEGA)}:{ln} {name}")
        self.assertEqual(bad, [], "these exec_tool calls name tools that are neither registered "
                                  "nor proposed as skills in the same file")

    def test_the_three_names_that_broke_windows_are_not_used_anywhere(self) -> None:
        """Regression pin for the specific bug, so a rename cannot reintroduce it."""
        for gone in ("desktop_launch", "desktop_focus", "keyboard_type"):
            self.assertIsNone(self.registry.get(gone), f"{gone} should not be a tool")
            used = [(p.name, ln) for p, ln, name, _ in self.sites if name == gone]
            self.assertEqual(used, [], f"{gone} is not a tool; use app_launch / window_focus / type_text")


class TestArgumentsMatchTheSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = buddy.Buddy(headless=True)
        cls.registry = cls.app.registry
        cls.sites = [(p, ln, name, d) for p, ln, name, d in call_sites()
                     if d is not None and cls.app.registry.get(name) is not None]

    @classmethod
    def tearDownClass(cls) -> None:
        asyncio.run(cls.app.close())

    @staticmethod
    def _literal_keys(node: ast.Dict) -> set[str] | None:
        """The declared keys of a dict literal, or None if any key is computed."""
        keys = set()
        for k in node.keys:
            if k is None or not isinstance(k, ast.Constant) or not isinstance(k.value, str):
                return None  # **kwargs or a computed key: not statically knowable
            keys.add(k.value)
        return keys

    def test_every_required_argument_is_supplied(self) -> None:
        """The bug this found in buddy.py: screen_describe called with no `question`."""
        bad = []
        for path, ln, name, node in self.sites:
            keys = self._literal_keys(node)
            if keys is None:
                continue
            spec = self.registry.get(name)
            required = set((spec.parameters or {}).get("required") or [])
            if required - keys:
                bad.append(f"{path.relative_to(OMEGA)}:{ln} {name} is missing {sorted(required - keys)}")
        self.assertEqual(bad, [], "validate_args rejects these at runtime, so the call can never "
                                  "succeed — and a Windows-only tool hides that from every "
                                  "non-Windows test")

    def test_no_argument_is_passed_that_the_tool_does_not_declare(self) -> None:
        """Stricter than the product on purpose: validate_args silently drops these."""
        bad = []
        for path, ln, name, node in self.sites:
            keys = self._literal_keys(node)
            if keys is None:
                continue
            spec = self.registry.get(name)
            props = set((spec.parameters or {}).get("properties") or {})
            if keys - props:
                bad.append(f"{path.relative_to(OMEGA)}:{ln} {name} got undeclared {sorted(keys - props)}")
        self.assertEqual(bad, [], "an argument the schema does not declare is dropped without an "
                                  "error, so the caller silently does something other than what "
                                  "it says — s08 passing hwnd to type_text believed it was "
                                  "aiming at a window")

    def test_scenario_8_focuses_the_window_before_typing_into_it(self) -> None:
        """`type_text` takes no hwnd, so the focus call is what aims it. Order matters."""
        tree = ast.parse((OMEGA / "acceptance.py").read_text(encoding="utf-8"))
        fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef)
                   and n.name == "s08_write_notepad"), None)
        self.assertIsNotNone(fn, "scenario 8 is gone from acceptance.py")
        order = [a.value for a in ast.walk(fn) if isinstance(a, ast.Constant)
                 and isinstance(a.value, str) and a.value in ("window_focus", "type_text")]
        self.assertEqual(order, ["window_focus", "type_text"],
                         "typing goes to whatever has the focus, so window_focus must come first")


if __name__ == "__main__":
    unittest.main(verbosity=2)
