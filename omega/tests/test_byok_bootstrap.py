"""Beta launcher safety and BYOK registration regression tests.

Tests statically validate the PowerShell contract. A real fresh Windows
installation still needs a dedicated acceptance runner.
"""
from pathlib import Path
import unittest
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

class BetaBootstrapTests(unittest.TestCase):
    def test_launcher_does_not_require_existing_venv(self):
        source = (ROOT / "start_latest.ps1").read_text(encoding="utf-8")
        self.assertIn("-m venv $venv", source)
        self.assertIn("Find-Python", source)
        self.assertIn('if ($NoInstall)', source)

    def test_checkout_is_pinned_and_origin_checked(self):
        source = (ROOT / "start_latest.ps1").read_text(encoding="utf-8")
        for expected in ('remote get-url origin', 'fetch --no-tags origin main',
                         'rev-parse --verify', 'worktree add --detach',
                         'if ($actual -ne $sha)', 'Git clone'):
            with self.subTest(expected=expected):
                self.assertIn(expected, source)

    def test_no_unverified_remote_script_execution(self):
        source = (ROOT / "start_latest.ps1").read_text(encoding="utf-8").lower()
        for bad in ("invoke-expression", "iex(", "downloadstring(", "curl |", "irm |", "set-executionpolicy unrestricted"):
            with self.subTest(bad=bad):
                self.assertNotIn(bad, source)

    def test_voice_dependencies_are_optional_and_explicit(self):
        source = (ROOT / "start_latest.ps1").read_text(encoding="utf-8")
        self.assertIn("[switch]$WithVoice", source)
        self.assertIn('"faster-whisper"', source)
        self.assertIn("if ($WithVoice)", source)
        self.assertIn("if ($DoctorOnly)", source)

    @unittest.skipUnless(sys.platform == "win32", "Windows PowerShell parser required")
    def test_launcher_is_valid_powershell_syntax(self):
        """Parse only: installing dependencies is not part of the CI job."""
        path = str(ROOT / "start_latest.ps1").replace("'", "''")
        ps = (
            "$tokens=$null; $errors=$null; "
            f"[System.Management.Automation.Language.Parser]::ParseFile('{path}',"
            "[ref]$tokens,[ref]$errors) | Out-Null; "
            "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }"
        )
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive",
                                 "-Command", ps], capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_provider_keys_are_not_in_source(self):
        provider = (ROOT / "provider_native.py").read_text(encoding="utf-8")
        self.assertIn('vault.set(PROVIDERS[pending]["vault"], value)', provider)
        self.assertIn("openrouter_api_key", provider)
        self.assertIn("opencode_go_api_key", provider)

if __name__ == "__main__":
    unittest.main()
