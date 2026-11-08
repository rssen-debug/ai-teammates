"""Windows app launches cannot inherit or pollute prompt_toolkit terminal streams."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy

class IsolatedLaunchTest(unittest.TestCase):
    def test_edge_alias_uses_isolated_windows_launcher(self):
        with patch.object(buddy.Win32, "need"), patch.object(buddy.os, "startfile", create=True) as start:
            buddy.Win32.launch("edge")
        start.assert_called_once_with("msedge.exe")

    def test_failed_shell_fallback_does_not_inherit_terminal_output(self):
        result = SimpleNamespace(returncode=1, stderr="cannot find edge")
        with patch.object(buddy.Win32, "need"), patch.object(buddy.os, "startfile", create=True, side_effect=OSError("not found")), patch.object(buddy.subprocess, "run", return_value=result) as cmd:
            with self.assertRaises(OSError):
                buddy.Win32.launch("edge")
        kw = cmd.call_args.kwargs
        self.assertEqual(kw["stdin"], buddy.subprocess.DEVNULL)
        self.assertEqual(kw["stdout"], buddy.subprocess.PIPE)
        self.assertEqual(kw["stderr"], buddy.subprocess.PIPE)

    def test_explicit_args_detach_child_std_streams(self):
        with patch.object(buddy.Win32, "need"), patch.object(buddy.subprocess, "Popen") as popen:
            buddy.Win32.launch("notepad", ["C:/tmp/foo.txt"])
        kw = popen.call_args.kwargs
        self.assertEqual(kw["stdin"], buddy.subprocess.DEVNULL)
        self.assertEqual(kw["stdout"], buddy.subprocess.DEVNULL)
        self.assertEqual(kw["stderr"], buddy.subprocess.DEVNULL)

if __name__ == "__main__":
    unittest.main()
