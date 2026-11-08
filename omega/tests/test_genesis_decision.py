"""Fixed V5 decision benchmark: actual routing, availability and regression gates."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_decision import decide, compare_strategies


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

    def test_runtime_wires_decision_into_agent_and_model(self):
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("self.decision = decide(goal,", source)
        self.assertIn("self.decision.role if self.decision.confidence", source)
        self.assertIn("parts.append(run.decision.prompt())", source)
        self.assertIn('self.decision.reason', source)


if __name__ == "__main__":
    unittest.main()
