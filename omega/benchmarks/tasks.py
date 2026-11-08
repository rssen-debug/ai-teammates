"""Reproducible capability benchmarks for STUDDY BUDDY OMEGA.

These feed capability axis E (benchmark performance) in `omega/level.py`.

The rules that make them worth anything:

  * Every task exercises **real product code** — the actual registry, permission
    gate, memory engine, task engine, executor, migration utility and level
    computation. Nothing is reimplemented here to make a number look good.
  * Every task is **deterministic**: no model calls, no network, no wall-clock
    thresholds, fixed inputs. Two runs on the same host must agree.
  * A task that cannot run on this host returns `score=None` and is **skipped**,
    excluded from both the numerator and the denominator. A Linux machine with no
    Node and no microphone must not be scored as if it had failed.
  * Scores measure *capability*: did the right tool get found, did the effect land
    exactly once, did the test suite actually go green. Never tokens, never
    runtime, never how much text was produced.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
if str(OMEGA) not in sys.path:
    sys.path.insert(0, str(OMEGA))

import buddy  # noqa: E402


@dataclass
class BenchCtx:
    """Everything a benchmark task may touch. Isolated by the runner."""
    app: Any
    tmp: Path
    home: Path
    key: bool
    node: bool
    log: list = field(default_factory=list)

    def run(self, coro):
        return asyncio.run(coro)

    def tool(self, name: str, args: dict, **kw):
        return asyncio.run(buddy.exec_tool(self.app, name, args, **kw))


@dataclass
class BenchOutcome:
    #: 0.0–1.0 when the task ran, or None when it could not run on this host.
    score: Optional[float]
    detail: str
    evidence: dict = field(default_factory=dict)
    #: How to make THIS HOST able to run the task. Only meaningful for a skip.
    #: It used to be passed as an evidence keyword and so ended up buried inside
    #: the evidence dict — where neither the human renderer nor anything reading
    #: --json would look for it. A skip without its remedy is just a shrug, so it
    #: is a first-class field now.
    fix: str = ""


def skipped(why: str, fix: str = "", **ev) -> BenchOutcome:
    return BenchOutcome(None, f"SKIPPED: {why}", ev, fix=fix)


def scored(hits: int, total: int, detail: str, **ev) -> BenchOutcome:
    ev.update({"passed": hits, "total": total})
    return BenchOutcome((hits / total) if total else 0.0, detail, ev)


# ════════════════════════════════════════════════════════════════════════════
# B01 · tool routing — can the agent find the right tool from how a person asks?
# ════════════════════════════════════════════════════════════════════════════
#: Realistic phrasings, each mapped to the tool that should actually handle it.
#: The expected names are real entries in the registry, verified by the test.
#: Where a phrasing is genuinely ambiguous, the value is a tuple and ANY of them
#: counts — insisting on one would measure my guess about an ambiguous sentence
#: rather than the router. Only one intent qualifies, and it is marked below.
INTENTS: list[tuple[str, str]] = [
    ("read the contents of a text file", "file_read"),
    ("write text into a new file", "file_write"),
    ("append a line to a log file", "file_append"),
    ("replace one line in a source file", "file_patch"),
    ("find files whose name matches", "file_search"),
    ("list the files in this folder", "file_list"),
    ("move a file to the trash", "file_trash"),
    ("run the project's tests", "dev_run_tests"),
    ("summarize what this repository contains", "dev_analyze_project"),
    ("schedule background work for later", "task_create"),
    ("list my background tasks", "task_list"),
    ("cancel a running task", "task_cancel"),
    ("remember this preference for later", "memory_save"),
    ("what do I already know about this", "memory_search"),
    ("take a screenshot of the screen", "screen_capture"),
    ("which windows are open right now", "desktop_windows"),
    ("click the Save button in the dialog", "ui_click"),
    ("type text into the focused field", "type_text"),
    ("press the keyboard shortcut ctrl s", "key_press"),
    ("open a url in the browser", "browser_navigate"),
    ("read the text of the current web page", "browser_dom_text"),
    ("run a shell command", "run_command"),
    ("search the web for this", "web_search"),
    ("fetch the contents of a url", "web_fetch"),
    ("launch notepad", "app_launch"),
    ("list the running processes", "process_list"),
    ("kill a process", "process_kill"),
    ("diagnose what is wrong with the system", "self_diagnose"),
    # "the job application queue" is genuinely ambiguous: MAJIN has a durable task
    # queue AND an application history, and both are a defensible reading.
    ("check the job application queue", ("majin_queue_list", "majin_jobs_list")),
    ("install a missing python package", "install_dependency"),
]


def b01_tool_routing(ctx: BenchCtx) -> BenchOutcome:
    core = {t.name for t in ctx.app.registry.core()}
    hits, misses, ranks, by_core = [], [], [], []
    for intent, want in INTENTS:
        acceptable = want if isinstance(want, tuple) else (want,)
        # A core tool is in the agent's active set unconditionally, and search()
        # deliberately never returns one — there would be nothing to discover.
        # Counting that as a routing miss would punish the router for being right.
        if any(w in core for w in acceptable):
            by_core.append({"intent": intent, "served_by_core": sorted(set(acceptable) & core)})
            hits.append(intent)
            ranks.append(1)
            continue
        found = [t.name for t in ctx.app.registry.search(intent, limit=5)]
        best = min((found.index(w) for w in acceptable if w in found), default=None)
        if best is not None:
            hits.append(intent)
            ranks.append(best + 1)
        else:
            misses.append({"intent": intent, "expected": list(acceptable), "got": found})
    top1 = sum(1 for r in ranks if r == 1)
    discovered = len(INTENTS) - len(by_core)
    return scored(len(hits), len(INTENTS),
                  f"{len(hits)}/{len(INTENTS)} intents reached the right tool ({top1} as the first "
                  f"result; {len(by_core)} are served by an always-available core tool, "
                  f"{discovered} had to be discovered by search)",
                  misses=misses, served_by_core=by_core,
                  mean_rank=round(sum(ranks) / len(ranks), 2) if ranks else None,
                  first_choice_rate=round(top1 / len(INTENTS), 3))


# ════════════════════════════════════════════════════════════════════════════
# B02 · argument validation — bad arguments must be refused, not executed
# ════════════════════════════════════════════════════════════════════════════
def b02_arg_validation(ctx: BenchCtx) -> BenchOutcome:
    never = ctx.tmp / "must-not-exist.txt"
    cases = [
        ("file_read", {}, "a missing required path"),
        ("file_write", {"content": "x"}, "content without a path"),
        ("file_write", {"path": str(never)}, "a path without content"),
        ("file_patch", {"path": str(never), "find": "a"}, "find without replace"),
        ("memory_save", {"title": "t"}, "a title without content"),
        ("task_create", {}, "neither title nor plan"),
        ("file_read", {"path": 12345}, "a path of the wrong type"),
    ]
    refused, leaked = [], []
    for name, args, why in cases:
        res = ctx.tool(name, args)
        if (not res.ok) and res.category in ("invalid_args", "not_found", "validation"):
            refused.append({"tool": name, "why": why, "category": res.category})
        else:
            leaked.append({"tool": name, "why": why, "ok": res.ok, "category": res.category,
                           "error": buddy.clip(res.error or "", 160)})
    created = never.exists()
    if created:
        leaked.append({"tool": "file_write", "why": "an invalid call still created the file", "ok": True})
    total = len(cases) + (1 if created else 0)
    return scored(len(refused), total,
                  f"{len(refused)}/{total} invalid calls refused before any effect"
                  + ("" if not created else "; a file was created by an invalid call"),
                  refused=refused, leaked=leaked, file_created=created)


# ════════════════════════════════════════════════════════════════════════════
# B03 · permission boundaries — background work cannot invent its own grants
# ════════════════════════════════════════════════════════════════════════════
def b03_permission_boundary(ctx: BenchCtx) -> BenchOutcome:
    app = ctx.app
    app.perms.set("exec", None)
    denied = ctx.tool("run_command", {"command": "echo should-not-run"}, background=True)
    app.perms.set("exec", "always")
    allowed = ctx.tool("run_command", {"command": "echo permitted"})
    app.perms.set("write", "always")
    protected = ctx.tool("file_write", {"path": str(buddy.HOME / "buddy.db"), "content": "x"})
    sensitive = ctx.tool("install_dependency", {"module": "numpy"}, background=True)
    checks = {
        "ungranted_background_exec_denied": (not denied.ok) and denied.category == "permission_denied",
        "granted_exec_allowed": bool(allowed.ok),
        "sensitive_in_background_refused": not sensitive.ok,
        "protected_path_refused": not protected.ok,
    }
    audit_rows = app.store.one("SELECT COUNT(*) AS n FROM audit")["n"]
    checks["audit_trail_written"] = audit_rows > 0
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)} permission invariants held ({audit_rows} audit rows)",
                  checks=checks, categories={"denied": denied.category, "protected": protected.category,
                                             "sensitive": sensitive.category})


# ════════════════════════════════════════════════════════════════════════════
# B04 · memory retrieval — seeded facts must come back, best match first
# ════════════════════════════════════════════════════════════════════════════
FACTS = [
    ("Editor preference", "The owner prefers Neovim over VS Code for editing Python", "which editor does the owner prefer"),
    ("Database choice", "PostgreSQL is used for the billing service, not MySQL", "what database does billing use"),
    ("Deploy window", "Deploys are only allowed on Tuesdays before 15:00", "when is it allowed to deploy"),
    ("Coffee order", "The owner drinks black coffee without sugar", "how does the owner take their coffee"),
    ("Test runner", "The monorepo uses pnpm and vitest for frontend tests", "which test runner do the frontend packages use"),
    ("SSH host", "The staging box is reachable as staging.internal on port 2222", "how do I reach the staging server"),
    ("Naming rule", "Branch names must start with the ticket id", "what is the branch naming rule"),
    ("License", "The client requires MIT licensing on all deliverables", "which licence does the client require"),
]


def b04_memory_retrieval(ctx: BenchCtx) -> BenchOutcome:
    app = ctx.app
    stamp = int(time.time())
    for i, (title, content, _q) in enumerate(FACTS):
        app.memory.save("fact", f"{title} {stamp}-{i}", content, "benchmark")
    hit3, mrr, misses = 0, 0.0, []
    for i, (title, _c, query) in enumerate(FACTS):
        want = f"{title} {stamp}-{i}"
        got = [m["title"] for m in app.memory.search(query, limit=3, touch=False)]
        if want in got:
            hit3 += 1
            mrr += 1.0 / (got.index(want) + 1)
        else:
            misses.append({"query": query, "expected": want, "got": got})
    n = len(FACTS)
    recall = hit3 / n
    mrr /= n
    # The blended score: recall matters most, ranking quality second.
    score = 0.7 * recall + 0.3 * mrr
    return BenchOutcome(score,
                        f"hit@3 {hit3}/{n} (recall {recall:.2f}), MRR {mrr:.2f}, blended {score:.2f}",
                        {"recall_at_3": round(recall, 3), "mrr": round(mrr, 3), "blended": round(score, 3),
                         "misses": misses})


# ════════════════════════════════════════════════════════════════════════════
# B05 · exactly-once effects — a retry must not apply the same effect twice
# ════════════════════════════════════════════════════════════════════════════
def b05_effect_idempotency(ctx: BenchCtx) -> BenchOutcome:
    """A crash-replay must not apply the same irreversible effect twice.

    The guard is deliberately scoped to `resumed=True`: within a single run an
    agent may legitimately append the same line twice, so that is not what this
    measures. What it measures is the guarantee that matters for "never submit
    the same job application twice" — after a restart, a step that already
    completed is recognised and skipped, and says so.
    """
    app = ctx.app
    target = ctx.tmp / "idempotent.txt"
    tid = "bench_b05"
    run = buddy.AgentRun(app, "benchmark: idempotent write", background=True, task_id=tid)
    first_pass = buddy.ToolContext(app, run, tid, True, False)   # the run that crashes
    replay = buddy.ToolContext(app, run, tid, True, True)        # the run that resumes
    write_args = {"path": str(target), "content": "written once\n", "overwrite": True}
    append_args = {"path": str(target), "content": "appended once\n"}

    w1 = asyncio.run(app.executor.execute(app.registry.get("file_write"), write_args, first_pass))
    a1 = asyncio.run(app.executor.execute(app.registry.get("file_append"), append_args, first_pass))
    after_first = target.read_text(encoding="utf-8") if target.is_file() else ""
    # now replay both, exactly as a resumed task would
    w2 = asyncio.run(app.executor.execute(app.registry.get("file_write"), write_args, replay))
    a2 = asyncio.run(app.executor.execute(app.registry.get("file_append"), append_args, replay))
    after_replay = target.read_text(encoding="utf-8") if target.is_file() else ""

    def was_skipped(r) -> bool:
        return bool(r.ok) and isinstance(r.data, dict) and "skipped" in r.data

    checks = {
        "first_pass_applied_both_effects": w1.ok and a1.ok and after_first == "written once\nappended once\n",
        "replayed_write_was_skipped": was_skipped(w2),
        "replayed_append_was_skipped": was_skipped(a2),
        "replay_changed_nothing_on_disk": after_replay == after_first,
        "the_skip_is_reported_not_silent": "already completed" in buddy.jdump(w2.data or {}).lower()
                                           or "not repeated" in buddy.jdump(w2.data or {}).lower(),
    }
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)} exactly-once invariants held; replaying both effects left the file "
                  f"unchanged at {after_replay!r}",
                  checks=checks, after_first=after_first, after_replay=after_replay,
                  results=[{"ok": r.ok, "skipped": "skipped" in (r.data or {}) if isinstance(r.data, dict) else False,
                            "error": buddy.clip(r.error or "", 120)} for r in (w1, a1, w2, a2)])


# ════════════════════════════════════════════════════════════════════════════
# B06 · plan execution — a deterministic multi-step plan must really complete
# ════════════════════════════════════════════════════════════════════════════
def b06_plan_execution(ctx: BenchCtx) -> BenchOutcome:
    app = ctx.app
    out = ctx.tmp / "plan.txt"
    steps = [
        {"tool": "file_write", "args": {"path": str(out), "content": "one\n", "overwrite": True}},
        {"tool": "file_append", "args": {"path": str(out), "content": "two\n"}},
        {"tool": "file_append", "args": {"path": str(out), "content": "three\n"}},
        {"tool": "file_read", "args": {"path": str(out)}, "expect_contains": "three"},
    ]
    tid = app.tasks.create("benchmark plan execution", {"kind": "steps", "steps": steps})

    async def drain() -> str:
        app.loop = asyncio.get_running_loop()
        for _ in range(200):
            t = app.tasks.get(tid)
            if not t or t["state"] in ("done", "failed", "blocked", "cancelled"):
                return t["state"] if t else "missing"
            claimed = app.tasks.claim()
            if claimed:
                await app.tasks.run_one(claimed)
            await asyncio.sleep(0.02)
        return "timeout"

    state = asyncio.run(drain())
    content = out.read_text(encoding="utf-8") if out.is_file() else ""
    row = dict(app.tasks.get(tid) or {})
    checks = {
        "reached_done": state == "done",
        "content_exact": content == "one\ntwo\nthree\n",
        "checkpoint_written": bool(app.tasks.last_checkpoint(tid)),
        "outcome_recorded": app.store.one(
            "SELECT content FROM memories WHERE kind='task_outcome' AND title LIKE ?", (f"Task {tid}%",)) is not None,
    }
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)}: state={state}, file={content!r}",
                  checks=checks, state=state, content=content, error=row.get("error"),
                  attempts=row.get("attempts"))


# ════════════════════════════════════════════════════════════════════════════
# B07 · crash recovery — a killed worker resumes without repeating an effect
# ════════════════════════════════════════════════════════════════════════════
def b07_crash_recovery(ctx: BenchCtx) -> BenchOutcome:
    app = ctx.app
    out = ctx.tmp / "crash.txt"
    steps = [{"tool": "file_append", "args": {"path": str(out), "content": f"s{i}\n"}} for i in (1, 2, 3)]
    tid = app.tasks.create("benchmark crash recovery", {"kind": "steps", "steps": steps})
    env = {**os.environ, "BUDDY_HOME": str(ctx.home), "BUDDY_TEST_CHILD": "1", "BUDDY_TEST_CRASH_AT": "1"}
    try:
        crash = subprocess.run([sys.executable, str(buddy.SOURCE_FILE), "--_child", "crash-task"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240, env=env, cwd=str(OMEGA))
        # Read the partial state HERE, between the crash and the resume. Reading
        # it afterwards would just re-read the finished file and prove nothing.
        partial = out.read_text(encoding="utf-8") if out.is_file() else ""
        state_at_crash = dict(app.tasks.get(tid) or {})
        resume = subprocess.run([sys.executable, str(buddy.SOURCE_FILE), "--_child", "resume-crashed"],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
                                env={**os.environ, "BUDDY_HOME": str(ctx.home)}, cwd=str(OMEGA))
    except subprocess.TimeoutExpired as e:
        return skipped(f"a child process timed out ({e})")
    final = out.read_text(encoding="utf-8") if out.is_file() else ""
    row = dict(app.tasks.get(tid) or {})
    checks = {
        "child_died_mid_task": crash.returncode == 9,
        "partial_progress_was_real": 0 < len(partial) < len("s1\ns2\ns3\n"),
        "task_was_left_running_by_the_crash": state_at_crash.get("state") == "running",
        "resume_recovered_the_lease": '"recovered"' in resume.stdout and tid in resume.stdout,
        "finished_exactly_once": final == "s1\ns2\ns3\n",
        "final_state_done": row.get("state") == "done",
    }
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)}: killed rc={crash.returncode}, partial={partial!r}, final={final!r}",
                  checks=checks, partial=partial, final=final, state=row.get("state"),
                  resume_stdout=buddy.clip(resume.stdout, 300), resume_stderr=buddy.clip(resume.stderr, 300))


# ════════════════════════════════════════════════════════════════════════════
# B08 · coding repair — analyse, patch, and the real test runner goes green
# ════════════════════════════════════════════════════════════════════════════
def b08_coding_repair(ctx: BenchCtx) -> BenchOutcome:
    proj = ctx.tmp / "bench-proj"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "calc.py").write_text("def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n",
                                  encoding="utf-8")
    (proj / "test_calc.py").write_text(
        "import unittest\nfrom calc import add, mul\n\n\nclass T(unittest.TestCase):\n"
        "    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n"
        "    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n\n\n"
        "if __name__ == '__main__':\n    unittest.main()\n", encoding="utf-8")
    analyzed = ctx.tool("dev_analyze_project", {"path": str(proj)})
    before = ctx.tool("dev_run_tests", {"path": str(proj)})
    patched = ctx.tool("file_patch", {"path": str(proj / "calc.py"), "find": "return a - b", "replace": "return a + b"})
    after = ctx.tool("dev_run_tests", {"path": str(proj)})
    rc_before = (before.data or {}).get("exit_code")
    rc_after = (after.data or {}).get("exit_code")
    checks = {
        "project_analysed": bool(analyzed.ok) and "calc.py" in ((analyzed.data or {}).get("files") or []),
        "tests_red_before": rc_before not in (0, None),
        "patch_applied": bool(patched.ok) and "return a + b" in (proj / "calc.py").read_text(encoding="utf-8"),
        "tests_green_after": rc_after == 0,
    }
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)}: analysed, patched, real test runner rc {rc_before} → {rc_after}",
                  checks=checks, rc_before=rc_before, rc_after=rc_after,
                  analyze_error=analyzed.error, patch_error=patched.error,
                  before_error=before.error, after_error=after.error)


# ════════════════════════════════════════════════════════════════════════════
# B09 · verification gate — claiming success without evidence must not pass
# ════════════════════════════════════════════════════════════════════════════
def b09_verification_gate(ctx: BenchCtx) -> BenchOutcome:
    app = ctx.app
    lying = buddy.AgentRun(app, "pretend the file was written", background=True)
    lying.last_effect = time.time()
    lying.last_verify = 0.0
    flagged = lying.unverified_effects()

    honest = buddy.AgentRun(app, "read the file back", background=True)
    honest.last_effect = time.time()
    honest.last_verify = time.time() + 1
    not_flagged = not honest.unverified_effects()

    # a completion claim with no evidence must be rejected by the gate
    rejected = False
    reject_reason = ""
    try:
        gate = getattr(app, "_finish_gate", None)
        run = buddy.AgentRun(app, "claim completion", background=True)
        run.last_effect = time.time()
        run.last_verify = 0.0
        out = run._handle_finish({"status": "complete", "summary": "all done"})
        rejected = isinstance(out, buddy.RunOutcome) and (out.status != "complete" or not out.verified)
        reject_reason = f"{out.status}/verified={out.verified}" if isinstance(out, buddy.RunOutcome) else str(out)[:120]
    except Exception as e:
        rejected = True
        reject_reason = f"{type(e).__name__}: {e}"
    checks = {"unverified_effect_flagged": bool(flagged), "verified_effect_not_flagged": bool(not_flagged),
              "completion_without_evidence_rejected": bool(rejected), "gate_present": gate is not None or True}
    del checks["gate_present"]
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)}: unverified effects flagged, evidence-backed completion accepted, "
                  f"evidence-free completion rejected ({reject_reason})",
                  checks=checks, reject_reason=reject_reason)


# ════════════════════════════════════════════════════════════════════════════
# B10 · error classification — real exceptions must map to actionable categories
# ════════════════════════════════════════════════════════════════════════════
def b10_error_classification(ctx: BenchCtx) -> BenchOutcome:
    import socket
    import urllib.error
    cases = [
        # A ToolError carries its own hint, so give it one: classify_error passes
        # it through verbatim, and an empty hint here would be the caller's fault.
        (buddy.ToolError("nope", "permission_denied", "ask the owner"), "permission_denied"),
        (PermissionError(13, "denied"), "permission"),
        (FileNotFoundError("gone"), "not_found"),
        (asyncio.TimeoutError(), "timeout"),
        (subprocess.TimeoutExpired("cmd", 1), "timeout"),
        (ImportError("no module"), "dependency_missing"),
        (urllib.error.URLError("dns"), "network"),
        (ConnectionError("refused"), "network"),
        # Since Python 3.10 `socket.timeout` IS `TimeoutError`, and the timeout
        # branch is matched first. "timeout" is the correct classification; the
        # case is here to pin that behaviour down rather than to wish it away.
        (socket.timeout(), "timeout"),
        (ValueError("bad"), "invalid_args"),
        (KeyError("k"), "invalid_args"),
        (TypeError("t"), "invalid_args"),
        (OSError(5, "io"), "os_error"),
        (RuntimeError("wat"), "unknown"),
    ]
    right, wrong = [], []
    for exc, want in cases:
        got, hint = buddy.classify_error(exc)
        if got == want:
            right.append(want)
        else:
            wrong.append({"exception": type(exc).__name__, "expected": want, "got": got})
        if not hint:
            wrong.append({"exception": type(exc).__name__, "expected": "a non-empty hint", "got": hint})
    return scored(len(right), len(cases),
                  f"{len(right)}/{len(cases)} exceptions classified correctly, every one with an actionable hint",
                  wrong=wrong)


# ════════════════════════════════════════════════════════════════════════════
# B11 · level anti-gaming — the score must not move for tokens, time or volume
# ════════════════════════════════════════════════════════════════════════════
def b11_level_anti_gaming(ctx: BenchCtx) -> BenchOutcome:
    lvl = buddy.sibling("level")
    if lvl is None:
        return skipped("the level module could not be loaded")
    base_ev = {"runs_decided": 10, "runs_verified": 8, "tools_used": 12, "tools_available": 40,
               "stat_memory_hits": 30, "stat_memory_searches": 40,
               "tasks_recovered": 3, "tasks_abandoned": 1}
    honest = lvl.compute(evidence=dict(base_ev))
    inflated = dict(base_ev)
    # Everything the spec forbids as a level input, inflated absurdly.
    inflated.update({"tokens": 999_999_999, "total_tokens": 999_999_999, "prompt_tokens": 999_999_999,
                     "completion_tokens": 999_999_999, "seconds": 10_000_000, "runtime_seconds": 10_000_000,
                     "output_chars": 50_000_000, "messages": 1_000_000, "steps": 1_000_000,
                     "words_written": 9_000_000, "lines_of_code": 4_000_000, "days_active": 900})
    gamed = lvl.compute(evidence=inflated)
    starved = dict(base_ev)
    starved.update({"tokens": 0, "seconds": 0, "output_chars": 0})
    minimal = lvl.compute(evidence=starved)
    checks = {
        "inflating_tokens_time_volume_does_not_raise_the_level": gamed.level == honest.level,
        "zeroing_them_does_not_lower_it": minimal.level == honest.level,
        "the_score_is_identical": abs(gamed.score - honest.score) < 1e-9 and abs(minimal.score - honest.score) < 1e-9,
        "the_level_is_within_bounds": 1 <= honest.level <= 100,
    }

    # The second gaming vector is not fake numbers, it is fake evidence. Axis D
    # reads the memory_searches/memory_hits counters, and so does the evidence cap,
    # so if merely *reading* memory bumped them, running this benchmark suite would
    # raise the level it is supposed to be measuring. Every harness path reads with
    # touch=False for exactly that reason.
    app = ctx.app
    # Three rows share a token that appears in nothing else, so one search is
    # guaranteed to return several of them.
    for i in range(3):
        app.memory.save("preference", f"b11 probe {i}", f"zqxwv keymap variant {i}", tags="zqxwv")

    def counters() -> tuple[float, float]:
        return (app.store.stat_get("memory_searches"), app.store.stat_get("memory_hits"))

    before = counters()
    for _ in range(25):
        app.memory.search("zqxwv", touch=False)
        app.memory.context_for("zqxwv")
    after = counters()
    found = app.memory.search("zqxwv", limit=10, touch=True)   # a genuine retrieval MUST count
    real = counters()

    checks.update({
        "reading_memory_50_times_records_no_evidence": after == before,
        "the_level_is_unchanged_by_those_reads":
            lvl.compute(evidence=dict(base_ev, stat_memory_searches=after[0],
                                      stat_memory_hits=after[1])).level == honest.level,
        "a_real_retrieval_still_counts": real == (before[0] + 1, before[1] + 1),
        # The point of counting one hit per *search*: axis D divides hits by
        # searches, so adding len(out) made the ratio reach 6.0 and clamp to 1.0 —
        # "perfect retrieval" after a single query. Several rows must still be one.
        "several_rows_returned_still_count_as_one_hit": len(found) >= 2 and real[1] == before[1] + 1,
    })

    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)}: level {honest.level} (score {honest.score:.3f}) is unchanged by "
                  f"999M tokens, 10M seconds and 50M output chars, and unchanged by 50 harness reads of "
                  f"memory — while a real retrieval still counts ({before} → {real}) and {len(found)} rows "
                  f"returned by one search count as a single hit",
                  checks=checks, honest=honest.level, gamed=gamed.level, minimal=minimal.level,
                  counters_before=before, counters_after_reads=after, counters_after_real=real,
                  rows_returned_by_one_search=len(found))


# ════════════════════════════════════════════════════════════════════════════
# B12 · migration fidelity — import preserves provenance, and rollback is real
# ════════════════════════════════════════════════════════════════════════════
def b12_migration_fidelity(ctx: BenchCtx) -> BenchOutcome:
    """Legacy import must preserve provenance, touch nothing, and roll back for real.

    The target database is seeded with rows of its own first. Without that there
    is nothing to back up, `rollback` is correctly a no-op, and the benchmark
    would be measuring an empty code path while claiming to have tested recovery.
    """
    mm = buddy.sibling("memory_migration")
    if mm is None:
        return skipped("the migration module could not be loaded")
    import sqlite3

    # ── a real legacy Omega database, with its own timestamps ──
    legacy_dir = ctx.tmp / "legacy"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_db = legacy_dir / "buddy.db"
    conn = sqlite3.connect(str(legacy_db))
    conn.executescript("""CREATE TABLE memories(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, content TEXT, tags TEXT,
        status TEXT DEFAULT 'active', source_run TEXT, created REAL, updated REAL, uses INTEGER DEFAULT 0);
        CREATE TABLE runs(id TEXT PRIMARY KEY, ts REAL, goal TEXT, status TEXT, verified INTEGER,
        summary TEXT, steps INTEGER, tokens INTEGER);""")
    old_ts = 1_600_000_000.0
    for i in range(4):
        conn.execute("INSERT INTO memories(kind,title,content,tags,status,created,updated,uses) VALUES(?,?,?,?,?,?,?,?)",
                     ("preference", f"Legacy fact {i}", f"Legacy content number {i} about topic {i}",
                      "legacy", "active", old_ts + i, old_ts + i, i))
    conn.execute("INSERT INTO runs VALUES('r1',?, 'ship the thing', 'complete', 1, 'done', 4, 900)", (old_ts,))
    conn.commit()
    conn.close()
    before_sha = mm.file_sha256(legacy_db)
    before_mtime = legacy_db.stat().st_mtime_ns

    # ── a target that already holds the owner's own rows ──
    target = ctx.tmp / "target.db"
    tconn = sqlite3.connect(str(target))
    tconn.executescript(mm.SqliteSink.SCHEMA)
    for i in range(3):
        tconn.execute("INSERT INTO memories(kind,title,content,tags,status,created,updated,uses) "
                      "VALUES('fact',?,?, 'own', 'active', ?, ?, 0)",
                      (f"Pre-existing {i}", f"The owner's own record {i}", old_ts - 100 + i, old_ts - 100 + i))
    tconn.commit()
    tconn.close()

    def read_target() -> list[dict]:
        if not target.is_file():
            return []
        c = sqlite3.connect(str(target))
        c.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in c.execute("SELECT * FROM memories ORDER BY id")]
        finally:
            c.close()

    own_before = read_target()
    sink = mm.SqliteSink(target)
    src = mm.OmegaDbSource(roots={}, db_path=legacy_db)
    mig = mm.Migrator(sink, sources=[src], roots={})
    rep = mig.run(dry_run=False, backup_dir=ctx.tmp / "backups", retrieval_probe="topic 2")
    after_sha = mm.file_sha256(legacy_db)
    rows = read_target()
    imported = [r for r in rows if r.get("status") == "migrated"]

    preserved_ts = len(imported) >= 4 and all(
        any(abs((r.get("created") or 0) - (old_ts + i)) < 1.0 for r in imported) for i in range(4))
    prov_parsed = 0
    for r in imported:
        try:
            prov_parsed += 1 if json.loads(r.get("provenance") or "null") else 0
        except (json.JSONDecodeError, TypeError):
            pass
    rolled = bool(rep.backup) and bool(mig.rollback(rep.backup))
    after_rollback = read_target()
    restored = (rolled and len(after_rollback) == len(own_before)
                and all(a["title"] == b["title"] for a, b in zip(after_rollback, own_before)))

    checks = {
        # 4 memories + 1 verified run: OmegaDbSource imports both, by design.
        "all_legacy_records_imported": rep.imported == 5,
        "row_count_validated": rep.target_count_after - rep.target_count_before == rep.imported,
        "no_duplicates_on_first_run": rep.duplicates == 0,
        "original_timestamps_preserved": preserved_ts,
        "provenance_attached_and_parsable": prov_parsed == len(imported) and len(imported) > 0,
        "not_promoted_to_trusted_fact": all(r.get("status") == "migrated" for r in imported),
        "original_left_byte_identical": before_sha == after_sha and before_sha is not None
                                        and legacy_db.stat().st_mtime_ns == before_mtime,
        "retrieval_probe_passed": (rep.retrieval_check or {}).get("status") == "PASS",
        "a_real_backup_was_taken": bool(rep.backup) and bool(rep.backup_sha256),
        "rollback_restored_the_exact_prior_state": restored,
    }
    hits = sum(1 for v in checks.values() if v)
    return scored(hits, len(checks),
                  f"{hits}/{len(checks)} migration rules held: {rep.imported} imported, timestamps and provenance "
                  f"preserved, the original is byte-identical, and rollback restored "
                  f"{len(after_rollback)}/{len(own_before)} pre-existing rows",
                  checks=checks, imported=rep.imported, duplicates=rep.duplicates,
                  imported_rows=len(imported), own_before=len(own_before), after_rollback=len(after_rollback),
                  retrieval=rep.retrieval_check, backup=rep.backup, errors=rep.errors[:5])


# ════════════════════════════════════════════════════════════════════════════
# B13 · MAJIN exactly-once — a replayed operation must return the same receipt
# ════════════════════════════════════════════════════════════════════════════
def b13_majin_exactly_once(ctx: BenchCtx) -> BenchOutcome:
    if not ctx.node:
        return skipped("Node.js was not found, so the MAJIN V6 subsystem cannot start")
    mb = buddy.sibling("majin_bridge")
    if mb is None:
        return skipped("the MAJIN bridge module could not be loaded")
    root = mb.find_majin_root(None)
    if root is None:
        return skipped("MAJIN sources were not found next to the product")
    ws = ctx.tmp / "majin-ws"
    ws.mkdir(parents=True, exist_ok=True)
    v5 = ctx.tmp / "majin-v5"
    (v5 / "memory").mkdir(parents=True, exist_ok=True)
    (v5 / "owner-mode.json").write_text(json.dumps({
        "schema": "majin.v4.owner-mode/v1", "version": 1, "lanes": ["files"],
        "folders": [str(ws)], "browserOrigins": [], "history": []}), encoding="utf-8")
    # autostart=False matters. MajinBridge's constructor defaults to starting the
    # server, so the MajinError for a host without `npm install` would be raised
    # HERE — outside the guard below — and the runner would report B13 as a FAIL.
    # A missing Node dependency is a property of the host, not a capability
    # failure, and scoring it as one is exactly the lie the skip mechanism exists
    # to prevent. Construct inert, then start inside the guard.
    bridge = mb.MajinBridge(majin_root=root, workspace=ws, v5_data_dir=v5,
                            v6_home=ctx.tmp / "majin-v6", autostart=False)
    try:
        try:
            bridge.start()   # returns None; raises MajinError when it cannot start
        except mb.MajinError as e:
            # No Node deps, no V5 profile, no owner grants: a precondition of this
            # host, reported by `buddy majin status` too. Not a capability failure.
            return skipped(f"MAJIN V6 cannot start here ({e.kind}): {buddy.clip(str(e), 200)}",
                           fix="cd integrations/majin-original && npm install --no-audit --no-fund, "
                               "then `buddy majin init --lane files`")
        probe = ws / "probe.txt"
        probe.write_text("majin benchmark probe\n", encoding="utf-8")
        args = {"path": "probe.txt"}
        op = mb.operation_id("fs_read", args, "files")
        first = bridge.call("fs_read", args, op_id=op, scope="files")
        replay = bridge.call("fs_read", args, op_id=op, scope="files")

        # Reusing the same operationId with DIFFERENT arguments is what a
        # double-submission would look like; it must be refused, not executed.
        refused, refusal = False, ""
        try:
            changed = bridge.call("fs_read", {"path": "other.txt"}, op_id=op, scope="files")
            refusal = buddy.clip(buddy.jdump(changed), 240)
            refused = bool(changed.get("error") or changed.get("blocker") or changed.get("status") == "failed")
        except mb.MajinError as e:
            refused, refusal = True, buddy.clip(str(e), 240)

        first_receipt = mb.canonical_json(first)
        replay_receipt = mb.canonical_json(replay)
        checks = {
            "first_call_succeeded": bool(first.get("ok") or first.get("content") or first.get("result")),
            "replay_returned_the_identical_receipt": first_receipt == replay_receipt,
            "reusing_the_id_with_different_args_was_refused": refused,
        }
        hits = sum(1 for v in checks.values() if v)
        return scored(hits, len(checks),
                      f"{hits}/{len(checks)}: a replayed operationId returned a byte-identical receipt, and reusing "
                      f"that id with different arguments was refused — so a retry can never double-submit",
                      checks=checks, operation_id=op, refusal=refusal,
                      first=buddy.clip(first_receipt, 300), replay=buddy.clip(replay_receipt, 300))
    except Exception as e:
        return BenchOutcome(0.0, f"the MAJIN benchmark raised {type(e).__name__}: {buddy.clip(str(e), 240)}",
                            {"traceback": traceback.format_exc()[-1200:]})
    finally:
        try:
            bridge.close()
        except Exception:
            pass


# ════════════════════════════════════════════════════════════════════════════
# B14 · tool schema integrity — every registered tool must be typed and validated
# ════════════════════════════════════════════════════════════════════════════
def b14_tool_schema_integrity(ctx: BenchCtx) -> BenchOutcome:
    tools = [t for t in ctx.app.registry.tools.values() if not t.core]
    malformed, bad_required, no_desc = [], [], []
    for t in tools:
        p = t.parameters
        if not isinstance(p, dict) or p.get("type") != "object" or not isinstance(p.get("properties"), dict):
            malformed.append(t.name)
            continue
        for r in p.get("required", []):
            if r not in p["properties"]:
                bad_required.append({"tool": t.name, "required": r})
        if not (t.description or "").strip():
            no_desc.append(t.name)
        # a missing required argument must be rejected by the validator
        if p.get("required"):
            msg = buddy.validate_args(p, {})
            if not msg:
                malformed.append(f"{t.name} (validate_args accepted an empty object)")
    problems = len(malformed) + len(bad_required) + len(no_desc)
    total = len(tools)
    clean = total - problems
    return scored(max(0, clean), total,
                  f"{clean}/{total} tools have a valid typed schema, a description, and reject missing "
                  f"required arguments",
                  malformed=malformed, bad_required=bad_required, no_description=no_desc)


#: The benchmark set, in a stable order.
BENCHMARKS: list[tuple[str, str, Callable[[BenchCtx], BenchOutcome]]] = [
    ("B01", "tool routing from natural phrasing", b01_tool_routing),
    ("B02", "argument validation refuses bad calls", b02_arg_validation),
    ("B03", "permission boundaries hold in background", b03_permission_boundary),
    ("B04", "memory retrieval quality (hit@3 + MRR)", b04_memory_retrieval),
    ("B05", "effects apply exactly once under retry", b05_effect_idempotency),
    ("B06", "deterministic multi-step plan execution", b06_plan_execution),
    ("B07", "crash recovery without duplicated effects", b07_crash_recovery),
    ("B08", "coding repair proven by the real test runner", b08_coding_repair),
    ("B09", "completion without evidence is rejected", b09_verification_gate),
    ("B10", "errors classified into actionable categories", b10_error_classification),
    ("B11", "level cannot be gamed with tokens/time/volume", b11_level_anti_gaming),
    ("B12", "migration preserves provenance and rolls back", b12_migration_fidelity),
    ("B13", "MAJIN operations are exactly-once", b13_majin_exactly_once),
    ("B14", "every tool schema is typed and enforced", b14_tool_schema_integrity),
]
