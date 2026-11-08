"""Regression tests: an in-place edit must invalidate downstream caches.

The bug these guard against was found by acceptance scenario 19. `file_patch`
rewrote `calc.py` and the agent immediately ran the tests — but Python's bytecode
cache invalidates on mtime with one-second granularity, so a same-length edit made
in the same second as the previous compile left the stale `.pyc` in charge. The
tests kept failing against the OLD code while the file on disk was already correct,
which reads to an agent as "my fix did not work".

These tests exercise the real tool handlers, not a reimplementation.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
sys.path.insert(0, str(OMEGA))

_HOME = Path(tempfile.mkdtemp(prefix="buddy-editinv-home-"))
os.environ["BUDDY_HOME"] = str(_HOME)

import buddy  # noqa: E402  (must be imported after BUDDY_HOME is set)

# buddy resolves HOME once, at import. If another test module imported it first,
# the BUDDY_HOME set above is ignored and this module would silently write
# somewhere else — possibly the owner's real data. Check, do not assume.
_REAL_HOME = (Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy"
              if os.name == "nt" else Path.home() / ".studdybuddy")
assert Path(buddy.HOME) != _REAL_HOME, (
    f"buddy resolved HOME to the owner's real data directory ({buddy.HOME}); "
    f"another test module imported buddy first. Refusing to run against real user data.")


def _import_calc(proj: Path) -> str:
    """Run a fresh interpreter that imports the module and reports what it computes."""
    r = subprocess.run([sys.executable, "-c", "import calc; print(calc.add(2, 3))"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(proj), timeout=60)
    if r.returncode != 0:
        return f"<error: {r.stderr.strip()[:200]}>"
    return r.stdout.strip()


class TestAdvanceMtime(unittest.TestCase):
    """The helper itself: only bump when a cache could still consider it fresh."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="buddy-mtime-"))

    def test_bumps_when_edit_lands_in_the_same_second(self) -> None:
        f = self.tmp / "a.txt"
        f.write_text("x", encoding="utf-8")
        before = f.stat().st_mtime_ns
        f.write_text("y", encoding="utf-8")  # same length, same second — invisible to a cache
        self.assertTrue(buddy.advance_mtime(f, before), "a same-second edit must be bumped")
        self.assertGreater(f.stat().st_mtime_ns // 1_000_000_000, before // 1_000_000_000)

    def test_no_bump_when_the_second_already_advanced(self) -> None:
        f = self.tmp / "b.txt"
        f.write_text("x", encoding="utf-8")
        stale = f.stat().st_mtime_ns - 5_000_000_000  # pretend we read it 5 s ago
        mtime = f.stat().st_mtime_ns
        self.assertFalse(buddy.advance_mtime(f, stale), "an already-advanced mtime needs no bump")
        self.assertEqual(f.stat().st_mtime_ns, mtime, "must not touch the file needlessly")

    def test_missing_file_is_not_an_error(self) -> None:
        self.assertFalse(buddy.advance_mtime(self.tmp / "nope.txt", 0))


class TestEditToolsInvalidateBytecode(unittest.TestCase):
    """End-to-end through the real registered tools and a real Python subprocess."""

    @classmethod
    def setUpClass(cls) -> None:
        buddy.ensure_dirs()
        cls.app = buddy.Buddy(headless=True)
        for scope in ("observe", "input", "write", "exec"):
            cls.app.perms.set(scope, "always")
        cls.proj = Path(tempfile.mkdtemp(prefix="buddy-editinv-proj-", dir=str(buddy.DIRS["workspace"])))
        (cls.proj / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        import asyncio
        asyncio.run(cls.app.close())

    def _run(self, tool: str, args: dict):
        import asyncio
        return asyncio.run(buddy.exec_tool(self.app, tool, args))

    def test_patch_then_reimport_sees_the_new_code(self) -> None:
        src = self.proj / "calc.py"
        self.assertEqual(_import_calc(self.proj), "-1", "the buggy version must be what runs first")
        self.assertTrue(os.path.isdir(self.proj / "__pycache__"), "the first run should have cached bytecode")

        res = self._run("file_patch", {"path": str(src), "find": "return a - b", "replace": "return a + b"})
        self.assertTrue(res.ok, f"file_patch failed: {res.error}")
        self.assertIn("return a + b", src.read_text(encoding="utf-8"))

        # The regression: without the mtime bump this still printed -1.
        self.assertEqual(_import_calc(self.proj), "5",
                         "a fresh interpreter must run the PATCHED code, not stale bytecode")

    def test_same_length_edit_is_still_visible(self) -> None:
        """Size-unchanged edits are the worst case for timestamp+size caches."""
        src = self.proj / "calc.py"
        before = src.stat().st_size
        res = self._run("file_patch", {"path": str(src), "find": "return a + b", "replace": "return a * b"})
        self.assertTrue(res.ok, f"file_patch failed: {res.error}")
        self.assertEqual(src.stat().st_size, before, "this edit must not change the file size")
        self.assertEqual(_import_calc(self.proj), "6")

    def test_write_reports_whether_it_bumped(self) -> None:
        # Its own filename: unittest runs methods alphabetically, so these must not
        # depend on each other's side effects.
        target = self.proj / "write-note.txt"
        res = self._run("file_write", {"path": str(target), "content": "hello\n"})
        self.assertTrue(res.ok, f"file_write failed: {res.error}")
        self.assertIn("mtime_advanced", res.data or {}, "the result must report the cache-invalidation decision")

    def test_append_reports_whether_it_bumped(self) -> None:
        target = self.proj / "append-note.txt"
        self._run("file_write", {"path": str(target), "content": "hello\n"})
        res = self._run("file_append", {"path": str(target), "content": "world\n"})
        self.assertTrue(res.ok, f"file_append failed: {res.error}")
        self.assertIn("mtime_advanced", res.data or {})
        self.assertEqual(target.read_text(encoding="utf-8"), "hello\nworld\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
