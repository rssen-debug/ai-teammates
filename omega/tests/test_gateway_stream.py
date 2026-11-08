"""Regression checks for the SSE gateway and resumable model/tool responses."""
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buddy import Gateway, GatewayError

class FakeResponse:
    def __init__(self, events):
        self.headers = {"Content-Type": "text/event-stream"}
        self.events = [("data: " + json.dumps(item) + "\n\n").encode() for item in events]
        self.events.append(b"data: [DONE]\n\n")
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def __iter__(self): return iter(self.events)

class GatewayStreamingTest(unittest.TestCase):
    def make_gateway(self):
        return Gateway(SimpleNamespace(get=lambda name: "test-key"))

    def test_content_arrives_before_completion_and_has_no_duplicates(self):
        events = [
            {"choices": [{"delta": {"content": "He"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "j!"}, "finish_reason": "stop"}]},
        ]
        parts = []
        g = self.make_gateway()
        with patch("urllib.request.urlopen", return_value=FakeResponse(events)):
            output = g.chat_stream_sync("test-model", [{"role": "user", "content": "hi"}], on_delta=parts.append)
        self.assertEqual(parts, ["He", "j!"])
        self.assertEqual(output["message"]["content"], "Hej!")
        self.assertEqual(output["finish"], "stop")

    def test_tool_fragments_are_reconstructed_without_executing_tools(self):
        events = [
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                               "function": {"name": "tool_", "arguments": "{\\"q\\":"}}]}, "finish_reason": None}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function":
                               {"name": "search", "arguments": "\\"ok\\"}"}}]}, "finish_reason": "tool_calls"}]},
        ]
        g = self.make_gateway()
        with patch("urllib.request.urlopen", return_value=FakeResponse(events)):
            output = g.chat_stream_sync("model", [{"role": "user", "content": "search"}])
        tool = output["message"]["tool_calls"][0]
        self.assertEqual(tool["function"]["name"], "tool_search")
        self.assertEqual(tool["function"]["arguments"], '{"q":"ok"}')
        self.assertEqual(tool["id"], "call_1")

    def test_partial_stream_never_falls_back_and_double_executes(self):
        class BrokenResponse(FakeResponse):
            def __iter__(self):
                yield self.events[0]
                raise OSError("connection dropped")
        events = [{"choices": [{"delta": {"content": "partial"}, "finish_reason": None}]}]
        g = self.make_gateway()
        with patch("urllib.request.urlopen", return_value=BrokenResponse(events)) as send:
            with self.assertRaises(GatewayError):
                g.chat_stream_sync("model", [{"role": "user", "content": "hi"}])
        self.assertEqual(send.call_count, 1)

if __name__ == "__main__":
    unittest.main()
