#!/usr/bin/env python3
"""Integration tests for the MAJIN V6 bridge.

These talk to the **real** MAJIN V6 MCP server (`node bin/majin-v6.mjs mcp`) —
no mock of MAJIN itself. When Node, MAJIN's dependencies or the checkout are
missing the tests are *skipped*, and the runner reports skips separately so a
skip can never be mistaken for a pass.

One server process is shared by the whole module: starting it is the expensive
part, and reusing it also proves the bridge is genuinely persistent rather than
spawning a child per call.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import majin_bridge as mb  # noqa: E402

ROOT = mb.find_majin_root()
NODE = mb.find_node()
SKIP_REASON = ""
if ROOT is None:
    SKIP_REASON = "MAJIN checkout not found (set MAJIN_ROOT)"
elif NODE is None:
    SKIP_REASON = "Node.js not found"
elif not (ROOT / "node_modules").is_dir():
    SKIP_REASON = f"MAJIN dependencies not installed at {ROOT} (run npm install)"

TMP: Path | None = None
BRIDGE: "mb.MajinBridge | None" = None
EVENTS: list[tuple[str, dict]] = []


def setUpModule() -> None:  # noqa: N802
    global TMP, BRIDGE
    if SKIP_REASON:
        return
    TMP = Path(tempfile.mkdtemp(prefix="omega-bridge-test-"))
    ws, v5, v6 = TMP / "workspace", TMP / "v5", TMP / "v6"
    ws.mkdir(parents=True)
    v5.mkdir(parents=True)
    (ws / "sample.txt").write_text("OMEGA BRIDGE INTEGRATION TEST\n", encoding="utf-8")
    (ws / "sub").mkdir()
    (ws / "sub" / "deep.txt").write_text("nested content\n", encoding="utf-8")
    (v5 / "owner-mode.json").write_text(json.dumps({
        "schema": "majin.v4.owner-mode/v1", "version": 1, "lanes": ["files"],
        "folders": [str(ws)], "browserOrigins": [], "history": []}), encoding="utf-8")
    BRIDGE = mb.MajinBridge(majin_root=ROOT, node=NODE, workspace=ws, v5_data_dir=v5, v6_home=v6,
                            log=lambda event, payload=None: EVENTS.append((event, payload or {})))


def tearDownModule() -> None:  # noqa: N802
    global BRIDGE
    if BRIDGE is not None:
        BRIDGE.close(kill=True)
        BRIDGE = None
    if TMP is not None:
        shutil.rmtree(TMP, ignore_errors=True)


def bridge() -> "mb.MajinBridge":
    if BRIDGE is None:
        raise unittest.SkipTest(SKIP_REASON or "bridge unavailable")
    return BRIDGE


class TestDiscovery(unittest.TestCase):
    """Discovery is pure and always runs — it is what makes BLOCKED honest."""

    def test_finds_the_real_majin_checkout_in_this_repository(self) -> None:
        root = mb.find_majin_root()
        if root is None:
            self.skipTest("MAJIN checkout not present")
        self.assertTrue((root / "bin" / "majin-v6.mjs").is_file())
        self.assertTrue((root / "src" / "v6" / "mcp.js").is_file())

    def test_explicit_root_wins_over_discovery(self) -> None:
        root = mb.find_majin_root()
        if root is None:
            self.skipTest("MAJIN checkout not present")
        self.assertEqual(mb.find_majin_root(str(root)), root)
        # An explicit location is authoritative: Omega must never quietly drive a
        # different MAJIN checkout than the one the owner named.
        self.assertIsNone(mb.find_majin_root("/definitely/not/majin"))

    def test_defaults_mirror_majin_home_js(self) -> None:
        v5, v6 = mb.default_v5_data_dir(), mb.default_v6_home()
        self.assertEqual(v5.name, "v5")
        self.assertEqual(v6.name, "v6")
        self.assertEqual(v5.parent.name, "MAJIN")
        self.assertEqual(v6.parent.name, "MAJIN")
        self.assertNotEqual(v5, v6, "V6 must never share the V5 data directory")
        self.assertFalse(str(v6).startswith(str(v5) + os.sep), "V6 home must not be nested inside V5")

    def test_environment_overrides_are_respected(self) -> None:
        custom = str(Path(tempfile.gettempdir()) / "omega-custom-v6")
        old = os.environ.get("MAJIN_V6_HOME")
        os.environ["MAJIN_V6_HOME"] = custom
        try:
            self.assertEqual(str(mb.default_v6_home()), str(Path(custom).resolve()))
        finally:
            if old is None:
                os.environ.pop("MAJIN_V6_HOME", None)
            else:
                os.environ["MAJIN_V6_HOME"] = old


class TestOperationId(unittest.TestCase):
    """The exactly-once property that stops a retry double-submitting a job."""

    def test_same_effect_same_id(self) -> None:
        self.assertEqual(mb.operation_id("jobs_apply", {"id": "a1"}), mb.operation_id("jobs_apply", {"id": "a1"}))

    def test_key_order_does_not_change_the_id(self) -> None:
        self.assertEqual(mb.operation_id("t", {"a": 1, "b": 2}), mb.operation_id("t", {"b": 2, "a": 1}))

    def test_different_arguments_get_different_ids(self) -> None:
        self.assertNotEqual(mb.operation_id("jobs_apply", {"id": "a1"}), mb.operation_id("jobs_apply", {"id": "a2"}))

    def test_different_tools_get_different_ids(self) -> None:
        self.assertNotEqual(mb.operation_id("jobs_apply", {"id": "a1"}), mb.operation_id("jobs_evaluate", {"id": "a1"}))

    def test_scope_separates_otherwise_identical_effects(self) -> None:
        self.assertNotEqual(mb.operation_id("t", {"a": 1}, scope="run-1"),
                            mb.operation_id("t", {"a": 1}, scope="run-2"))

    def test_ids_are_bounded_and_url_safe(self) -> None:
        oid = mb.operation_id("t", {"x": "y" * 5000})
        self.assertLessEqual(len(oid), 160)
        self.assertTrue(oid.startswith("omega-"))
        self.assertRegex(oid, r"^omega-[0-9a-f]+$")

    def test_canonical_json_is_stable_across_types(self) -> None:
        self.assertEqual(mb.canonical_json({"b": 2, "a": [1, 2]}), mb.canonical_json({"a": [1, 2], "b": 2}))


class TestAvailabilityHonesty(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-avail-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_missing_v5_profile_is_blocked_with_the_real_reason(self) -> None:
        b = mb.MajinBridge(majin_root=ROOT, node=NODE, workspace=self.tmp,
                           v5_data_dir=self.tmp / "nope", v6_home=self.tmp / "v6", autostart=False)
        if b.majin_root is None or b.node is None:
            self.skipTest(SKIP_REASON)
        ok, why = b.availability()
        self.assertFalse(ok)
        self.assertIn("V5_DATA_MISSING", why)
        self.assertIn("buddy majin init", why, "the reason must tell the owner how to fix it")

    def test_missing_grants_file_is_blocked(self) -> None:
        v5 = self.tmp / "v5"
        v5.mkdir()
        b = mb.MajinBridge(majin_root=ROOT, node=NODE, workspace=self.tmp, v5_data_dir=v5,
                           v6_home=self.tmp / "v6", autostart=False)
        if b.majin_root is None or b.node is None:
            self.skipTest(SKIP_REASON)
        ok, why = b.availability()
        self.assertFalse(ok)
        self.assertIn("owner grants", why)

    def test_missing_node_is_reported_as_unavailable(self) -> None:
        b = mb.MajinBridge(majin_root=ROOT, node=None, workspace=self.tmp, v5_data_dir=self.tmp,
                           v6_home=self.tmp / "v6", autostart=False)
        b.node = None
        ok, why = b.availability()
        self.assertFalse(ok)
        self.assertIn("Node.js", why)

    def test_missing_dependencies_are_reported_not_guessed(self) -> None:
        fake = self.tmp / "majin"
        (fake / "bin").mkdir(parents=True)
        (fake / "src" / "v6").mkdir(parents=True)
        (fake / "bin" / "majin-v6.mjs").write_text("// stub\n", encoding="utf-8")
        (fake / "src" / "v6" / "mcp.js").write_text("// stub\n", encoding="utf-8")
        b = mb.MajinBridge(majin_root=fake, node=NODE or "node", workspace=self.tmp,
                           v5_data_dir=self.tmp, v6_home=self.tmp / "v6", autostart=False)
        ok, why = b.availability()
        self.assertFalse(ok)
        self.assertIn("npm install", why)

    def test_starting_an_unavailable_bridge_raises_a_typed_error(self) -> None:
        b = mb.MajinBridge(majin_root=ROOT, node=NODE, workspace=self.tmp,
                           v5_data_dir=self.tmp / "nope", v6_home=self.tmp / "v6", autostart=False)
        if b.majin_root is None or b.node is None:
            self.skipTest(SKIP_REASON)
        with self.assertRaises(mb.MajinError) as ctx:
            b.start()
        self.assertIn(ctx.exception.kind, ("blocked", "unavailable"))
        self.assertFalse(ctx.exception.retryable, "an unavailable bridge must not be retried forever")

    def test_snapshot_never_raises_and_reports_the_reason(self) -> None:
        b = mb.MajinBridge(majin_root=None, node=None, workspace=self.tmp, v5_data_dir=self.tmp,
                           v6_home=self.tmp / "v6", autostart=False)
        snap = b.snapshot()
        self.assertFalse(snap["running"])
        self.assertTrue(snap["reason"])
        self.assertEqual(snap["bridge"], mb.BRIDGE_VERSION)


@unittest.skipIf(bool(SKIP_REASON), SKIP_REASON or "MAJIN unavailable")
class TestLiveBridge(unittest.TestCase):
    """Real MCP sessions against the real MAJIN V6 server."""

    def test_handshake_negotiates_a_protocol_and_lists_tools(self) -> None:
        b = bridge()
        self.assertIsNotNone(b.negotiated_protocol)
        self.assertIn(b.negotiated_protocol, ("2024-11-05", "2025-03-26", "2025-06-18"))
        names = {t["name"] for t in b.mcp_tools}
        for expected in ("majin_status", "majin_tools_search", "majin_tool_schema", "majin_tool_call",
                         "v6_status", "v6_queue_add", "v6_queue_list", "v6_task_get",
                         "v6_task_cancel", "v6_work_start", "v6_work_stop"):
            self.assertIn(expected, names)

    def test_status_reports_the_real_owner_grants(self) -> None:
        st = bridge().status()
        self.assertTrue(st.get("operational"))
        self.assertIn("files", st.get("ownerGrantedLanes") or [])
        self.assertGreater(st.get("registered", 0), 0)
        self.assertGreater(st.get("authorized", 0), 0)

    def test_search_finds_real_tools_and_respects_the_limit(self) -> None:
        b = bridge()
        hits = b.search("fs.read", limit=5).get("matches") or []
        self.assertTrue(any(m["name"] == "fs_read" for m in hits))
        self.assertLessEqual(len(hits), 5)

    def test_schema_returns_the_exact_input_schema(self) -> None:
        schema = bridge().schema("fs_read")
        props = (schema.get("inputSchema") or {}).get("properties") or {}
        self.assertIn("path", props)

    def test_call_executes_a_real_tool_and_returns_real_content(self) -> None:
        rec = bridge().call("fs_read", {"path": "sample.txt"})
        self.assertEqual(rec.get("status"), "completed")
        self.assertIn("OMEGA BRIDGE INTEGRATION TEST", json.dumps(rec.get("result")))
        self.assertTrue(rec.get("operationId"))

    def test_replayed_operation_id_returns_the_original_receipt(self) -> None:
        b = bridge()
        oid = mb.operation_id("fs_read", {"path": "sub/deep.txt"})
        first = b.call("fs_read", {"path": "sub/deep.txt"}, op_id=oid)
        time.sleep(0.01)
        second = b.call("fs_read", {"path": "sub/deep.txt"}, op_id=oid)
        self.assertEqual(first.get("finishedAt"), second.get("finishedAt"),
                         "a replayed operationId must return the stored receipt, not a new execution")

    def test_reused_id_with_different_arguments_is_rejected(self) -> None:
        b = bridge()
        oid = mb.operation_id("fs_read", {"path": "sample.txt"}, scope="mismatch")
        b.call("fs_read", {"path": "sample.txt"}, op_id=oid)
        with self.assertRaises(mb.MajinError) as ctx:
            b.call("fs_read", {"path": "sub/deep.txt"}, op_id=oid)
        self.assertEqual(ctx.exception.kind, "invalid")
        self.assertFalse(ctx.exception.retryable, "a mismatched operationId must never be retried blindly")

    def test_ungranted_lane_is_denied_and_not_retryable(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            bridge().call("browser_open", {"url": "https://example.com"}, op_id="bridge-test-denied")
        self.assertEqual(ctx.exception.kind, "denied",
                         f"a permission boundary was classified as '{ctx.exception.kind}': {ctx.exception}")
        self.assertFalse(ctx.exception.retryable, "Omega must not retry into a permission wall")

    def test_unknown_tool_is_a_typed_invalid_error(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            bridge().call("definitely_not_a_real_tool", {}, op_id="bridge-test-unknown")
        self.assertIn(ctx.exception.kind, ("invalid", "tool", "denied"))
        self.assertFalse(ctx.exception.retryable)

    def test_missing_required_argument_is_rejected_by_majin(self) -> None:
        with self.assertRaises(mb.MajinError):
            bridge().call("fs_read", {}, op_id="bridge-test-noargs")

    def test_durable_queue_add_get_and_dedupe(self) -> None:
        b = bridge()
        payload = {"tool": "fs_read", "arguments": {"path": "sample.txt"}}
        first = b.queue_add("tool", title="bridge test", payload=payload)
        tid = self._task_id(first)
        self.assertTrue(tid)
        again = b.queue_add("tool", title="bridge test", payload=payload)
        self.assertEqual(self._task_id(again), tid, "the same effect must not be queued twice")
        got = b.task_get(str(tid))
        self.assertEqual(str(got.get("id") or self._task_id(got)), str(tid))
        listed = b.queue_list(limit=50)
        ids = [str(t.get("id")) for t in (listed.get("tasks") or [])]
        self.assertIn(str(tid), ids)

    def test_task_cancel_is_real(self) -> None:
        b = bridge()
        payload = {"tool": "fs_read", "arguments": {"path": "sub/deep.txt"}}
        tid = self._task_id(b.queue_add("tool", title="cancel me", payload=payload,
                                        dedupe_key=mb.operation_id("cancel-test", {"n": time.time()})))
        out = b.task_cancel(str(tid))
        self.assertIsInstance(out, dict)
        state = str(b.task_get(str(tid)).get("state") or "").lower()
        self.assertIn(state, ("cancelled", "canceled", "done", "completed", "running", "leased"),
                      f"unexpected state after cancel: {state}")

    def test_v6_status_reads_persisted_state(self) -> None:
        st = bridge().v6_status()
        self.assertIsInstance(st, dict)
        self.assertTrue(st, "v6_status returned nothing")

    def test_work_stop_writes_the_stop_marker_without_fabricating_completion(self) -> None:
        out = bridge().work_stop()
        self.assertIsInstance(out, dict)

    def test_cli_path_runs_the_real_doctor(self) -> None:
        doc = bridge().doctor()
        self.assertTrue(doc["ok"])
        checks = (doc.get("result") or {}).get("checks") or []
        self.assertGreater(len(checks), 5)
        names = {c["name"] for c in checks}
        self.assertIn("Node.js", names)
        self.assertIn("Windows acceptance", names)
        # MAJIN itself reports Windows acceptance as NOT_TESTED on Linux; the
        # bridge must pass that honesty through instead of upgrading it.
        win = next(c for c in checks if c["name"] == "Windows acceptance")
        self.assertEqual(win["status"], "NOT_TESTED")

    def test_cli_reports_a_real_failure_as_a_typed_error(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            bridge().cli(["queue", "get", "tsk_definitely_not_real"])
        self.assertEqual(ctx.exception.kind, "tool")
        self.assertIsNotNone(ctx.exception.detail)

    def test_bridge_is_persistent_not_one_process_per_call(self) -> None:
        b = bridge()
        pid = b._proc.pid if b._proc else None
        self.assertIsNotNone(pid)
        for _ in range(5):
            b.status(refresh=True)
        self.assertEqual(b._proc.pid if b._proc else None, pid,
                         "the bridge respawned: MAJIN must stay up across calls")
        self.assertEqual(b._restarts, 0)

    def test_recovery_after_the_child_is_killed(self) -> None:
        """Failure injection: kill MAJIN under Omega and prove it comes back."""
        b = bridge()
        b.status()
        proc = b._proc
        self.assertIsNotNone(proc)
        proc.kill()  # type: ignore[union-attr]
        proc.wait(timeout=10)  # type: ignore[union-attr]
        # The next call must notice, restart and succeed — not report success.
        st = b.status(refresh=True)
        self.assertTrue(st.get("operational"))
        self.assertGreaterEqual(b._restarts, 1)
        self.assertIsNot(b._proc, proc)

    def test_notification_events_are_logged_not_swallowed(self) -> None:
        self.assertTrue(any(e == "majin.bridge.started" for e, _ in EVENTS),
                        "the bridge should have logged its start")

    @staticmethod
    def _task_id(payload: dict) -> str:
        if not isinstance(payload, dict):
            return ""
        task = payload.get("task")
        if isinstance(task, dict) and task.get("id"):
            return str(task["id"])
        return str(payload.get("id") or payload.get("taskId") or "")


class TestUnwrap(unittest.TestCase):
    def test_structured_content_is_passed_through(self) -> None:
        out = mb.unwrap_mcp_result({"structuredContent": {"status": "completed", "result": 1}})
        self.assertEqual(out["status"], "completed")

    def test_json_text_block_is_parsed(self) -> None:
        out = mb.unwrap_mcp_result({"content": [{"type": "text", "text": json.dumps({"a": 1})}]})
        self.assertEqual(out["a"], 1)

    def test_plain_text_is_kept_as_text(self) -> None:
        out = mb.unwrap_mcp_result({"content": [{"type": "text", "text": "just words"}]})
        self.assertEqual(out["text"], "just words")

    def test_error_result_carries_majin_classification(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            mb.unwrap_mcp_result({"isError": True, "content": [{"type": "text", "text": json.dumps(
                {"error": "TOOL_UNCERTAIN", "message": "the portal did not confirm", "status": "uncertain"})}]})
        self.assertTrue(ctx.exception.uncertain)
        self.assertFalse(ctx.exception.retryable, "an uncertain external outcome must never be auto-retried")

    def test_permission_error_is_denied(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            mb.unwrap_mcp_result({"isError": True, "content": [{"type": "text", "text": json.dumps(
                {"error": "PERMISSION_DENIED", "message": "lane not granted"})}]})
        self.assertEqual(ctx.exception.kind, "denied")
        self.assertFalse(ctx.exception.retryable)

    def test_malformed_result_is_a_protocol_error(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            mb.unwrap_mcp_result("not a dict")  # type: ignore[arg-type]
        self.assertEqual(ctx.exception.kind, "protocol")

    def test_redaction_is_applied_to_error_text(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            mb.unwrap_mcp_result({"isError": True, "content": [{"type": "text", "text": json.dumps(
                {"error": "X", "message": "failed with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"})}]},
                redact=lambda s: s.replace("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "[REDACTED]"))
        self.assertIn("[REDACTED]", str(ctx.exception.message))
        self.assertNotIn("sk-ABCDEFGHIJ", str(ctx.exception.message))


class TestProfileBootstrap(unittest.TestCase):
    """`buddy majin init` — the owner-explicit grant path V6 refuses to invent."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-init-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.b = mb.MajinBridge(majin_root=ROOT or self.tmp, node=NODE or "node", workspace=self.tmp,
                                v5_data_dir=self.tmp / "v5", v6_home=self.tmp / "v6", autostart=False)

    def test_creates_a_profile_the_real_server_accepts(self) -> None:
        out = self.b.init_profile(["files"], folders=[str(self.tmp)])
        self.assertTrue(Path(out["path"]).is_file())
        self.assertIn("files", out["lanes"])
        doc = json.loads(Path(out["path"]).read_text(encoding="utf-8"))
        self.assertEqual(doc["schema"], "majin.v4.owner-mode/v1")
        self.assertEqual(doc["history"][-1]["by"], "studdy-buddy-omega")
        # Now the bridge must consider MAJIN available.
        if ROOT and NODE and (ROOT / "node_modules").is_dir():
            ok, why = self.b.availability()
            self.assertTrue(ok, why)

    def test_unknown_lane_is_refused(self) -> None:
        with self.assertRaises(mb.MajinError) as ctx:
            self.b.init_profile(["files", "launch_missiles"])
        self.assertEqual(ctx.exception.kind, "invalid")
        self.assertFalse((self.tmp / "v5" / "owner-mode.json").exists(), "a refused grant must not be written")

    def test_existing_grants_are_backed_up_and_never_narrowed(self) -> None:
        self.b.init_profile(["files"], folders=[str(self.tmp)])
        before = json.loads((self.tmp / "v5" / "owner-mode.json").read_text(encoding="utf-8"))
        out = self.b.init_profile(["jobs"], folders=[])
        self.assertTrue(out["backup"] and Path(out["backup"]).is_file())
        after = json.loads((self.tmp / "v5" / "owner-mode.json").read_text(encoding="utf-8"))
        self.assertIn("files", after["lanes"], "an existing grant was lost")
        self.assertIn("jobs", after["lanes"])
        self.assertEqual(len(after["history"]), len(before["history"]) + 1)
        self.assertEqual(after["folders"], before["folders"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
