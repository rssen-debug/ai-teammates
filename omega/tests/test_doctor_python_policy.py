"""Guard the installer/doctor Python policy from diverging again."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy


class DoctorPythonPolicyTests(unittest.TestCase):
    def test_doctor_runtime_matches_installer_minimum(self):
        rows = buddy.Doctor(SimpleNamespace()).run("runtime")
        python = next(row for row in rows if row["name"] == "python")
        expected = "PASS" if sys.version_info[:2] >= buddy.PYTHON_MIN else "FAIL"
        self.assertEqual(python["status"], expected)
        if expected == "PASS":
            self.assertFalse(python["fix"])

    def test_311_is_supported_even_if_312_recommended(self):
        self.assertLessEqual(buddy.PYTHON_MIN, (3, 11))
        self.assertGreaterEqual(buddy.PYTHON_MAX_TESTED, (3, 13))
        source = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("supported = (v.major, v.minor) >= PYTHON_MIN", source)
        self.assertNotIn('add("python", "PASS" if v >= (3, 12)', source)


if __name__ == "__main__":
    unittest.main()
