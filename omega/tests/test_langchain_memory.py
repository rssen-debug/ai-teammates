"""LangChain memory excerpts are genuinely used and remain safe without package."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from langchain_memory import relevant_excerpt, format_memory_context


class LangChainMemoryTests(unittest.TestCase):
    def test_relevance_beats_first_300_chars(self):
        content = ("Generic opening paragraph, without useful facts. " * 15 +
                   "\n\nFor Outlook the verified repair was clearing the offline cache.")
        out = relevant_excerpt(content, "Outlook offline cache")
        self.assertIn("Outlook", out)
        self.assertIn("offline cache", out)

    def test_langchain_splitter_used_when_available(self):
        fake = ModuleType("langchain_text_splitters")
        calls = []
        class FakeSplitter:
            def __init__(self, **kwargs):
                calls.append(kwargs)
            def split_text(self, text):
                return ["irrelevant text", "Outlook connection fixed"]
        fake.RecursiveCharacterTextSplitter = FakeSplitter
        with patch.dict(sys.modules, {"langchain_text_splitters": fake}):
            result = relevant_excerpt("memory", "Outlook connection")
        self.assertEqual(result, "Outlook connection fixed")
        self.assertEqual(calls[0]["chunk_size"], 450)

    def test_safe_fallback_if_langchain_not_installed(self):
        with patch.dict(sys.modules, {"langchain_text_splitters": None}):
            out = relevant_excerpt("A" * 550 + "\n\nImportant Python test passed.", "Python test")
        self.assertIn("Python test", out)

    def test_no_memory_no_invented_history(self):
        self.assertEqual(format_memory_context([], "any"), "")
        items = [{"kind": "fix", "status": "verified", "title": "Outlook", "content": "Restart fixed Outlook"}]
        self.assertIn("[fix/verified]", format_memory_context(items, "Outlook"))
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("from langchain_memory import format_memory_context", source)
        self.assertIn("format_memory_context(mems, run.goal)", source)


if __name__ == "__main__":
    unittest.main()
