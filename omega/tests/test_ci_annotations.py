"""The CI annotation emitter must spend GitHub's ten-annotation budget on the verdict.

Two Windows runs of this workflow were undecidable from the sandbox: the annotations
were consumed by scenario headings ("1. Fresh installation", "2. Upgrade…") and the
one FAIL line never arrived, while the printed detail was clipped at 220 characters —
`buddy.clip(detail, 220)` keeps 180 and puts the rest on a line nothing matched. The
only diagnostic channel that reaches this sandbox is check-run annotations, so getting
this wrong costs a full CI cycle per guess.

These tests run the emitter as a subprocess against synthetic reports and assert what
a reader would actually see.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EMITTER = HERE.parent.parent / ".github" / "acceptance_annotations.py"

#: A Windows-path detail longer than the 220 characters the harness prints.
LONG_DETAIL = ("install.ps1 -Verify exited 1 with 5 problem(s): x no venv at "
               "C:\\Users\\runneradmin\\AppData\\Roaming\\StuddyBuddy\\venv; x launcher missing: "
               "C:\\Users\\runneradmin\\AppData\\Roaming\\StuddyBuddy\\bin\\buddy.cmd; x PATH does "
               "not contain C:\\Users\\runneradmin\\AppData\\Roaming\\StuddyBuddy\\bin; x required "
               "dependencies are missing: numpy faster-whisper websocket-client winsdk edge-tts; "
               "x buddy doctor runtime reported problems (exit 1)")


def report(rows: list[dict], **extra) -> dict:
    counts = {k: sum(1 for r in rows if r["status"] == k) for k in ("PASS", "FAIL", "BLOCKED", "NOT TESTED")}
    return {"counts": counts, "complete": counts["FAIL"] == 0 and counts["BLOCKED"] == 0,
            "platform": "win32", "python": "3.11.9", "results": rows, **extra}


class EmitterCase(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(EMITTER.is_file(), f"missing CI emitter at {EMITTER}")
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def emit(self, doc: dict | None, name: str = "acceptance-report.json") -> tuple[int, list[str]]:
        path = self.dir / name
        if doc is not None:
            path.write_text(json.dumps(doc), encoding="utf-8")
        proc = subprocess.run([sys.executable, str(EMITTER), str(path)], capture_output=True,
                              text=True, timeout=120, encoding="utf-8", errors="replace")
        return proc.returncode, proc.stdout.splitlines()

    @staticmethod
    def messages(lines: list[str]) -> list[str]:
        """The annotation text a reader sees, and proof each is one single line."""
        out = []
        for line in lines:
            if not line.startswith("::error::"):
                continue  # anything else would be plain log text, not an annotation
            out.append(line.split("acc| ", 1)[1] if "acc| " in line else line)
        return out


class TestTheVerdictIsNeverHidden(EmitterCase):
    def test_a_fail_among_twenty_scenarios_is_reported_with_its_full_detail(self) -> None:
        rows = [{"num": n, "name": f"scenario {n}", "status": "PASS", "detail": "fine"} for n in range(1, 21)]
        rows[5] = {"num": 6, "name": "Read the active application window", "status": "FAIL",
                   "detail": LONG_DETAIL, "fix": "run `buddy accept` on a real desktop"}
        rows[3] = {"num": 4, "name": "KiloCode connectivity", "status": "BLOCKED", "detail": "no API key"}
        rc, lines = self.emit(report(rows))
        msgs = self.messages(lines)
        self.assertEqual(rc, 0)
        self.assertTrue(any(m.startswith("FAIL 6.") and LONG_DETAIL[:400] in m for m in msgs),
                        f"the FAIL and its unclipped detail must be emitted, got: {msgs}")
        self.assertTrue(any("run `buddy accept`" in m for m in msgs), "the fix must be emitted too")

    def test_the_summary_comes_first_and_counts_are_visible(self) -> None:
        rows = [{"num": 1, "name": "one", "status": "FAIL", "detail": "broke"},
                {"num": 2, "name": "two", "status": "BLOCKED", "detail": "no host"}]
        msgs = self.messages(self.emit(report(rows))[1])
        self.assertTrue(msgs[0].startswith("SUMMARY"), f"summary must lead, got: {msgs[0]}")
        self.assertIn("'FAIL': 1", msgs[0].replace('"', "'"))
        self.assertIn("win32", msgs[0], "the platform matters: this is the Windows job")

    def test_headings_cannot_eat_the_budget_before_a_fail(self) -> None:
        """The failure mode that cost two CI cycles: nine PASS rows, then a FAIL."""
        rows = [{"num": n, "name": f"scenario {n}", "status": "PASS", "detail": "fine"} for n in range(1, 19)]
        rows.append({"num": 19, "name": "Run a coding workflow", "status": "FAIL", "detail": "no test runner"})
        msgs = self.messages(self.emit(report(rows))[1])
        self.assertTrue(any(m.startswith("FAIL 19.") for m in msgs),
                        f"a late FAIL must still be emitted, got: {msgs}")

    def test_it_never_emits_more_than_the_budget(self) -> None:
        rows = [{"num": n, "name": f"scenario {n}", "status": "BLOCKED", "detail": "no host for this"}
                for n in range(1, 21)]
        rows[0] = {"num": 1, "name": "one", "status": "FAIL", "detail": "broke"}
        rc, lines = self.emit(report(rows))
        self.assertEqual(rc, 0)
        self.assertLessEqual(len(lines), 9, "GitHub stops at ten per check run and the workflow uses one")
        self.assertTrue(lines[1].startswith("::error::acc| FAIL 1."), "the FAIL must survive the cap")


class TestItCannotCorruptTheLog(EmitterCase):
    def test_percent_signs_are_escaped_because_github_reads_them_as_url_escapes(self) -> None:
        rows = [{"num": 1, "name": "one", "status": "FAIL", "detail": "PATH does not contain %APPDATA%\\bin"}]
        msgs = self.messages(self.emit(report(rows))[1])
        self.assertIn("%25APPDATA%25", "".join(msgs), f"got: {msgs}")

    def test_a_multiline_detail_stays_one_annotation_line(self) -> None:
        rows = [{"num": 1, "name": "one", "status": "FAIL",
                 "detail": "required dependencies are missing:\nnumpy\nwinsdk"}]
        rc, lines = self.emit(report(rows))
        self.assertEqual(rc, 0)
        self.assertTrue(all(line.startswith("::error::") for line in lines),
                        f"every emitted line must be a complete workflow command, got: {lines}")
        self.assertNotIn("numpy", "".join(l for l in lines if not l.startswith("::error::")))


class TestItSurvivesAWindowsConsole(EmitterCase):
    def test_a_cp1252_stdout_does_not_lose_the_annotations(self) -> None:
        """Reproduce the Windows console here: PYTHONIOENCODING=cp1252 plus a \u2717.

        A stock Windows console cannot encode \u2717 or \u25cf, so a naive print raises
        UnicodeEncodeError and the verdict is lost — on the one channel that reaches a
        developer who cannot open the run's logs.
        """
        rows = [{"num": 1, "name": "one", "status": "FAIL",
                 "detail": "\u2717 desktop_context failed \u25cf no foreground window"}]
        path = self.dir / "acceptance-report.json"
        path.write_text(json.dumps(rows and report(rows), ensure_ascii=False), encoding="utf-8")
        env = dict(os.environ, PYTHONIOENCODING="cp1252")
        proc = subprocess.run([sys.executable, str(EMITTER), str(path)], capture_output=True,
                              text=True, timeout=120, encoding="utf-8", errors="replace", env=env)
        self.assertEqual(proc.returncode, 0, f"crashed on a cp1252 console: {proc.stderr[-800:]}")
        msgs = self.messages(proc.stdout.splitlines())
        self.assertTrue(any(m.startswith("FAIL 1.") for m in msgs), f"got: {msgs}")
        self.assertNotIn("UnicodeEncodeError", proc.stderr)


class TestItReportsItsOwnFailure(EmitterCase):
    def test_a_missing_report_says_so_and_exits_nonzero_for_the_fallback(self) -> None:
        rc, lines = self.emit(None)
        self.assertEqual(rc, 1, "the workflow falls back to grepping the raw output on a non-zero exit")
        self.assertIn("no acceptance report", "".join(lines))

    def test_a_corrupt_report_does_not_take_the_step_down(self) -> None:
        (self.dir / "acceptance-report.json").write_text("{not json", encoding="utf-8")
        proc = subprocess.run([sys.executable, str(EMITTER), str(self.dir / "acceptance-report.json")],
                              capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(proc.stdout.startswith("::error::acc| could not read"), proc.stdout)
        self.assertNotIn("Traceback", proc.stderr, "an unreadable report is reported, not raised")

    def test_no_argument_is_an_error_not_a_crash(self) -> None:
        proc = subprocess.run([sys.executable, str(EMITTER)], capture_output=True, text=True,
                              timeout=120, encoding="utf-8", errors="replace")
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("Traceback", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
