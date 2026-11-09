"""Tests for explicit VNC connection lifecycle; no live VM required."""
import unittest
from types import SimpleNamespace
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker_vnc import Worker

class MockClient:
    def __init__(self):
        self.disconnected = 0
    def disconnect(self):
        self.disconnected += 1

class WorkerConnectionTests(unittest.TestCase):
    def test_session_disconnects_after_success(self):
        client = MockClient()
        worker = Worker(SimpleNamespace())
        worker.connect = lambda: client
        with worker.session() as c:
            self.assertIs(c, client)
        self.assertEqual(client.disconnected, 1)

    def test_session_disconnects_after_failure(self):
        client = MockClient()
        worker = Worker(SimpleNamespace())
        worker.connect = lambda: client
        with self.assertRaises(RuntimeError):
            with worker.session():
                raise RuntimeError("synthetic screenshot failure")
        self.assertEqual(client.disconnected, 1)

if __name__ == "__main__":
    unittest.main()
