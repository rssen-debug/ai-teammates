"""Fixed V5 decision benchmark: actual routing, availability and regression gates."""
from __future__ import annotations

import sys
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_decision import decide, compare_strategies, DecisionHistory


class DecisionV5Test(unittest.TestCase):
    def test_web_discovery_only_when_tool_is_available(self):
        d = decide("Vad finns på https://trendshift.io/monthly?",
                   ["tool_search", "browser_context"],
                   tool_status={"tool_search": True, "browser_context": False})
        self.assertEqual(d.domain, "web")
        self.assertEqual(d.role, "computer")
        self.assertIn("tool_search", d.available_tools)
        self.assertIn("browser_context", d.missing_tools)
        self.assertIn("never claim a tool ran", d.prompt())

    def test_windows_and_programming_are_distinct(self):
        d = decide("Klicka på knappen i Outlook",
                   ["desktop_context", "tool_search"],
                   tool_status={"desktop_context": True, "tool_search": True})
        self.assertEqual(d.domain, "desktop")
        self.assertEqual(d.role, "computer")
        p = decide("Fix Python code bug", ["file_list", "tool_search"],
                   tool_status={"file_list": True, "tool_search": True})
        self.assertEqual(p.domain, "code")
        self.assertEqual(p.role, "coding")

    def test_chat_does_not_claim_tools_or_computer(self):
        d = decide("Hej, hur är läget?", ["desktop_context"],
                   tool_status={"desktop_context": True})
        self.assertEqual(d.domain, "chat")
        self.assertEqual(d.role, "chat")
        self.assertEqual(d.available_tools, ())
        self.assertIn("Plain conversation", d.prompt())

    def test_observed_failure_changes_guidance_not_permissions(self):
        d = decide("Klicka på knappen i Outlook",
                   ["desktop_context", "tool_search"], ["desktop_context"],
                   {"desktop_context": True, "tool_search": True})
        self.assertIn("Previous attempt failed", d.prompt())
        self.assertNotIn("automatic execute", d.prompt())

    def test_fixed_case_comparison_blocks_regression_and_fake_gains(self):
        bad = compare_strategies([
            {"baseline": True, "candidate": False},
            {"baseline": False, "candidate": True},
        ])
        self.assertEqual(bad["regressions"], 1)
        self.assertFalse(bad["promote"])
        improved = compare_strategies([
            {"baseline": True, "candidate": True},
            {"baseline": False, "candidate": True},
        ])
        self.assertTrue(improved["promote"])
        self.assertFalse(compare_strategies([])["promote"])
        self.assertFalse(compare_strategies([{}])["promote"])

    def test_historical_outcomes_change_verification_advice_without_grants(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "decisions.sqlite3"
            db = DecisionHistory(path)
            for _ in range(6):
                db.record("desktop", SimpleNamespace(status="failed", verified=False), 6)
            saved = DecisionHistory(path).snapshot("desktop")
            self.assertEqual(saved["count"], 6)
            self.assertEqual(saved["verified"], 0)
            result = decide("Klicka på knappen i Outlook",
                            ["desktop_context"], tool_status={"desktop_context": True},
                            historical=saved)
            self.assertIn("smaller reversible steps", result.prompt())
            self.assertEqual(result.available_tools, ("desktop_context",))
            self.assertFalse("permission granted" in result.prompt())

    def test_sparse_evidence_is_not_claimed_as_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = DecisionHistory(Path(tmp) / "decisions.sqlite3")
            db.record("code", SimpleNamespace(status="complete", verified=True), 3)
            self.assertEqual(db.snapshot("code")["verified"], 1)
            self.assertEqual(db.snapshot("code")["avg_steps"], 3)
            result = decide("Fix Python code", historical=db.snapshot("code"))
            self.assertEqual(result.reliability_hint, "")

    def test_runtime_wires_decision_into_agent_and_model(self):
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("self.decision = decide(goal,", source)
        self.assertIn("self.decision.role if self.decision.confidence", source)
        self.assertIn("parts.append(run.decision.prompt())", source)
        self.assertIn("DecisionHistory().record(self.decision.domain, o, self.steps)", source)
        self.assertIn('self.decision.reason', source)


if __name__ == "__main__":
    unittest.main()
