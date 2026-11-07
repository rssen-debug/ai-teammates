#!/usr/bin/env python3
"""Integration tests for the legacy memory migration utility.

These build **real** legacy storage in the exact formats each source product
writes (verified against the source in this repository), then assert the ten
migration rules from the requirements:

 1 discover · 2 inspect schema · 3 verified backup · 4 originals preserved ·
 5 compatible import · 6 safe dedupe · 7 timestamps + provenance ·
 8 count validation · 9 retrieval test · 10 rollback

Stdlib unittest only — no pytest, no network, no Windows required.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_migration as mm  # noqa: E402


def make_omega_db(path: Path, *, memories=2, runs=1, skills=1) -> None:
    """A previous Omega `buddy.db` in the real schema."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.executescript("""
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, content TEXT,
                          tags TEXT, status TEXT DEFAULT 'active', source_run TEXT, created REAL,
                          updated REAL, uses INTEGER DEFAULT 0);
    CREATE TABLE runs(id TEXT PRIMARY KEY, ts REAL, goal TEXT, status TEXT, verified INTEGER,
                      summary TEXT, steps INTEGER, tokens INTEGER);
    CREATE TABLE skills(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, version INTEGER, description TEXT,
                        state TEXT, created REAL, updated REAL);
    CREATE TABLE summaries(id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, content TEXT, upto_id INTEGER);
    """)
    now = time.time()
    for i in range(memories):
        conn.execute("INSERT INTO memories (kind,title,content,tags,status,created,updated,uses) VALUES (?,?,?,?,?,?,?,?)",
                     ("preference" if i == 0 else "fix", f"omega memory {i}",
                      "Owner prefers Neovim over VS Code" if i == 0 else "Fixed WSL networking by disabling mirrorNetworking",
                      "editor legacy", "active", now - 86400 * (10 - i), now - 86400 * (9 - i), 3 - i))
    # A secret-looking memory must never be imported.
    conn.execute("INSERT INTO memories (kind,title,content,tags,status,created,updated) VALUES (?,?,?,?,?,?,?)",
                 ("fact", "api key", "my key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX123456", "", "active", now, now))
    for i in range(runs):
        conn.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)",
                     (f"run-{i}", now - 3600, "install python and verify", "complete", 1,
                      "verified by reading python --version", 12, 5000))
    for i in range(skills):
        conn.execute("INSERT INTO skills (name,version,description,state,created,updated) VALUES (?,?,?,?,?,?)",
                     (f"legacy_skill_{i}", 2, "A previously approved skill", "approved", now - 1000, now - 900))
    conn.execute("INSERT INTO summaries (ts,content,upto_id) VALUES (?,?,?)", (now - 500, "We discussed the router upgrade.", 42))
    conn.commit()
    conn.close()


def make_studdy_db(path: Path) -> None:
    """The old TypeScript Study Buddy `studdy.db` (node:sqlite schema)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.executescript("""
    CREATE TABLE concept(id TEXT PRIMARY KEY, name TEXT, summary TEXT, created_at TEXT);
    CREATE TABLE learning_evidence(id TEXT PRIMARY KEY, concept_id TEXT, detail TEXT, created_at TEXT);
    CREATE TABLE misconception(id TEXT PRIMARY KEY, concept_id TEXT, text TEXT, created_at TEXT);
    CREATE TABLE chat_message(id TEXT PRIMARY KEY, role TEXT, content TEXT, created_at TEXT);
    CREATE TABLE agent_task(id TEXT PRIMARY KEY, title TEXT, result TEXT, created_at TEXT);
    CREATE TABLE provider_config(id TEXT PRIMARY KEY, api_key TEXT, refresh_token TEXT, created_at TEXT);
    """)
    conn.execute("INSERT INTO concept VALUES (?,?,?,?)", ("c1", "TCP three-way handshake",
                                                          "SYN, SYN-ACK, ACK establishes a connection.", "2025-04-01T10:00:00Z"))
    conn.execute("INSERT INTO learning_evidence VALUES (?,?,?,?)", ("e1", "c1", "Owner explained it back correctly", "2025-04-02T11:00:00Z"))
    conn.execute("INSERT INTO misconception VALUES (?,?,?,?)", ("m1", "c1", "Thought SYN-ACK came from the client", "2025-04-03T09:00:00Z"))
    conn.execute("INSERT INTO chat_message VALUES (?,?,?,?)", ("q1", "user", "Vad betyder subnet mask?", "2025-05-01T08:00:00Z"))
    conn.execute("INSERT INTO agent_task VALUES (?,?,?,?)", ("t1", "Summarise chapter 4", "Done, wrote notes.md", "2025-05-02T08:00:00Z"))
    # Credentials: must be excluded entirely.
    conn.execute("INSERT INTO provider_config VALUES (?,?,?,?)", ("p1", "sk-live-SECRETVALUE1234567890",
                                                                  "1//0gREFRESHTOKENSECRET", "2025-01-01T00:00:00Z"))
    conn.commit()
    conn.close()


def make_obsidian_vault(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".obsidian").mkdir(exist_ok=True)
    (path / "app.json").write_text("{}\n", encoding="utf-8")
    (path / "Projekt Alpha.md").write_text(
        "---\ntitle: Projekt Alpha\ncreated: 2025-03-04\ntags: [project, alpha]\nkind: project\n---\n\n"
        "# Projekt Alpha\n\nDecision: use SQLite for the local store.\n", encoding="utf-8")
    (path / "Fixar").mkdir(exist_ok=True)
    (path / "Fixar" / "wsl-network.md").write_text(
        "---\ntitle: WSL network fix\nkind: fix\n---\n\nDisable mirrorNetworking in .wslconfig to fix DNS.\n",
        encoding="utf-8")
    (path / "Secrets.md").write_text("---\ntitle: keys\n---\n\ntoken ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
                                     encoding="utf-8")


def make_majin_v5(v5: Path) -> None:
    (v5 / "memory").mkdir(parents=True, exist_ok=True)
    (v5 / "memory" / "preference.json").write_text(json.dumps({
        "schema": "majin.v2.memory/v1", "kind": "preference", "syncSchema": 1,
        "entries": [
            {"key": "editor", "text": "Owner uses Neovim", "tags": ["editor"], "importance": 0.9,
             "meta": None, "at": "2025-06-01T12:00:00.000Z", "id": "a1b2c3d4e5f60718",
             "syncVersion": {"counter": 1, "actor": "x"}},
            {"key": "secret", "text": "api_key = sk-SECRETSECRETSECRET1234", "tags": [], "importance": 0.5,
             "sensitive": True, "at": "2025-06-02T12:00:00.000Z", "id": "ffff0000"},
        ], "tombstones": []}, indent=2), encoding="utf-8")
    (v5 / "memory" / "tool-success.json").write_text(json.dumps({
        "schema": "majin.v2.memory/v1", "kind": "tool-success", "syncSchema": 1,
        "entries": [{"key": "fs_read relative", "text": "fs_read resolves relative to the workspace root",
                     "tags": ["fs"], "importance": 0.7, "at": "2025-07-01T12:00:00.000Z", "id": "9988"}],
        "tombstones": []}, indent=2), encoding="utf-8")
    (v5 / "learned-procedures.json").write_text(json.dumps({
        "schema": "majin.v5.learning/v1", "updatedAt": "2025-08-01T10:00:00.000Z",
        "procedures": [{"id": "proc-1", "name": "shortlist-jobs", "skillId": "sk-jobs", "verified": True,
                        "steps": [{"tool": "jobs_discover"}, {"tool": "jobs_evaluate"}],
                        "learnedAt": "2025-08-01T09:00:00.000Z"}],
        "scopedAvoidRules": [{"id": "avoid-1", "scope": "browser", "avoid": "never auto-submit a form",
                              "at": "2025-08-01T09:30:00.000Z"}]}, indent=2), encoding="utf-8")
    # Owner grants must be *read live by MAJIN*, never migrated into memory.
    (v5 / "owner-mode.json").write_text(json.dumps({
        "schema": "majin.v4.owner-mode/v1", "version": 1, "lanes": ["files", "jobs"],
        "folders": [str(v5)], "browserOrigins": [], "history": []}), encoding="utf-8")


def make_majin_v6(v6: Path) -> None:
    (v6 / "jobs").mkdir(parents=True, exist_ok=True)
    (v6 / "events").mkdir(parents=True, exist_ok=True)
    (v6 / "jobs" / "applications.json").write_text(json.dumps({
        "schema": "majin.v6.jobs/v1", "version": 1, "updatedAt": "2025-09-01T10:00:00.000Z",
        "applications": [{"id": "app_1", "state": "submitted", "fingerprint": "fp123", "candidateId": "owner",
                          "job": {"company": "Ericsson", "title": "Backend engineer", "url": "https://example.com/j/1"},
                          "createdAt": "2025-09-01T08:00:00.000Z", "updatedAt": "2025-09-01T09:00:00.000Z",
                          "submittedAt": "2025-09-01T09:00:00.000Z",
                          "evidence": {"receipt": "receipt-1", "kind": "dom"}}]}, indent=2), encoding="utf-8")
    (v6 / "jobs" / "profiles.json").write_text(json.dumps({
        "schema": "majin.v6.profiles/v1", "version": 1,
        "candidates": [{"id": "owner", "cvPath": "C:/Users/owner/cv.pdf", "exclusions": ["Atea", "Gigstep"]}]},
        indent=2), encoding="utf-8")
    (v6 / "events" / "2025-09-01.jsonl").write_text(
        "\n".join([json.dumps({"event": "job.discovered", "at": "2025-09-01T08:00:00Z", "count": 3}),
                   json.dumps({"event": "job.submitted", "at": "2025-09-01T09:00:00Z", "id": "app_1"}),
                   json.dumps({"event": "noise.heartbeat", "at": "2025-09-01T09:01:00Z"})]) + "\n", encoding="utf-8")


class MigrationTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-migration-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.home = self.tmp / "StuddyBuddy"
        self.v5 = self.tmp / "MAJIN" / "v5"
        self.v6 = self.tmp / "MAJIN" / "v6"
        self.vault = self.tmp / "Documents" / "MyVault"
        self.roots = {"omega_home": self.home, "studdy_home": self.home, "majin_v5": self.v5,
                      "majin_v6": self.v6, "documents": self.tmp / "Documents", "home": self.tmp,
                      "repo": self.tmp / "repo"}
        self.target = self.tmp / "target" / "buddy.db"

    def build_world(self) -> None:
        make_omega_db(self.home / "buddy.db")
        make_studdy_db(self.home / "studdy.db")
        make_obsidian_vault(self.vault)
        make_majin_v5(self.v5)
        make_majin_v6(self.v6)

    def migrator(self, sink=None) -> mm.Migrator:
        sink = sink or mm.SqliteSink(self.target)
        return mm.Migrator(sink, roots=self.roots)


class TestDiscoveryAndInspection(MigrationTestBase):
    def test_rule1_and_2_discover_and_inspect_real_schemas(self) -> None:
        self.build_world()
        reports = {r.name: r for r in self.migrator().scan()}
        for name in ("omega-db", "studdy-db", "obsidian", "majin-memory", "majin-procedures", "majin-v6"):
            self.assertIn(name, reports)
            self.assertTrue(reports[name].found, f"{name} should have been discovered in the fixture world")
        self.assertIn("majin.v2.memory/v1", reports["majin-memory"].schema)
        self.assertIn("majin.v5.learning/v1", reports["majin-procedures"].schema)
        self.assertIn("majin.v6.jobs/v1", reports["majin-v6"].schema)
        self.assertIn("memories", reports["omega-db"].schema)
        self.assertIn("concept", reports["studdy-db"].schema)
        self.assertGreater(reports["obsidian"].records, 0)

    def test_absent_sources_are_reported_absent_not_invented(self) -> None:
        reports = {r.name: r for r in self.migrator().scan()}
        for r in reports.values():
            self.assertFalse(r.found, f"{r.name} must be absent in an empty world")
            self.assertTrue(r.detail or r.error)

    def test_source_files_are_never_modified(self) -> None:
        self.build_world()
        before = {}
        for p in self.tmp.rglob("*"):
            if p.is_file() and self.target not in p.parents and p != self.target:
                before[p] = (mm.file_sha256(p), p.stat().st_mtime_ns)
        self.migrator().run(dry_run=False)
        for p, (sha, mtime) in before.items():
            self.assertTrue(p.is_file(), f"source file {p} was deleted")
            self.assertEqual(mm.file_sha256(p), sha, f"source file {p} was modified")
            self.assertEqual(p.stat().st_mtime_ns, mtime, f"source file {p} mtime changed")


class TestImportRules(MigrationTestBase):
    def test_rule5_imports_all_seven_sources(self) -> None:
        self.build_world()
        rep = self.migrator().run(dry_run=False)
        self.assertGreater(rep.imported, 0, rep.render())
        for src in ("omega-db", "studdy-db", "obsidian", "majin-memory", "majin-procedures", "majin-v6"):
            self.assertIn(src, rep.by_source, f"nothing imported from {src}\n{rep.render()}")
        self.assertTrue(rep.ok, "\n".join(rep.errors))

    def test_rule4_secrets_are_never_imported(self) -> None:
        self.build_world()
        rep = self.migrator().run(dry_run=False)
        sink = self.migrator().sink
        assert isinstance(sink, mm.SqliteSink)
        blob = "\n".join(f"{r['title']} {r['content']}" for r in
                         sink.db.execute("SELECT title, content FROM memories"))
        for needle in ("sk-proj-ABCDEFGHIJKLMNOP", "sk-live-SECRETVALUE", "ghp_ABCDEFGHIJKL",
                       "1//0gREFRESHTOKENSECRET", "sk-SECRETSECRET"):
            self.assertNotIn(needle, blob, f"a secret reached the unified memory: {needle}")
        self.assertGreater(rep.skipped_secret, 0, "the migrator should have counted skipped secrets")
        # provider_config must not have been read at all
        rows = list(sink.db.execute("SELECT COUNT(*) FROM memories WHERE tags LIKE '%provider_config%'"))
        self.assertEqual(rows[0][0], 0)

    def test_rule5_legacy_records_arrive_untrusted(self) -> None:
        self.build_world()
        self.migrator().run(dry_run=False)
        sink = self.migrator().sink
        assert isinstance(sink, mm.SqliteSink)
        statuses = {r[0] for r in sink.db.execute("SELECT DISTINCT status FROM memories")}
        self.assertEqual(statuses, {"migrated"}, "legacy knowledge must not be auto-promoted to verified/active")
        for row in sink.db.execute("SELECT tags FROM memories"):
            self.assertIn("legacy", row[0])

    def test_rule6_dedupe_is_safe_and_idempotent(self) -> None:
        self.build_world()
        first = self.migrator().run(dry_run=False)
        n1 = first.imported
        # A second run against the same target must add nothing.
        sink2 = mm.SqliteSink(self.target)
        second = mm.Migrator(sink2, roots=self.roots).run(dry_run=False)
        self.assertEqual(second.imported, 0, f"re-running imported {second.imported} duplicates")
        self.assertGreaterEqual(second.duplicates, n1)
        self.assertEqual(sink2.count(), n1)

    def test_rule6_identical_knowledge_in_two_sources_imports_once(self) -> None:
        make_omega_db(self.home / "buddy.db", memories=0, runs=0, skills=0)
        conn = sqlite3.connect(str(self.home / "buddy.db"))
        now = time.time()
        for db_id in ("omega", "studdy-copy"):
            conn.execute("INSERT INTO memories (kind,title,content,tags,created,updated) VALUES (?,?,?,?,?,?)",
                         ("preference", "same knowledge", "Owner prefers Neovim over VS Code", db_id, now, now))
        conn.commit()
        conn.close()
        rep = self.migrator().run(dry_run=False, only=["omega-db"])
        # the fixture database also holds one conversation summary, so two
        # records arrive in total — but the duplicated knowledge arrives once.
        self.assertEqual(rep.duplicates, 1, "identical content must be deduplicated")
        sink = self.migrator().sink
        assert isinstance(sink, mm.SqliteSink)
        same = list(sink.db.execute("SELECT COUNT(*) FROM memories WHERE title='same knowledge'"))[0][0]
        self.assertEqual(same, 1, "the same knowledge was imported twice")

    def test_rule7_timestamps_and_provenance_are_preserved(self) -> None:
        self.build_world()
        self.migrator().run(dry_run=False, only=["majin-memory"])
        sink = self.migrator().sink
        assert isinstance(sink, mm.SqliteSink)
        row = sink.db.execute("SELECT title, created, provenance FROM memories WHERE title='editor'").fetchone()
        self.assertIsNotNone(row, "the MAJIN preference entry was not imported")
        expected = mm.parse_iso("2025-06-01T12:00:00.000Z")
        self.assertAlmostEqual(float(row["created"]), expected, delta=2,
                               msg="original MAJIN timestamp was not preserved")
        prov = json.loads(row["provenance"])
        self.assertEqual(prov["source"], "majin-memory")
        self.assertEqual(prov["id"], "a1b2c3d4e5f60718")
        self.assertIn("memory", prov["path"])
        self.assertIn("migrated_at", prov)

    def test_rule8_count_validation_catches_a_lying_sink(self) -> None:
        self.build_world()

        class LyingSink(mm.ListSink):
            def save(self, rec):  # pretends to save, does not
                return 0

            def count(self):
                return 0

        rep = mm.Migrator(LyingSink(), roots=self.roots).run(dry_run=False)
        self.assertFalse(rep.ok)
        self.assertTrue(any("count validation failed" in e for e in rep.errors), rep.errors)

    def test_rule9_retrieval_is_proved_after_import(self) -> None:
        self.build_world()
        rep = self.migrator().run(dry_run=False, retrieval_probe="Neovim")
        self.assertEqual(rep.retrieval_check.get("status"), "PASS", rep.retrieval_check)
        self.assertTrue(rep.ok)

    def test_rule9_retrieval_failure_fails_the_migration(self) -> None:
        self.build_world()
        rep = self.migrator().run(dry_run=False, retrieval_probe="zzz-not-a-real-term-zzz")
        self.assertEqual(rep.retrieval_check.get("status"), "FAIL")
        self.assertFalse(rep.ok)


class TestBackupAndRollback(MigrationTestBase):
    def test_rule3_backup_is_taken_and_verified(self) -> None:
        self.build_world()
        sink = mm.SqliteSink(self.target)
        sink.save(mm.Record(kind="long_term", title="pre-existing", content="must survive"))
        mig = mm.Migrator(sink, roots=self.roots)
        rep = mig.run(dry_run=False)
        self.assertTrue(rep.backup, "no backup was recorded")
        self.assertTrue(Path(rep.backup).is_file())
        self.assertEqual(len(rep.backup_sha256), 64)
        self.assertEqual(mm.file_sha256(Path(rep.backup)), rep.backup_sha256)
        conn = sqlite3.connect(rep.backup)
        titles = {r[0] for r in conn.execute("SELECT title FROM memories")}
        conn.close()
        self.assertIn("pre-existing", titles, "the backup does not contain the pre-migration data")

    def test_rule3_dry_run_writes_nothing(self) -> None:
        self.build_world()
        rep = self.migrator().run(dry_run=True)
        self.assertTrue(rep.dry_run)
        self.assertEqual(rep.backup, "", "a dry run must not create a backup")
        self.assertFalse(self.target.is_file(), "a dry run created the target database")
        self.assertGreater(rep.imported, 0, "a dry run should still report what it *would* import")

    def test_rule10_rollback_restores_the_exact_pre_migration_state(self) -> None:
        self.build_world()
        sink = mm.SqliteSink(self.target)
        sink.save(mm.Record(kind="long_term", title="pre-existing", content="original knowledge"))
        before_sha = mm.file_sha256(self.target)
        mig = mm.Migrator(sink, roots=self.roots)
        rep = mig.run(dry_run=False)
        self.assertGreater(rep.imported, 0)
        after_sha = mm.file_sha256(self.target)
        self.assertNotEqual(before_sha, after_sha)
        self.assertTrue(mig.rollback(rep.backup))
        conn = sqlite3.connect(str(self.target))
        titles = {r[0] for r in conn.execute("SELECT title FROM memories")}
        count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        conn.close()
        self.assertEqual(titles, {"pre-existing"})
        self.assertEqual(count, 1, "rollback did not restore the pre-migration row count")

    def test_rollback_refuses_a_missing_backup(self) -> None:
        self.build_world()
        mig = self.migrator()
        mig.run(dry_run=False)
        self.assertFalse(mig.rollback(str(self.tmp / "nope.db")))


class TestSourceFidelity(unittest.TestCase):
    """Each adapter must read the real format, not a guess."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-src-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_majin_v2_sensitive_entries_are_refused_at_the_source(self) -> None:
        v5 = self.tmp / "v5"
        make_majin_v5(v5)
        src = mm.MajinMemorySource(memory_dir=v5 / "memory")
        recs = list(src.records())
        keys = {r.title for r in recs}
        self.assertIn("editor", keys)
        self.assertNotIn("secret", keys, "MAJIN marks it sensitive; it must never be read")

    def test_obsidian_frontmatter_drives_kind_and_timestamps(self) -> None:
        vault = self.tmp / "vault"
        make_obsidian_vault(vault)
        src = mm.ObsidianSource(vaults=[vault])
        recs = {r.title: r for r in src.records()}
        self.assertIn("Projekt Alpha", recs)
        self.assertEqual(recs["Projekt Alpha"].kind, "project", "frontmatter kind: project must map to 'project'")
        self.assertIn("obsidian", recs["Projekt Alpha"].tags)
        self.assertEqual(recs["WSL network fix"].kind, "fix")
        self.assertAlmostEqual(recs["Projekt Alpha"].created, mm.parse_iso("2025-03-04"), delta=86400)

    def test_majin_v6_application_history_becomes_searchable_episodic_memory(self) -> None:
        v6 = self.tmp / "v6"
        make_majin_v6(v6)
        recs = list(mm.MajinV6Source(home=v6).records())
        apps = [r for r in recs if r.title.startswith("application:")]
        self.assertEqual(len(apps), 1)
        self.assertIn("Ericsson", apps[0].title)
        self.assertEqual(apps[0].kind, "episodic")
        self.assertEqual(apps[0].extra.get("fingerprint"), "fp123")
        self.assertIn("receipt-1", apps[0].content, "the submission evidence must survive migration")
        cands = [r for r in recs if r.title.startswith("job candidate profile")]
        self.assertEqual(len(cands), 1)
        self.assertIn("Atea", cands[0].content, "owner exclusions must be preserved")

    def test_studdy_db_excludes_provider_config_by_table(self) -> None:
        db = self.tmp / "studdy.db"
        make_studdy_db(db)
        src = mm.StuddyDbSource(db_path=db)
        recs = list(src.records())
        self.assertTrue(any("TCP three-way" in r.title or "TCP three-way" in r.content for r in recs))
        self.assertFalse(any(r.extra.get("table") == "provider_config" for r in recs))

    def test_corrupt_source_does_not_abort_the_migration(self) -> None:
        v5 = self.tmp / "v5"
        (v5 / "memory").mkdir(parents=True)
        (v5 / "memory" / "broken.json").write_text("{not json at all", encoding="utf-8")
        (v5 / "memory" / "good.json").write_text(json.dumps({
            "schema": "majin.v2.memory/v1", "kind": "preference",
            "entries": [{"key": "k", "text": "still readable", "tags": [], "at": "2025-01-01T00:00:00Z"}]}),
            encoding="utf-8")
        recs = list(mm.MajinMemorySource(memory_dir=v5 / "memory").records())
        self.assertEqual([r.title for r in recs], ["k"])

    def test_not_a_sqlite_database_is_reported_not_crashed(self) -> None:
        bad = self.tmp / "buddy.db"
        bad.write_text("this is not sqlite", encoding="utf-8")
        reports = mm.OmegaDbSource(db_path=bad).discover()
        self.assertTrue(reports[0].found)
        self.assertTrue(reports[0].error)


class TestHelpers(unittest.TestCase):
    def test_parse_iso_handles_js_millis_unix_and_strings(self) -> None:
        self.assertAlmostEqual(mm.parse_iso("2025-06-01T12:00:00.000Z"), mm.parse_iso(1748779200), delta=1)
        self.assertAlmostEqual(mm.parse_iso(1748779200000), 1748779200, delta=1)
        self.assertAlmostEqual(mm.parse_iso("2025-06-01 12:00:00"), mm.parse_iso(1748779200), delta=7200)
        self.assertIsNone(mm.parse_iso(None))
        self.assertIsNone(mm.parse_iso("not a date"))

    def test_dedupe_key_ignores_whitespace_and_case(self) -> None:
        a = mm.Record(kind="long_term", title="Owner  Prefers Neovim", content="yes")
        b = mm.Record(kind="long_term", title="owner prefers neovim", content="yes")
        c = mm.Record(kind="long_term", title="owner prefers emacs", content="yes")
        self.assertEqual(a.dedupe_key, b.dedupe_key)
        self.assertNotEqual(a.dedupe_key, c.dedupe_key)

    def test_looks_secret_catches_names_and_values(self) -> None:
        self.assertTrue(mm.looks_secret("api_key", ""))
        self.assertTrue(mm.looks_secret("", "ghp_" + "A" * 30))
        self.assertTrue(mm.looks_secret("", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop"))
        self.assertFalse(mm.looks_secret("title", "Owner prefers Neovim"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
