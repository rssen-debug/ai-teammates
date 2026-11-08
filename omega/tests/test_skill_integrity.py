"""Skill files must be byte-identical to the code that was hashed.

A skill's integrity is a SHA-256 over the code string, checked against the bytes on
disk before every single run (`Skills.run_isolated`). Those two have to agree exactly.

On Windows they did not. `propose()` wrote the file with `write_text()`, and a
text-mode write translates `"\\n"` to `os.linesep` — so the file held CRLF while the
stored hash was computed over LF. Every skill therefore looked tampered with and could
never run, which surfaced as `T6 skills: skill adder_demo v1 has not passed its test`.

Nothing on Linux or macOS can show this, because there is no translation. So the
property is pinned here as an explicit invariant instead of being left to whichever
platform happens to be running the tests — the reason it shipped at all.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_SCRATCH = tempfile.mkdtemp(prefix="omega-skill-test-")
os.environ.setdefault("BUDDY_HOME", _SCRATCH)

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
    "Refusing to run skill-integrity tests against real user data.")

CODE = "def run(args):\n    return {'sum': args['a'] + args['b']}\n"
SCHEMA = {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}}


def tearDownModule() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


class TestSkillIntegrity(unittest.TestCase):
    def setUp(self) -> None:
        self.app = buddy.Buddy(headless=True)
        self.addCleanup(lambda: asyncio.run(self.app.close()))
        self.app.store.x("DELETE FROM skills")
        self.name = f"adder_{os.getpid()}_{id(self) % 10000}"

    def propose(self) -> dict:
        return self.app.skills.propose(self.name, "adds two numbers", SCHEMA, CODE)

    def row(self) -> dict:
        r = self.app.store.one("SELECT * FROM skills WHERE name=?", (self.name,))
        self.assertIsNotNone(r, "the skill was not recorded")
        return dict(r)

    def test_the_file_on_disk_is_byte_identical_to_the_code(self) -> None:
        pr = self.propose()
        raw = Path(pr["path"]).read_bytes()
        self.assertEqual(raw, CODE.encode("utf-8"),
                         "the skill file must be exactly the hashed bytes; a text-mode "
                         "write on Windows emits CRLF and the hash then never matches")
        self.assertNotIn(b"\r", raw, "no line-ending translation may reach the file")

    def test_the_stored_hash_matches_the_bytes_on_disk(self) -> None:
        """This is the invariant run_isolated actually enforces, stated directly."""
        self.propose()
        r = self.row()
        on_disk = hashlib.sha256(Path(r["path"]).read_bytes()).hexdigest()
        self.assertEqual(on_disk, r["code_hash"],
                         "a skill whose stored hash does not match its own file is "
                         "unrunnable on every platform, and permanently so")

    def test_a_freshly_proposed_skill_passes_its_own_test(self) -> None:
        self.propose()
        tr = self.app.skills.test(self.name, None, {"a": 2, "b": 3}, "5")
        self.assertTrue(tr["passed"],
                        f"the skill's own test failed: {tr.get('error') or tr.get('output')}")

    def test_the_integrity_check_rejects_a_line_ending_change(self) -> None:
        """Proves the check is byte-exact, which is why the write has to be too.

        Rewriting the file with CRLF changes nothing a human would call the code, and
        must still be refused — that refusal is the whole point of hashing bytes. It is
        also precisely what a text-mode write did to every skill on Windows.
        """
        self.propose()
        r = self.row()
        p = Path(r["path"])
        self.assertTrue(self.app.skills.test(self.name, None, {"a": 2, "b": 3}, "5")["passed"])
        p.write_bytes(CODE.replace("\n", "\r\n").encode("utf-8"))
        with self.assertRaises(buddy.ToolError) as cm:
            self.app.skills.run_isolated(self.app.skills._row(self.name, None), {"a": 2, "b": 3})
        self.assertIn("changed since it was tested", str(cm.exception))
        self.assertEqual(getattr(cm.exception, "category", None), "tampered")

    def test_the_spec_is_written_byte_exactly_too(self) -> None:
        """Not hashed today, so not broken today — but a second file written the same
        way in the same function is one hash away from the same bug."""
        pr = self.propose()
        spec = Path(pr["path"]).with_name("spec.json")
        self.assertTrue(spec.is_file())
        self.assertNotIn(b"\r", spec.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
