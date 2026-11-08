"""Benchmark runner — capability axis E for `omega/level.py`.

Runs `omega/benchmarks/tasks.py` against an **isolated** data directory, so a
benchmark can never touch the owner's real memory, tasks or settings, and writes
a reproducible report that the level computation reads.

    python omega/benchmarks/runner.py                 # run everything, human output
    python omega/benchmarks/runner.py --json          # machine-readable
    python omega/benchmarks/runner.py B01 B08         # a subset (positional ids)
    python omega/benchmarks/runner.py --list          # what would run
    python omega/benchmarks/runner.py --report PATH   # where to write the report

The report is what makes the level honest: it records every task's score, the
evidence behind it, the host, and which tasks were skipped and why. A skipped
task is excluded from both the numerator and the denominator — this machine is
never punished for hardware it does not have.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import platform
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent

#: Benchmarks must run somewhere disposable. Setting BUDDY_HOME *before* buddy is
#: imported is what makes that real rather than aspirational.
_SCRATCH = Path(os.environ.get("BUDDY_BENCH_HOME") or tempfile.mkdtemp(prefix="buddy-bench-"))


def _default_home() -> Path:
    """Where the owner's real data lives — mirrors buddy._resolve_home().

    Captured *before* BUDDY_HOME is repointed at the scratch directory, so a
    benchmark run from a plain shell still leaves its report where `buddy level`
    will actually find it.
    """
    env = os.environ.get("BUDDY_HOME")
    if env:
        return Path(env)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy"
    return Path.home() / ".studdybuddy"


_REAL_HOME = _default_home()
os.environ["BUDDY_HOME"] = str(_SCRATCH)
if str(OMEGA) not in sys.path:
    sys.path.insert(0, str(OMEGA))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import buddy  # noqa: E402  (must be imported after BUDDY_HOME is set)
import tasks as bench_tasks  # noqa: E402

REPORT_SCHEMA = "studdybuddy.omega.benchmark-report/v1"
BENCH_VERSION = "1.0.0"


def _detect_node() -> bool:
    exe = shutil.which("node")
    if not exe:
        return False
    try:
        import subprocess
        r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20)
        return r.returncode == 0
    except Exception:
        return False


def run(only: Optional[list[str]] = None, report_path: Optional[Path] = None,
        quiet: bool = False) -> dict[str, Any]:
    buddy.ensure_dirs()
    app = buddy.Buddy(headless=True)
    for scope in ("observe", "input", "write", "exec"):
        app.perms.set(scope, "always")
    # Scenario scratch space lives under the workspace directory: it is the one
    # part of BUDDY_HOME the path guard deliberately lets the agent write to.
    work = Path(tempfile.mkdtemp(prefix="bench-work-", dir=str(buddy.DIRS["workspace"])))
    ctx = bench_tasks.BenchCtx(app=app, tmp=work, home=buddy.HOME,
                               key=bool(app.gateway.key()), node=_detect_node())

    wanted = {w.upper() for w in (only or [])}
    started = time.time()
    rows: list[dict[str, Any]] = []
    for bid, name, fn in bench_tasks.BENCHMARKS:
        if wanted and bid.upper() not in wanted:
            continue
        t0 = time.time()
        try:
            out = fn(ctx)
        except Exception as e:
            out = bench_tasks.BenchOutcome(
                0.0, f"the benchmark raised {type(e).__name__}: {buddy.clip(str(e), 300)}",
                {"traceback": traceback.format_exc()[-1200:]})
        secs = round(time.time() - t0, 2)
        if out.score is None:
            status = "skip"
        elif out.score >= 1.0:
            status = "pass"
        elif out.score > 0.0:
            status = "partial"
        else:
            status = "fail"
        rows.append({"id": bid, "name": name, "status": status, "score": out.score,
                     "seconds": secs, "detail": out.detail, "fix": out.fix,
                     "evidence": out.evidence})
        if not quiet:
            # Under --json these progress lines would make stdout unparseable, so
            # machine-readable output stays machine-readable.
            mark = {"pass": "+", "partial": "~", "fail": "x", "skip": "-"}[status]
            score_txt = "  n/a" if out.score is None else f"{out.score:.2f}"
            print(f"  [{mark}] {bid}  {score_txt}  {name}  ({secs}s)", flush=True)
            if status in ("fail", "partial"):
                print(f"        {buddy.clip(out.detail, 200)}", flush=True)

    executed = [r for r in rows if r["status"] != "skip"]
    skipped = [r for r in rows if r["status"] == "skip"]
    # `passed` is the SUM OF SCORES, so partial credit survives: a task that got
    # 26 of 30 intents right contributes 0.867, not a flat 0 or 1. level.py
    # computes axis E as passed / run.
    score_sum = round(sum(float(r["score"] or 0.0) for r in executed), 4)
    doc = {
        "schema": REPORT_SCHEMA,
        "benchmark_version": BENCH_VERSION,
        "app_version": buddy.APP_VERSION,
        "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "host": {"platform": sys.platform, "release": platform.release(),
                 "python": platform.python_version(), "machine": platform.machine()},
        "isolated_home": str(buddy.HOME),
        "api_key_present": ctx.key,
        "node_present": ctx.node,
        "metric": {"definition": "passed = sum of per-task scores (partial credit); run = tasks actually "
                                 "executed. Skipped tasks are excluded from both.",
                   "passed": score_sum, "run": len(executed), "total": len(executed),
                   "tasks": len(rows), "skipped": len(skipped),
                   "whole_passes": sum(1 for r in executed if r["status"] == "pass"),
                   "partials": sum(1 for r in executed if r["status"] == "partial"),
                   "failures": sum(1 for r in executed if r["status"] == "fail")},
        "seconds": round(time.time() - started, 1),
        "tasks": rows,
    }
    # level.py looks for exactly these two keys at the top level.
    doc["passed"] = score_sum
    doc["run"] = len(executed)
    doc["total"] = len(executed)

    # Never the scratch home: the whole point of the report is that level.py can
    # read it back from the owner's real data directory afterwards.
    dest = report_path or (_REAL_HOME / "last_benchmark_report.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(doc, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    doc["report_path"] = str(dest)

    with contextlib.suppress(Exception):
        # Buddy.close is a coroutine; awaiting it properly avoids the
        # "coroutine was never awaited" warning that would otherwise pollute the
        # report of an otherwise clean run.
        asyncio.run(app.close())
    shutil.rmtree(work, ignore_errors=True)
    return doc


def _render(doc: dict[str, Any]) -> None:
    m = doc["metric"]
    C = buddy.C
    print()
    print(C.c(C.B, "STUDDY BUDDY OMEGA — CAPABILITY BENCHMARKS  ") + C.c(C.DIM, f"({doc['benchmark_version']})"))
    print(C.c(C.DIM, f"  host {doc['host']['platform']} · python {doc['host']['python']} · "
                     f"node {'yes' if doc['node_present'] else 'no'} · "
                     f"key {'yes' if doc['api_key_present'] else 'no'}\n"))
    for r in doc["tasks"]:
        col = {"pass": C.G, "partial": C.Y, "fail": C.R, "skip": C.DIM}[r["status"]]
        score = "  n/a" if r["score"] is None else f"{r['score']:.3f}"
        print(f"  {C.c(col, r['status'].upper()):<22} {r['id']}  {score}  {r['name']}")
    print()
    print(f"  axis E input: passed={m['passed']} / run={m['run']}"
          + (f"  →  {(m['passed'] / m['run']):.3f}" if m["run"] else "  →  unmeasured"))
    print(f"  {m['whole_passes']} full pass · {m['partials']} partial · {m['failures']} fail · {m['skipped']} skipped"
          f"   ({doc['seconds']}s)")
    if m["skipped"]:
        print(C.c(C.Y, "  skipped means this host cannot prove it — it is excluded, never counted as a pass:"))
        for r in doc["tasks"]:
            if r["status"] == "skip":
                print(C.c(C.DIM, f"    {r['id']}: {buddy.clip(r['detail'], 150)}"))
                if r.get("fix"):
                    print(C.c(C.CY, f"        fix: {r['fix']}"))
    if m["failures"]:
        print(C.c(C.R, "  failures — real defects, with evidence:"))
        for r in doc["tasks"]:
            if r["status"] == "fail":
                print(C.c(C.DIM, f"    {r['id']}: {buddy.clip(r['detail'], 200)}"))
    print(C.c(C.DIM, f"\n  report: {doc.get('report_path')}\n"))


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="buddy bench", description="run the reproducible capability benchmarks")
    ap.add_argument("ids", nargs="*", help="benchmark ids to run (default: all)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--report", default="", help="where to write the report JSON")
    a = ap.parse_args(argv)
    if a.list:
        print("\nCAPABILITY BENCHMARKS\n")
        for bid, name, _fn in bench_tasks.BENCHMARKS:
            print(f"  {bid}  {name}")
        print("\nScores measure capability only. Tokens, runtime and output volume are never inputs.\n")
        return 0
    doc = run(only=[x for x in a.ids if x] or None,
              report_path=Path(a.report) if a.report else None, quiet=a.json)
    if a.json:
        print(json.dumps(doc, indent=2, ensure_ascii=False, default=str))
    else:
        _render(doc)
    m = doc["metric"]
    return 1 if m["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
