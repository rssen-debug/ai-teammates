"""Interactive side panel: timestamps, bounded messages and faithful traces."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

OMEGA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OMEGA))

from live_panel import LivePanel, remaining_seconds, clean_line, evidence_progress, pixel_companion, companion_stage, companion_personality, measured_axis_rows, evidence_focus


class FakeCLI:
    def __init__(self, app):
        self.app = app


class FakeCompanion:
    def present(self):
        return False, "not configured"


class PanelTest(unittest.TestCase):
    def build(self):
        app = SimpleNamespace(current_run=None, companion=FakeCompanion(),
                              level_snapshot=lambda: {"level": 10, "tier": "growing"})
        return LivePanel(app, FakeCLI)

    def test_tool_failure_reason_is_visible_and_not_echoed_into_input(self):
        p = self.build()
        p.ui.step("Skapar fil")
        p.ui.step_done(False, "Access denied to target path")
        self.assertEqual(p._typing.text, "")
        self.assertIn("Access denied", p._last_tool_error)
        self.assertNotIn("Ett verktyg misslyckades", p._chat.text)
        p.toggle_thinking()
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("SENASTE FEL", rendered)

    def test_thinking_is_open_by_default_without_tetris(self):
        p = self.build()
        self.assertTrue(p.show_thinking)
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("MIN ARBETSPLAN", rendered)
        self.assertNotIn("TETRIS", rendered)

    def test_live_panel_explains_actual_goal_action_reason_and_result(self):
        p = self.build()
        p.ui.explain_action(
            "Hitta min programmeringsfil och kontrollera den",
            "Läser fil [file_read]",
            "Samla befintligt innehåll som underlag",
            "Läsa tillbaka resultatet")
        pending = "".join(f[1] for f in p._side_text())
        self.assertIn("MIN ARBETSPLAN", pending)
        self.assertIn("01 MÅL", pending)
        self.assertIn("Hitta min programmeringsfil", pending)
        self.assertIn("03 VARFÖR DETTA STEG", pending)
        self.assertIn("Samla befintligt innehåll", pending)
        self.assertIn("Verktyget körs", pending)
        p.ui.explain_result(True, "ev42", observation=True, effect=False)
        result = "".join(f[1] for f in p._side_text())
        self.assertIn("FAKTISKT RESULTAT", result)
        self.assertIn("läste tillbaka underlag", result)
        self.assertIn("ev42", result)
        self.assertEqual(p._typing.text, "")

    def test_action_evidence_is_only_shown_after_success(self):
        p = self.build()
        p.ui.explain_action("test goal", "Sparar fil", "Ändra innehållet",
                            "Läs tillbaka filen")
        p.ui.explain_result(False, "ev99", observation=False, effect=True)
        rendered = "".join(f[1] for f in p._side_text())
        self.assertNotIn("Bevis: ev99", rendered)
        self.assertIn("Steget misslyckades", rendered)
        p.ui.explain_action("test goal", "Sparar fil", "Ändra innehållet",
                            "Läs tillbaka filen")
        p.ui.explain_result(True, "ev100", observation=False, effect=True)
        rendered = "".join(f[1] for f in p._side_text())
        self.assertIn("kontroll behövs", rendered)
        self.assertIn("ev100", rendered)

    def test_progress_core_counts_only_real_completed_tools(self):
        p = self.build()
        initial = "".join(part[1] for part in p._side_text())
        self.assertIn("PROGRESS CORE", initial)
        self.assertIn("VÄNTAR PÅ RESULTAT", initial)
        self.assertEqual(p._tool_successes, 0)
        self.assertEqual(p._tool_failures, 0)
        # Mere redraws or clock ticks never add progress.
        for _ in range(20):
            p._refresh()
            p._side_text()
        self.assertEqual(p._tool_successes, 0)
        self.assertEqual(p._tool_streak, 0)
        p.ui.step("Läser lokal fil")
        self.assertEqual(p._tool_successes, 0)
        working = "".join(part[1] for part in p._side_text())
        self.assertIn("VERKTYG ARBETAR", working)
        p.ui.step_done(True)
        self.assertEqual(p._tool_successes, 1)
        self.assertEqual(p._tool_streak, 1)
        p.ui.step("Kontrollerar resultat")
        p.ui.step_done(False, "Access denied")
        self.assertEqual(p._tool_failures, 1)
        self.assertEqual(p._tool_streak, 0)
        self.assertEqual(list(p._progress_outcomes), [True, False])
        failed = "".join(part[1] for part in p._side_text())
        self.assertIn("STEGET MISSLYCKADES", failed)
        self.assertIn("UTFALL", failed)

    def test_evolution_skill_map_uses_only_completed_real_tool_calls(self):
        p = self.build()
        first = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("EVOLUTION · SKILL MAP", first)
        self.assertEqual(p._skill_checks["FILER"], [0, 0])
        for _ in range(4):
            p._refresh()
            p._side_text()
        self.assertEqual(p._skill_checks["FILER"], [0, 0])
        p.ui.step("Läser lokal fil")
        self.assertEqual(p._skill_checks["FILER"], [0, 0])
        p.ui.step_done(True)
        self.assertEqual(p._skill_checks["FILER"], [1, 0])
        p.ui.step("Läser lokal fil")
        p.ui.step_done(False, "permission denied")
        self.assertEqual(p._skill_checks["FILER"], [1, 1])
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("SENASTE HÄNDELSER", rendered)
        self.assertIn("FILER", rendered)
        self.assertEqual(p._cached_level.get("level"), None)

    def test_evolution_chat_does_not_masquerade_as_skill_progress(self):
        p = self.build()
        run = SimpleNamespace(ledger=[])
        p.ui.summary(run, SimpleNamespace(status="answered", verified=True))
        self.assertEqual(sum(sum(x) for x in p._skill_checks.values()), 0)
        self.assertEqual(p._verified_work, 0)
        self.assertEqual(len(p._evolution_timeline), 1)
        self.assertIn("AI-svar levererat", p._evolution_timeline[0][1])

    def test_six_axis_evidence_is_grounded_in_persisted_metrics(self):
        p = self.build()
        p._cached_level = {
            "level": 16,
            "axes": [
                {"axis": "A", "value": .9, "measured": True},
                {"axis": "B", "value": None, "measured": False},
                {"axis": "C", "value": .25, "measured": True},
                {"axis": "E", "value": .6, "measured": True},
            ],
        }
        rendered = "".join(part[1] for part in p._side_text())
        self.assertIn("KAPACITET", rendered)
        self.assertIn("FOKUS: VERKTYG", rendered)
        self.assertIn("INGET UNDERLAG", rendered)
        self.assertEqual(p._cached_level["level"], 16)

    def test_measured_axes_reject_invalid_and_unmeasured_values(self):
        rows = measured_axis_rows({"axes": [
            {"axis": "A", "value": 1.1},
            {"axis": "B", "value": .5, "measured": False},
            {"axis": "C", "value": .3, "measured": True},
            {"axis": "D", "value": True},
        ]})
        self.assertEqual(rows[0][2], None)
        self.assertEqual(rows[1][2], None)
        self.assertEqual(rows[2][2], .3)
        self.assertEqual(rows[3][2], None)
        self.assertTrue(all(value is None for _, _, value in measured_axis_rows({})))
        self.assertTrue(all(value is None for _, _, value in measured_axis_rows({"axes": "bad"})))

    def test_recommended_next_test_is_not_fake_learning(self):
        p = self.build()
        p._cached_level = {
            "level": 16, "measured_events": 39,
            "evidence_full": 250, "raw_level": 45,
            "axes": [{"axis": "A", "value": .9, "measured": True},
                     {"axis": "E", "value": .2, "measured": True}],
        }
        original = dict(p._cached_level)
        shown = "".join(part[1] for part in p._side_text())
        self.assertIn("NÄSTA TEST: Kör reproducerbara benchmark", shown)
        self.assertIn("Mot nästa nivå", shown)
        self.assertEqual(p._cached_level, original)
        self.assertEqual(p._tool_successes, 0)
        self.assertIsNone(evidence_focus({"axes": []}))

    def test_progress_does_not_change_ai_level_or_evidence(self):
        p = self.build()
        p._cached_level = {"level": 16}
        p.ui.step("Testar")
        p.ui.step_done(True)
        p.ui.step("Verifierar")
        p.ui.step_done(True)
        self.assertEqual(p._cached_level["level"], 16)
        self.assertEqual(p._tool_successes, 2)
        shown = "".join(part[1] for part in p._side_text())
        self.assertIn("Verktygsutfall", shown)
        self.assertIn("AI LEVEL: 16/100", shown)

    def test_chat_answer_is_visible_activity_but_not_tool_or_learning(self):
        p = self.build()
        p._cached_level = {"level": 16}
        p.ui.explain_action("Vad betyder den här länken?", "Analyserar din fråga",
                            "Jag tolkar innehållet", "Svara direkt eller välj verktyg")
        self.assertIn("inget verktygsresultat", p.action_result)
        from types import SimpleNamespace
        run = SimpleNamespace(ledger=[])
        result = SimpleNamespace(status="answered", verified=True)
        p.ui.summary(run, result)
        self.assertEqual(p._answers_delivered, 1)
        self.assertEqual(p._verified_work, 0)
        self.assertEqual(p._tool_successes, 0)
        self.assertEqual(p._cached_level["level"], 16)
        shown = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("AI-SVAR KLART", shown)
        self.assertIn("Inga verktygssteg", shown)
        self.assertNotIn("Verktyget körs", shown)

    def test_verified_tool_task_separate_from_chat_activity(self):
        p = self.build()
        from types import SimpleNamespace
        run = SimpleNamespace(ledger=[{"ok": True, "tool": "file_read"}])
        result = SimpleNamespace(status="complete", verified=True)
        p.ui.summary(run, result)
        self.assertEqual(p._answers_delivered, 1)
        self.assertEqual(p._verified_work, 1)
        self.assertEqual(p._tool_successes, 0)
        shown = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("VERIFIERAD UPPGIFT", shown)

    def test_failed_ledger_cannot_inflate_verified_work(self):
        p = self.build()
        run = SimpleNamespace(ledger=[{"ok": False}])
        result = SimpleNamespace(status="complete", verified=True)
        p.ui.summary(run, result)
        self.assertEqual(p._verified_work, 0)
        self.assertEqual(p._unverified_work, 1)
        self.assertEqual(p._answers_delivered, 1)

    def test_failed_runs_are_not_successful_answers(self):
        p = self.build()
        run = SimpleNamespace(ledger=[{"ok": False}])
        result = SimpleNamespace(status="failed", verified=False)
        p.ui.summary(run, result)
        self.assertEqual(p._answers_delivered, 0)
        self.assertEqual(p._unverified_work, 1)

    def test_unverified_work_cannot_increase_verified_counter(self):
        p = self.build()
        from types import SimpleNamespace
        run = SimpleNamespace(ledger=[{"ok": False}])
        p.ui.summary(run, SimpleNamespace(status="unverified", verified=False))
        self.assertEqual(p._unverified_work, 1)
        self.assertEqual(p._verified_work, 0)
        self.assertEqual(p._run_state, "EJ VERIFIERAT")

    def test_next_level_uses_real_evidence_not_clock(self):
        a = evidence_progress({"level": 10, "measured_events": 23,
                               "raw_level": 40, "evidence_full": 250})
        self.assertTrue(a["measured"])
        self.assertEqual(a["target"], 11)
        self.assertGreaterEqual(a["required"], a["events"])
        self.assertNotIn("seconds", a)
        self.assertNotIn("eta", a)
        b = evidence_progress({"level": 10, "measured_events": 25,
                               "raw_level": 10.2, "evidence_full": 250})
        self.assertTrue(b["quality_limited"])

    def test_sprite_is_static_art_not_fake_tool_activity(self):
        a = pixel_companion("sleeping", level=12)
        b = pixel_companion("working", level=12)
        self.assertEqual(len(a), 7)
        self.assertNotEqual(a[2], b[2])

    def test_pet_evolves_only_from_measured_level(self):
        levels = (1, 9, 10, 24, 25, 49, 50, 74, 75, 100)
        stages = [companion_stage(level)[0] for level in levels]
        self.assertEqual(stages, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
        self.assertEqual(companion_stage(None)[0], 0)
        self.assertEqual(len(pixel_companion("awake", level=1)), 5)
        self.assertEqual(len(pixel_companion("awake", level=100)), 11)

    def test_visual_blink_does_not_level_up(self):
        a = pixel_companion("observing", frame=0, level=12)
        b = pixel_companion("observing", frame=1, level=12)
        self.assertNotEqual(a, b)
        self.assertEqual(companion_stage(12), companion_stage(12))
        self.assertIn("kollar vad som gick fel", companion_personality("working", 12, False).lower())

    def test_timers_never_guess(self):
        self.assertEqual(remaining_seconds(0, 30, 100), "--:--")
        self.assertEqual(remaining_seconds(100, 30, 105), "00:25")
        self.assertEqual(remaining_seconds(100, 30, 200), "00:00")

    def test_trace_has_real_tool_name_and_result(self):
        p = self.build()
        p.ui.status("Tolkar uppgiften")
        p.ui.step("UNDERSÖKER desktop_context")
        self.assertEqual(p.trace[-1][1], None)
        p.ui.step_done(True)
        self.assertEqual(p.trace[-1][1], True)
        self.assertIn("desktop_context", "".join(x[1] for x in p._side_text()))

    def test_chat_is_separate_from_tool_updates(self):
        p = self.build()
        p.ui._out("buddy › Hej!")
        p.ui.step("run_command")
        self.assertIn("Hej!", p._chat.text)
        self.assertNotIn("run_command", p._chat.text)
        self.assertEqual(len(p.trace), 1)

    def test_sidebar_redraw_never_calls_blocking_companion_methods(self):
        p = self.build()
        class FailsIfPolled:
            def __getattr__(self, name):
                raise AssertionError("render unexpectedly accessed Companion: " + name)
        p.app.companion = FailsIfPolled()
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("COMPANION: OFF", rendered)

    def test_companion_cache_update_keeps_render_pure(self):
        p = self.build()
        class FakeLoop:
            captures = 0
            last_capture_at = 0
            last_tick_at = 0
            last_capture_note = "capture not configured"
            ticks = 0
            def options(self):
                return {"enabled": True, "capture_seconds": 30, "tick_seconds": 30}
            def idle_seconds(self):
                return 12
        loop = FakeLoop()
        p.app.companion = SimpleNamespace(present=lambda: (True, ""), loop=loop)
        p._read_companion_state()
        self.assertEqual(p._cached_idle_seconds, 12)
        self.assertTrue(p._cached_companion_enabled)
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("COMPANION: LIVE", rendered)

    def test_submit_is_visible_before_agent_runs(self):
        p = self.build()
        field = SimpleNamespace(text="hej, kan du hjälpa mig?")
        self.assertTrue(p._submit(field))
        self.assertEqual(field.text, "")
        self.assertIn("hej, kan du hjälpa mig?", p._chat.text)
        self.assertEqual(p.queue.get_nowait(), "hej, kan du hjälpa mig?")

    def test_thinking_label_click_uses_supported_prompt_toolkit_fragments(self):
        from prompt_toolkit.data_structures import Point
        from prompt_toolkit.mouse_events import MouseButton, MouseEvent, MouseEventType
        p = self.build()
        self.assertTrue(p.show_thinking)
        p._status_control.create_content(width=39, height=35)
        # The status text supplies an actual prompt_toolkit mouse handler.
        clickable = [frag for frag in p._side_text() if len(frag) == 3]
        self.assertEqual(len(clickable), 1)
        clickable[0][2](MouseEvent(position=Point(x=1, y=0),
                                   event_type=MouseEventType.MOUSE_UP,
                                   button=MouseButton.LEFT, modifiers=frozenset()))
        self.assertFalse(p.show_thinking)

    def test_live_stream_preview_can_be_toggled_and_cleared(self):
        p = self.build()
        p.toggle_thinking()
        self.assertFalse(p.show_thinking)
        p.stream_begin()
        p.stream_delta("He")
        p.stream_delta("j!")
        self.assertIn("Hej!", p._chat.text)
        p.stream_end()
        self.assertNotIn("Hej!", p._chat.text)
        p.ui._out("buddy › Hej!")
        self.assertEqual(p._chat.text.count("Hej!"), 1)
        p.toggle_thinking()
        self.assertTrue(p.show_thinking)

    def test_colour_and_ansi_are_clean(self):
        p = self.build()
        p.ui._out("\x1b[36mbuddy › vit text\x1b[0m")
        self.assertNotIn("\x1b", p._chat.text)
        self.assertIn("vit text", p._chat.text)

    def test_bounded_chat_and_safe_compact_trace(self):
        p = self.build()
        for i in range(500):
            p.ui._out("Reply " + str(i))
        self.assertLessEqual(len(p.messages), 220)
        self.assertNotIn("\n", clean_line("line 1\nsecret", 30))
        self.assertIn("Reply 499", p._chat.text)


if __name__ == "__main__":
    unittest.main()
