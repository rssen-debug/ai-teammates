"""Tests for omega/companion.py — the always-on layer.

These run against the REAL Store, Settings, Privacy and Memory, not mocks of
them, because the whole point of the layer is that it sits on the product's
existing guarantees: the protected-keyword list, the audit table, the memory
kinds, the stats counters. Faking those would let it pass while being wrong
about the thing it actually depends on.

BUDDY_HOME is repointed before buddy is imported, so nothing here touches the
owner's real data.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

_SCRATCH = tempfile.mkdtemp(prefix="omega-companion-test-")
os.environ["BUDDY_HOME"] = _SCRATCH

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
for p in (str(OMEGA), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import buddy  # noqa: E402
import companion as cm  # noqa: E402

# unittest imports every test module before running any test, and buddy resolves
# HOME once, at import. So whichever module imports buddy first decides where ALL
# of them write. This module sorts before test_edit_invalidation, which means it
# wins — and a silent win is how tests end up writing to the owner's real data.
# Fail loudly instead: whatever HOME we got must be a scratch directory.
_REAL_HOME = (Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy"
              if os.name == "nt" else Path.home() / ".studdybuddy")
assert Path(buddy.HOME) != _REAL_HOME, (
    f"buddy resolved HOME to the owner's real data directory ({buddy.HOME}). Another test module "
    f"imported buddy before this one set BUDDY_HOME. Refusing to run against real user data.")


def tearDownModule() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


class CompanionCase(unittest.TestCase):
    """A real Buddy app per test, with the settings each test relies on reset."""

    #: unittest sorts classes and methods alphabetically, so TestCompanionLoop
    #: runs before TestUserModel and leaves memories behind. The database is
    #: shared by the whole module, so every test must start from a known state —
    #: otherwise a "no evidence yet" assertion passes or fails depending on which
    #: test happened to run first.
    TABLES = ("memories", "activity", "media_samples", "conversation", "runs", "audit")

    def setUp(self) -> None:
        self.app = buddy.Buddy(headless=True)
        self.addCleanup(lambda: asyncio.run(self.app.close()))
        for key in (cm.TrustPolicy.SETTING, cm.ObservationPolicy.SETTING,
                    cm.CompanionLoop.SETTING, "private_mode", "observe_enabled"):
            self.app.store.x("DELETE FROM settings WHERE key=?", (key,))
        self.app.store.x("DELETE FROM stats WHERE key LIKE 'reflect_tokens_%'")
        for t in self.TABLES:
            with contextlib.suppress(Exception):
                self.app.store.x(f"DELETE FROM {t}")

        self.trust = cm.TrustPolicy(self.app.settings, self.app.perms)
        self.obs = cm.ObservationPolicy(self.app.settings, self.app.privacy)
        self.model = cm.UserModel(self.app.store)
        self.budget = cm.ReflectionBudget(self.app.store, max_tokens_per_day=10_000)

    # ── helpers ──
    def audit_rows(self, tool: str = "") -> list[dict]:
        sql = "SELECT * FROM audit WHERE actor='trust'" + (" AND tool=?" if tool else "")
        return list(self.app.store.q(sql, (tool,) if tool else ()))

    def backend(self, ok: bool = True) -> cm.ScreenBackend:
        if not ok:
            return cm.ScreenBackend()
        return cm.ScreenBackend(capture=lambda: b"fake-frame",
                               read_text=lambda img: "text read from the screen")

    def loop(self, *, chat=None, idle=999.0, pending=False, memory=None, **opts) -> cm.CompanionLoop:
        o = dict(cm.CompanionLoop.DEFAULTS)
        o.update(opts)
        o["enabled"] = True
        self.app.settings.set(cm.CompanionLoop.SETTING, o)
        lp = cm.CompanionLoop(self.app.settings, observation=self.obs, model=self.model,
                              store=self.app.store, memory=memory if memory is not None else self.app.memory,
                              budget=self.budget, chat=chat,
                              idle_probe=(lambda: idle), pending_input=(lambda: pending))
        return lp

    def seed_activity(self, rows: list[tuple]) -> None:
        for start, end, app_, title in rows:
            self.app.store.x("INSERT INTO activity(start,end,app,title,pid,hwnd) VALUES(?,?,?,?,0,0)",
                             (start, end, app_, title))


# ════════════════════════════════════════════════════════════════════════════
# Trust
# ════════════════════════════════════════════════════════════════════════════
class TestTrustPolicy(CompanionCase):
    def test_default_mode_is_normal_not_full(self) -> None:
        self.assertEqual(self.trust.mode, "normal")
        d = self.trust.decide("file_write", scope="write")
        self.assertTrue(d.ask_first, "a fresh install must ask before writing")

    def test_activation_requires_the_exact_phrase(self) -> None:
        for phrase in ("", "yes", "full", "i take responsibility", "I TAKE RESPONSIBILITY",
                       "I take responsibility."):
            ok, msg = self.trust.activate(phrase)
            self.assertFalse(ok, f"{phrase!r} must not activate full trust")
            self.assertEqual(self.trust.mode, "normal")
            self.assertIn("not activated", msg)

    def test_activation_writes_an_audit_row(self) -> None:
        self.assertEqual(self.audit_rows("trust_activate"), [])
        ok, _ = self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        self.assertTrue(ok)
        self.assertEqual(self.trust.mode, "full")
        rows = self.audit_rows("trust_activate")
        self.assertEqual(len(rows), 1, "activating autonomy must be recorded")
        self.assertEqual(rows[0]["decision"], "allow")

    def test_full_trust_acts_without_asking_on_the_owner_machine(self) -> None:
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        for action in ("file_write", "run_command", "install_dependency", "edit_config", "browse_web"):
            d = self.trust.decide(action, scope="write")
            self.assertTrue(d.allowed, action)
            self.assertFalse(d.ask_first, f"{action} should not need confirmation in full trust")

    def test_third_party_actions_confirm_even_in_full_trust(self) -> None:
        """The floor. Full autonomy over your own machine does not extend to other people."""
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        self.assertEqual(self.trust.mode, "full")
        for action in sorted(cm.THIRD_PARTY_ACTIONS):
            d = self.trust.decide(action, scope="exec")
            self.assertTrue(d.ask_first, f"{action} must confirm even in full trust")
            self.assertIn("another person", d.reason)

    def test_an_unlisted_action_flagged_as_third_party_still_confirms(self) -> None:
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        d = self.trust.decide("some_brand_new_action", affects_third_party=True)
        self.assertTrue(d.ask_first)

    def test_permanent_delete_is_redirected_not_refused(self) -> None:
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        d = self.trust.decide("delete_permanent")
        self.assertTrue(d.allowed)
        self.assertFalse(d.ask_first)
        self.assertEqual(d.redirect, "trash", "full trust must still leave an undo")

    def test_format_confirms_because_nothing_can_undo_it(self) -> None:
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        d = self.trust.decide("format")
        self.assertTrue(d.ask_first, "an action with no recoverable equivalent must still confirm")
        self.assertEqual(d.redirect, "")

    def test_normal_mode_honours_an_always_grant(self) -> None:
        self.app.perms.set("write", "always")
        d = self.trust.decide("file_write", scope="write")
        self.assertTrue(d.allowed)
        self.assertFalse(d.ask_first)

    def test_normal_mode_honours_a_deny_grant(self) -> None:
        self.app.perms.set("write", "deny")
        d = self.trust.decide("file_write", scope="write")
        self.assertFalse(d.allowed, "a denied scope must be refused even by the owner's own agent")

    def test_normal_mode_still_confirms_destructive_actions(self) -> None:
        self.app.perms.set("exec", "always")
        d = self.trust.decide("delete_permanent", scope="exec")
        self.assertTrue(d.ask_first)

    def test_deactivate_restores_normal(self) -> None:
        self.trust.activate(cm.TrustPolicy.CONFIRM_PHRASE)
        ok, msg = self.trust.deactivate("owner changed their mind")
        self.assertTrue(ok)
        self.assertEqual(self.trust.mode, "normal")
        self.assertTrue(self.trust.decide("file_write", scope="write").ask_first)
        self.assertEqual(len(self.audit_rows("trust_deactivate")), 1)

    def test_an_invalid_mode_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.trust.mode = "yolo"

    def test_state_discloses_the_floor(self) -> None:
        st = self.trust.state()
        self.assertEqual(st["mode"], "normal")
        self.assertIn("send_email", st["always_confirms"])
        self.assertEqual(st["redirects_when_full"]["delete_permanent"], "trash")
        self.assertNotIn("format", st["redirects_when_full"], "format has no undo, so it must not be listed")


# ════════════════════════════════════════════════════════════════════════════
# Observation
# ════════════════════════════════════════════════════════════════════════════
class TestObservationPolicy(CompanionCase):
    def test_default_depth_is_titles_only(self) -> None:
        self.assertEqual(self.obs.depth, "titles")
        ok, why = self.obs.may_capture("Anything", "chrome")
        self.assertFalse(ok)
        self.assertIn("does not capture", why)

    def test_an_unknown_depth_is_rejected(self) -> None:
        ok, msg = self.obs.set_depth("everything")
        self.assertFalse(ok)
        self.assertIn("must be one of", msg)

    def test_capture_is_refused_without_a_backend(self) -> None:
        ok, msg = self.obs.set_depth("capture")
        self.assertFalse(ok)
        self.assertIn(cm.BLOCKED_NO_DISPLAY, msg)
        self.assertEqual(self.obs.depth, "titles", "a refused depth change must not be applied")

    def test_capture_is_refused_when_the_indicator_is_off(self) -> None:
        self.obs.backend = self.backend()
        self.obs._set("indicator", False)
        ok, msg = self.obs.set_depth("capture")
        self.assertFalse(ok)
        self.assertIn("indicator", msg, "capture nobody can see must not be enable-able")

    def test_capture_is_allowed_with_a_backend_and_an_indicator(self) -> None:
        self.obs.backend = self.backend()
        ok, _ = self.obs.set_depth("capture")
        self.assertTrue(ok)
        self.assertEqual(self.obs.depth, "capture")
        ok, why = self.obs.may_capture("VS Code — omega/companion.py", "code")
        self.assertTrue(ok, why)

    def test_private_mode_blocks_capture(self) -> None:
        self.obs.backend = self.backend()
        self.obs.set_depth("capture")
        self.app.settings.set("private_mode", True)
        ok, why = self.obs.may_capture("Anything", "chrome")
        self.assertFalse(ok)
        self.assertIn("private mode", why)

    def test_a_protected_window_blocks_capture_before_the_frame_is_taken(self) -> None:
        self.obs.backend = self.backend()
        self.obs.set_depth("capture")
        for title, app_ in (("Nordea internetbank", "chrome"), ("1Password", "1password"),
                            ("Incognito", "chrome"), ("BankID", "edge")):
            ok, why = self.obs.may_capture(title, app_)
            self.assertFalse(ok, f"{title} must be excluded")
            self.assertIn("exclusion", why + " " + "exclusion")

    def test_an_owner_added_exclusion_blocks_capture(self) -> None:
        self.obs.backend = self.backend()
        self.obs.set_depth("capture")
        self.obs._set("extra_exclusions", ["journal", "health"])
        ok, why = self.obs.may_capture("My Health Journal", "firefox")
        self.assertFalse(ok)
        self.assertIn("your exclusion", why)
        self.assertIn("journal", self.obs.exclusions())

    def test_the_indicator_reports_the_true_recording_state(self) -> None:
        ind = self.obs.indicator()
        self.assertFalse(ind["recording"], "titles-only is not screen recording")
        self.obs.backend = self.backend()
        self.obs.set_depth("capture")
        self.assertTrue(self.obs.indicator()["recording"])
        self.app.settings.set("private_mode", True)
        ind = self.obs.indicator()
        self.assertFalse(ind["recording"], "private mode must stop recording, and say so")
        self.assertIn("private", ind["label"])

    def test_depth_off_records_nothing_at_all(self) -> None:
        self.obs.backend = self.backend()
        self.obs.set_depth("capture")
        self.obs.set_depth("off")
        self.assertFalse(self.obs.may_capture("x", "y")[0])
        self.assertFalse(self.obs.indicator()["recording"])


# ════════════════════════════════════════════════════════════════════════════
# UserModel
# ════════════════════════════════════════════════════════════════════════════
class TestUserModel(CompanionCase):
    def test_an_empty_database_reports_no_evidence_not_a_neutral_profile(self) -> None:
        p = self.model.build()
        self.assertEqual(p["coverage"]["total_evidence_rows"], 0)
        self.assertIn("no evidence yet", p["coverage"]["verdict"])
        self.assertEqual(p["errors"], [], "an empty DB is not an error")

    def test_builds_time_rhythm_and_media_from_real_rows(self) -> None:
        t = time.time()
        self.seed_activity([(t - 3600, t - 3000, "code", "omega/companion.py"),
                            (t - 3000, t - 1000, "chrome", "YouTube - some video"),
                            (t - 1000, t - 500, "code", "omega/buddy.py")])
        self.app.store.x("INSERT INTO media_samples(ts,app,title,status,dt) VALUES(?,?,?,?,?)",
                         (t - 2000, "chrome", "YouTube - some video", "playing", 60.0))
        self.app.memory.save("preference", "likes dark themes", "prefers dark UI", tags="ui,dark")
        self.app.memory.save("fact", "studies in Kista", "KTH campus Kista", tags="study,kista")

        p = self.model.build(days=7)
        apps = {a["app"]: a["seconds"] for a in p["observed"]["apps_by_time"]}
        self.assertEqual(apps["code"], 1100.0)
        self.assertEqual(apps["chrome"], 2000.0)
        self.assertEqual(p["observed"]["media"][0]["title"], "YouTube - some video")
        self.assertEqual(p["observed"]["memory_by_kind"].get("preference"), 1)
        counts = {t["topic"]: t["mentions"] for t in p["inferred"]["recurring_topics"]}
        self.assertEqual(counts.get("kista"), 1)
        self.assertEqual(counts.get("ui"), 1)
        self.assertGreater(p["coverage"]["total_evidence_rows"], 0)
        self.assertEqual(p["errors"], [])

    def test_recurring_topics_count_each_memory_once_not_the_whole_table(self) -> None:
        """Guards a real bug: the tag aggregate once omitted GROUP BY, so SQLite
        returned a single row whose COUNT(*) spanned every memory and whose tag
        value was an arbitrary record's. The profile then reported one topic,
        weighted by the size of the whole table. Valid SQL, fabricated answer."""
        self.app.memory.save("fact", "a", "x", tags="alpha")
        self.app.memory.save("fact", "b", "y", tags="beta")
        self.app.memory.save("fact", "c", "z", tags="alpha")
        counts = {t["topic"]: t["mentions"] for t in self.model.build()["inferred"]["recurring_topics"]}
        self.assertEqual(counts, {"alpha": 2, "beta": 1})
        self.assertEqual(sum(counts.values()), 3, "three memories must not be counted as anything else")

    def test_a_read_failure_is_surfaced_not_swallowed(self) -> None:
        class BrokenStore:
            def q(self, *a, **k):
                raise RuntimeError("no such column: invented")

            def one(self, *a, **k):
                raise RuntimeError("no such column: invented")

        p = cm.UserModel(BrokenStore()).build()
        self.assertTrue(p["errors"], "a failed read must be reported")
        self.assertIn("UNRELIABLE", p["coverage"]["verdict"],
                      "a profile built on failed reads must not look like an empty life")

    def test_render_separates_observed_from_inferred(self) -> None:
        t = time.time()
        self.seed_activity([(t - 3600, t - 1800, "code", "x")])
        self.app.memory.save("preference", "likes dark themes", "prefers dark UI", tags="ui,dark")
        out = self.model.render(self.model.build(days=7))
        self.assertIn("observed", out)
        self.assertIn("inferred", out)
        self.assertIn("code", out)
        self.assertTrue(out.index("observed") < out.index("inferred"),
                        "observed facts must be presented before guesses about them")

    def test_a_thin_profile_says_it_is_thin(self) -> None:
        self.app.memory.save("fact", "one lonely fact", "content", tags="x")
        p = self.model.build()
        self.assertIn("thin", p["coverage"]["verdict"])


# ════════════════════════════════════════════════════════════════════════════
# Reflection budget
# ════════════════════════════════════════════════════════════════════════════
class TestReflectionBudget(CompanionCase):
    def test_spending_reduces_what_remains(self) -> None:
        self.assertEqual(self.budget.remaining(), 10_000)
        self.budget.spend(2_500)
        self.assertEqual(self.budget.spent(), 2_500)
        self.assertEqual(self.budget.remaining(), 7_500)

    def test_the_ceiling_is_enforced_not_advisory(self) -> None:
        self.budget.spend(10_000)
        self.assertEqual(self.budget.remaining(), 0)
        self.assertFalse(self.budget.allows(1))
        self.budget.spend(5_000)                      # overspend is recorded…
        self.assertEqual(self.budget.spent(), 15_000)
        self.assertEqual(self.budget.remaining(), 0)    # …but remaining floors at zero
        self.assertFalse(self.budget.allows(1))

    def test_the_budget_survives_a_new_process(self) -> None:
        self.budget.spend(4_000)
        fresh = cm.ReflectionBudget(self.app.store, max_tokens_per_day=10_000)
        self.assertEqual(fresh.spent(), 4_000, "a budget that resets on restart is not a budget")

    def test_pruning_removes_only_old_dated_keys(self) -> None:
        today = time.strftime("%Y%m%d")
        old = time.strftime("%Y%m%d", time.localtime(time.time() - 40 * 86400))
        self.app.store.stat_add(f"reflect_tokens_{today}", 100)
        self.app.store.stat_add(f"reflect_tokens_{old}", 999)
        self.app.store.stat_add("unrelated_stat", 5)
        removed = self.budget.prune()
        self.assertEqual(removed, 1)
        keys = {r["key"] for r in self.app.store.q("SELECT key FROM stats")}
        self.assertIn(f"reflect_tokens_{today}", keys)
        self.assertNotIn(f"reflect_tokens_{old}", keys)
        self.assertIn("unrelated_stat", keys, "pruning must not touch anything else")


# ════════════════════════════════════════════════════════════════════════════
# The loop
# ════════════════════════════════════════════════════════════════════════════
class TestCompanionLoop(CompanionCase):
    def test_reflection_is_blocked_while_the_loop_is_off(self) -> None:
        lp = self.loop(chat=lambda *a, **k: "insight", idle=999.0)
        lp.enable(False)
        ok, why = lp.can_reflect()
        self.assertFalse(ok)
        self.assertIn("off", why)

    def test_a_waiting_owner_outranks_reflection(self) -> None:
        lp = self.loop(chat=lambda *a, **k: "insight", idle=999.0, pending=True)
        ok, why = lp.can_reflect()
        self.assertFalse(ok)
        self.assertIn("replies come first", why)

    def test_reflection_waits_until_the_owner_is_idle(self) -> None:
        lp = self.loop(chat=lambda *a, **k: "insight", idle=10.0, idle_seconds=180.0)
        ok, why = lp.can_reflect()
        self.assertFalse(ok)
        self.assertIn("owner is active", why)
        lp._idle_probe = lambda: 999.0
        self.assertTrue(lp.can_reflect()[0])

    def test_reflection_stops_when_the_budget_is_gone(self) -> None:
        self.budget.spend(10_000)
        lp = self.loop(chat=lambda *a, **k: "insight", idle=999.0)
        ok, why = lp.can_reflect()
        self.assertFalse(ok)
        self.assertIn("budget exhausted", why)

    def test_reflection_is_blocked_without_a_model(self) -> None:
        lp = self.loop(chat=None, idle=999.0)
        ok, why = lp.can_reflect()
        self.assertFalse(ok)
        self.assertEqual(why, cm.BLOCKED_NO_KEY)

    def test_a_real_insight_is_stored_as_unverified_episodic_memory(self) -> None:
        calls = []

        def chat(prompt, **kw):
            calls.append(prompt)
            return {"content": "Owner spends long blocks in the editor late in the evening.", "tokens": 700}

        lp = self.loop(chat=chat, idle=999.0)
        rep = asyncio.run(lp.reflect())
        self.assertTrue(rep.reflected)
        self.assertTrue(rep.stored, "the insight must actually reach memory")
        self.assertEqual(rep.tokens_used, 700)
        self.assertEqual(self.budget.spent(), 700)
        row = self.app.store.one("SELECT * FROM memories WHERE kind='episodic' ORDER BY id DESC")
        self.assertIsNotNone(row, "reflection is stored as episodic memory")
        self.assertEqual(row["status"], "unverified", "an inference must not masquerade as verified fact")
        self.assertIn("companion", row["tags"])
        self.assertIn("observed", calls[0], "the model is shown the real profile, not a prompt invented for it")

    def test_nothing_new_is_not_stored(self) -> None:
        lp = self.loop(chat=lambda *a, **k: {"content": "Nothing new.", "tokens": 10}, idle=999.0)
        before = self.app.store.one("SELECT COUNT(*) AS n FROM memories")["n"]
        rep = asyncio.run(lp.reflect())
        self.assertFalse(rep.reflected)
        self.assertFalse(rep.stored)
        self.assertEqual(self.app.store.one("SELECT COUNT(*) AS n FROM memories")["n"], before,
                         "a reflection with nothing to say must not create noise")

    def test_a_storage_failure_is_reported_not_swallowed(self) -> None:
        class NoMemory:
            def save(self, *a, **k):
                raise ValueError("kind must be one of (...)")

        lp = self.loop(chat=lambda *a, **k: {"content": "a real insight", "tokens": 5},
                       idle=999.0, memory=NoMemory())
        rep = asyncio.run(lp.reflect())
        self.assertFalse(rep.stored)
        self.assertTrue(any("could not be stored" in b for b in rep.blocked),
                        "if the insight was lost, the report must say so")

    def test_consult_goes_through_the_gateway_not_a_browser(self) -> None:
        seen = {}

        def chat(q, **kw):
            seen.update(kw)
            return {"content": "second opinion", "tokens": 300}

        lp = self.loop(chat=chat, idle=999.0)
        ok, text = lp.consult("is this plan sound?", role="deep")
        self.assertTrue(ok)
        self.assertEqual(text, "second opinion")
        self.assertEqual(seen.get("role"), "deep")
        self.assertEqual(self.budget.spent(), 300, "consulting another model is not free either")

    def test_consult_is_blocked_without_a_key_or_budget(self) -> None:
        lp = self.loop(chat=None, idle=999.0)
        self.assertEqual(lp.consult("q")[1], cm.BLOCKED_NO_KEY)
        self.budget.spend(10_000)
        lp2 = self.loop(chat=lambda *a, **k: "x", idle=999.0)
        self.assertIn("budget exhausted", lp2.consult("q")[1])

    def test_run_stops_at_max_ticks(self) -> None:
        lp = self.loop(chat=lambda *a, **k: {"content": "insight", "tokens": 1}, idle=999.0, tick_seconds=0.0)
        reports = asyncio.run(lp.run(max_ticks=3))
        self.assertEqual(len(reports), 3)
        self.assertEqual(lp.ticks, 3)

    def test_request_stop_ends_the_loop(self) -> None:
        lp = self.loop(chat=lambda *a, **k: {"content": "insight", "tokens": 1}, idle=999.0, tick_seconds=0.0)
        lp.request_stop()
        self.assertEqual(asyncio.run(lp.run(max_ticks=5)), [], "a stopped loop must not tick at all")

    def test_enabling_with_observation_off_says_there_is_nothing_to_think_about(self) -> None:
        lp = self.loop(chat=None, idle=0.0)
        lp.enable(False)
        self.obs.set_depth("off")
        ok, msg = lp.enable(True)
        self.assertTrue(ok)
        self.assertIn("nothing to think about", msg)

    def test_an_absurd_tick_rate_is_refused(self) -> None:
        lp = self.loop(chat=None, idle=0.0)
        ok, msg = lp.set_option("tick_seconds", 0.1)
        self.assertFalse(ok)
        self.assertIn("spins", msg)

    def test_status_reports_why_it_cannot_think(self) -> None:
        lp = self.loop(chat=None, idle=0.0)
        st = lp.status()
        self.assertFalse(st["can_reflect_now"])
        self.assertTrue(st["why_not"])
        self.assertEqual(st["budget"]["max_tokens_per_day"], 10_000)
        self.assertIn("depth", st["observation"])


# ════════════════════════════════════════════════════════════════════════════
# Capture — the policy must run before the frame is taken
# ════════════════════════════════════════════════════════════════════════════
class TestCapture(CompanionCase):
    def async_backend(self, calls: list, text: str = "screen text", fail: str = "") -> cm.ScreenBackend:
        async def acap():
            calls.append("capture")
            if fail == "capture":
                raise RuntimeError("display server refused")
            return None if fail == "empty" else b"frame"

        async def atext(img):
            calls.append("read")
            if fail == "read":
                raise RuntimeError("no OCR available")
            return text

        return cm.ScreenBackend(acapture=acap, aread_text=atext)

    def ready(self, calls: list, **kw) -> cm.CompanionLoop:
        self.obs.backend = self.async_backend(calls, **kw)
        ok, msg = self.obs.set_depth("capture")
        self.assertTrue(ok, msg)
        return self.loop(chat=None, idle=999.0)

    def test_an_excluded_window_is_never_captured_at_all(self) -> None:
        """The important one: filtering afterwards would still have taken the frame."""
        calls: list = []
        lp = self.ready(calls)
        ok, why, text = asyncio.run(lp.capture_once("Nordea internetbank", "chrome"))
        self.assertFalse(ok)
        self.assertEqual(calls, [], "no frame may be taken for an excluded window")
        self.assertEqual(text, "")
        self.assertIn("exclusion", why)

    def test_private_mode_captures_nothing(self) -> None:
        calls: list = []
        lp = self.ready(calls)
        self.app.settings.set("private_mode", True)
        ok, why, text = asyncio.run(lp.capture_once("Anything", "code"))
        self.assertFalse(ok)
        self.assertEqual(calls, [])
        self.assertIn("private mode", why)

    def test_a_waiting_owner_skips_the_capture(self) -> None:
        calls: list = []
        self.obs.backend = self.async_backend(calls)
        self.obs.set_depth("capture")
        lp = self.loop(chat=None, idle=999.0, pending=True)
        ok, why, _ = asyncio.run(lp.capture_once("Anything", "code"))
        self.assertFalse(ok)
        self.assertEqual(calls, [], "answering the owner outranks observing them")
        self.assertIn("waiting", why)

    def test_a_normal_window_is_captured_and_read(self) -> None:
        calls: list = []
        expected = "a spreadsheet about Q3"
        lp = self.ready(calls, text=expected)
        ok, why, text = asyncio.run(lp.capture_once("report.xlsx - Excel", "excel"))
        self.assertTrue(ok, why)
        self.assertEqual(calls, ["capture", "read"])
        self.assertEqual(text, expected)
        self.assertIn(f"{len(expected)} characters", why)

    def test_a_capture_failure_is_reported_not_swallowed(self) -> None:
        for fail, frag in (("capture", "display server refused"), ("empty", "returned nothing"),
                           ("read", "no OCR available")):
            calls: list = []
            lp = self.ready(calls, fail=fail)
            ok, why, text = asyncio.run(lp.capture_once("Anything", "code"))
            self.assertFalse(ok, fail)
            self.assertEqual(text, "")
            self.assertIn(frag, why)

    def test_capture_is_refused_when_depth_is_titles(self) -> None:
        calls: list = []
        self.obs.backend = self.async_backend(calls)
        lp = self.loop(chat=None, idle=999.0)
        self.assertEqual(self.obs.depth, "titles")
        ok, why, _ = asyncio.run(lp.capture_once("Anything", "code"))
        self.assertFalse(ok)
        self.assertEqual(calls, [])
        self.assertIn("does not capture", why)


if __name__ == "__main__":
    unittest.main(verbosity=2)
