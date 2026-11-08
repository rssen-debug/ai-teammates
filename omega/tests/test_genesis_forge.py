"""Genesis V4: test automatic safe draft creation and actual scheduler hook."""
from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_forge import forge_once, safe_advisory_source
from genesis_playbooks import PlaybookStore


class FakeSkills:
    def __init__(self):
        self.entries = []
        self.tests = []
    def list(self):
        return self.entries
    def propose(self, name, description, parameters, code, risk):
        self.entries.append({"name": name, "status": "draft"})
        self.source = code
        self.risk = risk
        return {"version": 1}
    def test(self, name, version, args, expect_contains):
        self.tests.append(name)
        return {"passed": "Advisory only" in self.source}


class ForgeTests(unittest.TestCase):
    def candidate(self):
        return {"signature": "abcdef012345", "category": "FILER",
                "tools": ["file_write", "file_read"], "verified_runs": 3}

    def test_generated_source_is_read_only_and_valid_python(self):
        source = safe_advisory_source(self.candidate())
        tree = ast.parse(source)
        self.assertEqual(len(tree.body), 1)
        self.assertIsInstance(tree.body[0], ast.FunctionDef)
        ns = {}
        exec(compile(tree, "<forge-test>", "exec"), ns)
        result = ns["run"]({})
        self.assertEqual(result["pattern"], ["file_write", "file_read"])
        self.assertIn("Nothing executed", result["warning"])

    def test_forge_is_automatic_but_never_activates(self):
        skills = FakeSkills()
        app = SimpleNamespace(
            skills=skills, privacy=SimpleNamespace(private=False),
            shutting_down=False, current_run=None,
            tasks=SimpleNamespace(current={}, paused=False),
            settings=SimpleNamespace(get=lambda k, default=None: True),
            store=SimpleNamespace(one=lambda query: None))
        old = PlaybookStore.forge_candidates
        try:
            PlaybookStore.forge_candidates = lambda self, **kw: [self_fixture]
            self_fixture = self.candidate()
            first = forge_once(app)
            second = forge_once(app)
        finally:
            PlaybookStore.forge_candidates = old
        self.assertEqual(first["created"], 1)
        self.assertEqual(first["status"], "tested")
        self.assertEqual(second["created"], 0)
        self.assertEqual(len(skills.entries), 1)
        self.assertEqual(len(skills.tests), 1)
        self.assertEqual(skills.risk, "read_only_advisory")
        self.assertFalse(hasattr(skills, "activate"))

    def test_private_and_queued_work_block_forge(self):
        base = SimpleNamespace(
            skills=FakeSkills(), privacy=SimpleNamespace(private=True),
            shutting_down=False, current_run=None,
            tasks=SimpleNamespace(current={}, paused=False),
            settings=SimpleNamespace(get=lambda k, default=None: True),
            store=SimpleNamespace(one=lambda query: None))
        self.assertEqual(forge_once(base)["created"], 0)
        base.privacy.private = False
        base.store.one = lambda q: {"id": "queued"}
        self.assertEqual(forge_once(base)["created"], 0)

    def test_real_buddy_scheduler_invokes_forge(self):
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("from genesis_forge import forge_once", source)
        self.assertIn("await asyncio.to_thread(forge_once, app)", source)


if __name__ == "__main__":
    unittest.main()
