"""Regression contract for respectful natural dialogue in OMEGA."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buddy import SYSTEM_PROMPT


class ConversationToneTests(unittest.TestCase):
    def test_system_prompt_rejects_pushy_smalltalk(self):
        self.assertIn('do not pivot to "vad vill du?"', SYSTEM_PROMPT)
        self.assertIn('"vad är det du vill?"', SYSTEM_PROMPT)
        self.assertIn('"jag bara chillar"', SYSTEM_PROMPT)
        self.assertIn("not an overexcited cartoon", SYSTEM_PROMPT.lower().replace("not ", "not "))
        self.assertIn('For a simple "hej" or "yo"', SYSTEM_PROMPT)

    def test_pixel_companion_is_not_a_personality_override(self):
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("NOT a roleplay or permission to change", source)
        self.assertIn("respectful adult communication style", source)

    def test_direct_respectful_swedish_and_no_artificial_punctuation(self):
        self.assertIn("natural idiomatic Swedish", SYSTEM_PROMPT)
        self.assertIn("no artificial punctuation spam", SYSTEM_PROMPT)
        self.assertIn("Chat etiquette takes priority", SYSTEM_PROMPT)
        self.assertIn("previous assistant message", SYSTEM_PROMPT)
        self.assertIn("immediately adjust your future tone", SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
