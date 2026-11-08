#!/usr/bin/env python3
"""
One command that runs every automated check this product has, and reports the
truth about each of them.

    python omega/tests/run_all.py            # everything
    python omega/tests/run_all.py --quick    # skip the live MAJIN subprocess tests
    python omega/tests/run_all.py --json     # machine-readable

Suites, in order:
  1. omega unit/integration tests      (stdlib unittest — migration, level, MAJIN bridge)
  2. Omega engine self-test            (`buddy.py --self-test` in an isolated data dir)
  3. MAJIN bridge self-test            (real MAJIN V6 MCP subprocess)
  4. MAJIN V6 test suite               (`node --test test/v6/*.test.js`)

Every suite reports PASS / FAIL / BLOCKED / SKIPPED separately. A skip or a
block is never folded into a pass: if this host cannot prove something, the
summary says so and the exit code reflects only what was actually run.

Exit code: 0 when nothing that *ran* failed, 1 otherwise. BLOCKED suites do not
fail the run — they mean "this machine cannot prove it", which is a fact about
the machine, not a defect.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
REPO = OMEGA.parent
MAJIN = REPO / "integrations" / "majin-original"
BUDDY = OMEGA / "buddy.py"


def _run(cmd: list[str], cwd: Path, timeout: float, env: dict | None = None) -> tuple[int, str, str]:
    e = dict(os.environ)
    e.update(env or {})
    try:
        p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout, env=e)
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout:.0f}s"
    except FileNotFoundError as exc:
        return 127, "", f"command not found: {exc}"


def suite_unittest(quick: bool) -> dict:
    """The omega/tests unittest suite, run in-process for real counts."""
    sys.path.insert(0, str(OMEGA))
    sys.path.insert(0, str(HERE))
    # Discover, do not enumerate. A hardcoded module list is how a newly added
    # regression test gets silently skipped and the count stays reassuringly
    # unchanged — that happened once already. `quick` only drops the slow MAJIN
    # bridge module, which needs Node and its installed dependencies.
    QUICK_SKIP = {"test_majin_bridge"}
    modules = sorted(f.stem for f in HERE.glob("test_*.py"))
    missing = []
    if quick:
        modules = [m for m in modules if m not in QUICK_SKIP]
    loader = unittest.TestLoader()
    tests = unittest.TestSuite()
    for n in modules:
        try:
            tests.addTests(loader.loadTestsFromName(n))
        except Exception as exc:  # pragma: no cover
            missing.append(f"{n}: {exc}")
    if not modules:
        missing.append("no test_*.py modules were discovered at all")
    result = unittest.TextTestRunner(verbosity=0, stream=open(os.devnull, "w")).run(tests)
    skipped = sum(1 for _case, _reason in result.skipped)
    status = "FAIL" if (result.failures or result.errors or missing) else "PASS"
    detail = (f"{result.testsRun} run across {len(modules) - len(missing)} module(s), "
              f"{len(result.failures)} failed, {len(result.errors)} errors, {skipped} skipped")
    if missing:
        detail += "; unloadable: " + "; ".join(missing)
    if skipped and status == "PASS":
        # Skips mean this host could not prove those paths. Say so loudly.
        status = "PASS"
        detail += f" — {skipped} test(s) SKIPPED here (MAJIN/Node unavailable), not proven"
    return {"suite": "omega unittest", "status": status, "detail": detail,
            "counts": {"run": result.testsRun, "failed": len(result.failures) + len(result.errors),
                       "skipped": skipped},
            "failures": [str(f[1]).splitlines()[-1] for f in result.failures + result.errors][:12]}


def suite_selftest(report_path: Path) -> dict:
    if not BUDDY.is_file():
        return {"suite": "omega engine self-test", "status": "BLOCKED", "detail": f"{BUDDY} missing"}
    rc, out, err = _run([sys.executable, str(BUDDY), "--self-test"], OMEGA, timeout=900,
                        env={"BUDDY_REPORT_PATH": str(report_path)})
    text = out + err
    m = re.search(r"SUMMARY\s+PASS=(\d+)\s+FAIL=(\d+)\s+BLOCKED=(\d+)\s+NOT TESTED=(\d+)", text)
    counts = ({k: int(v) for k, v in zip(("pass", "fail", "blocked", "not_tested"), m.groups())} if m
              else {"pass": 0, "fail": 1, "blocked": 0, "not_tested": 0})
    status = "FAIL" if (rc != 0 or counts["fail"]) else ("PASS" if counts["pass"] else "BLOCKED")
    failing = re.findall(r"^\s*FAIL\s+(\S+)\s+(.+?)\s+—\s+(.*)$", text, re.MULTILINE)
    return {"suite": "omega engine self-test", "status": status,
            "detail": f"PASS={counts['pass']} FAIL={counts['fail']} BLOCKED={counts['blocked']} "
                      f"NOT_TESTED={counts['not_tested']}",
            "counts": counts, "failures": [f"{a} {b}: {c[:150]}" for a, b, c in failing][:12],
            "report": str(report_path) if report_path.is_file() else ""}


def suite_bridge_selftest() -> dict:
    bridge = OMEGA / "majin_bridge.py"
    if not bridge.is_file():
        return {"suite": "majin bridge self-test", "status": "BLOCKED", "detail": "majin_bridge.py missing"}
    rc, out, err = _run([sys.executable, str(bridge), "--selftest"], OMEGA, timeout=600)
    text = out + err
    m = re.search(r"SUMMARY\s+(.*)", text)
    counts = dict(re.findall(r"(\w[\w ]*?)=(\d+)", m.group(1))) if m else {}
    counts = {k.strip(): int(v) for k, v in counts.items()}
    blocked = counts.get("BLOCKED", 0) and not counts.get("FAIL") and not counts.get("PASS")
    status = "FAIL" if (rc != 0 or counts.get("FAIL")) else ("BLOCKED" if blocked else
                                                             ("PASS" if counts.get("PASS") else "BLOCKED"))
    return {"suite": "majin bridge self-test", "status": status,
            "detail": (m.group(1).strip() if m else text.strip().splitlines()[-1][:160] if text.strip() else "no output"),
            "counts": counts,
            "failures": re.findall(r"^\s*FAIL\s+(.+?)\s{2,}(.*)$", text, re.MULTILINE)[:8]}


def suite_benchmarks() -> dict:
    """The reproducible capability benchmarks that produce level axis E.

    Run with --json so stdout is parseable, and with no --report so the runner
    also refreshes the copy in the owner's real data directory — which is where
    `buddy level` reads axis E from. Running the tests therefore keeps the level
    evidence current instead of leaving it stale.
    """
    runner = OMEGA / "benchmarks" / "runner.py"
    if not runner.is_file():
        return {"suite": "capability benchmarks", "status": "BLOCKED", "detail": f"{runner} missing"}
    rc, out, err = _run([sys.executable, str(runner), "--json"], OMEGA, timeout=900)
    doc: dict = {}
    with contextlib.suppress(Exception):
        doc = json.loads(out)
    if not doc:
        return {"suite": "capability benchmarks", "status": "FAIL",
                "detail": f"the runner produced no parseable report (rc={rc})",
                "failures": [(err or out)[-400:]]}
    m = doc.get("metric") or {}
    run_n = int(m.get("run") or 0)
    passed = float(m.get("passed") or 0.0)
    failures = int(m.get("failures") or 0)
    skipped_n = int(m.get("skipped") or 0)
    axis = round(passed / run_n, 3) if run_n else None
    status = "FAIL" if (rc != 0 or failures) else ("PASS" if run_n else "BLOCKED")
    detail = f"axis E = {axis} ({passed}/{run_n} tasks)" if run_n else "no benchmark could run on this host"
    if skipped_n:
        detail += f" — {skipped_n} skipped here, excluded from the denominator"
    return {"suite": "capability benchmarks", "status": status, "detail": detail,
            "counts": {"run": run_n, "passed": round(passed, 3), "failures": failures,
                       "skipped": skipped_n, "axis_e": axis},
            "failures": [f"{t['id']} {t['name']}: {str(t.get('detail'))[:150]}"
                         for t in doc.get("tasks", []) if t.get("status") == "fail"][:12],
            "report": doc.get("report_path", "")}


def suite_majin_v6() -> dict:
    if not MAJIN.is_dir():
        return {"suite": "majin v6", "status": "BLOCKED", "detail": f"{MAJIN} not present"}
    node = None
    for cand in ("node", "nodejs"):
        rc, out, _ = _run([cand, "--version"], MAJIN, timeout=20)
        if rc == 0:
            node = cand
            break
    if node is None:
        return {"suite": "majin v6", "status": "BLOCKED", "detail": "Node.js not found"}
    if not (MAJIN / "node_modules").is_dir():
        return {"suite": "majin v6", "status": "BLOCKED",
                "detail": f"dependencies not installed — run: cd {MAJIN} && npm install"}
    tests = sorted((MAJIN / "test" / "v6").glob("*.test.js"))
    if not tests:
        return {"suite": "majin v6", "status": "BLOCKED", "detail": "no test/v6 tests found"}
    rc, out, err = _run([node, "--test", *[str(t) for t in tests]], MAJIN, timeout=900)
    text = out + err
    def num(key: str) -> int:
        m = re.search(rf"^# {key} (\d+)", text, re.MULTILINE)
        return int(m.group(1)) if m else 0
    counts = {"pass": num("pass"), "fail": num("fail"), "skipped": num("skipped"), "tests": num("tests")}
    status = "FAIL" if (rc != 0 or counts["fail"]) else ("PASS" if counts["pass"] else "BLOCKED")
    return {"suite": "majin v6 (node --test)", "status": status,
            "detail": f"{counts['pass']} pass / {counts['fail']} fail / {counts['skipped']} skipped "
                      f"of {counts['tests']} ({len(tests)} files)",
            "counts": counts,
            "failures": re.findall(r"^not ok \d+ - (.+)$", text, re.MULTILINE)[:12]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="buddy prove --all", description="run every automated check and report the truth")
    ap.add_argument("--quick", action="store_true", help="skip suites that spawn the live MAJIN subprocess")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", default="", help="write the JSON report to this path")
    a = ap.parse_args(argv)

    # UTF-8 with replacement, before anything is printed. This reporter emits `—`
    # and a `✗` bullet; on a cp1252 Windows console the bullet raised
    # UnicodeEncodeError, so a failing suite crashed the reporter instead of being
    # reported — the one moment the output matters most.
    for _stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            _stream.reconfigure(encoding="utf-8", errors="replace")

    started = time.time()
    report_path = Path(a.out) if a.out else (OMEGA / "last_full_test_report.json")
    selftest_report = report_path.with_name("last_selftest_report.json")

    results = [suite_unittest(a.quick)]
    results.append(suite_selftest(selftest_report))
    results.append(suite_benchmarks())
    if not a.quick:
        results.append(suite_bridge_selftest())
    results.append(suite_majin_v6())

    total = {"PASS": 0, "FAIL": 0, "BLOCKED": 0}
    for r in results:
        total[r["status"]] = total.get(r["status"], 0) + 1
    doc = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "platform": sys.platform,
           "python": sys.version.split()[0], "quick": a.quick,
           "duration_s": round(time.time() - started, 1), "suites": results, "totals": total,
           "exit_ok": total["FAIL"] == 0}
    if a.out or True:
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    if a.json:
        print(json.dumps(doc, indent=2, ensure_ascii=False))
    else:
        icon = {"PASS": "\033[32m", "FAIL": "\033[31m", "BLOCKED": "\033[33m"}
        print("\nSTUDDY BUDDY OMEGA — FULL AUTOMATED VERIFICATION\n")
        for r in results:
            colour = icon.get(r["status"], "")
            print(f"  {colour}{r['status']:<8}\033[0m {r['suite']:<28} {r['detail']}")
            for f in r.get("failures") or []:
                print(f"           \033[31m✗\033[0m {f}")
        print(f"\n  SUITES  PASS={total['PASS']}  FAIL={total['FAIL']}  BLOCKED={total['BLOCKED']}"
              f"   ({doc['duration_s']}s, {doc['platform']}, python {doc['python']})")
        print("  BLOCKED means this machine cannot prove it — it is never counted as a pass.")
        print(f"  report: {report_path}\n")
    return 1 if total["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
