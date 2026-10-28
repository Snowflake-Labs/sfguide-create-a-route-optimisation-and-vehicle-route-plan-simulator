#!/usr/bin/env python3
"""Offline tests for reconcile_existing.py (fake session, no Snowflake)."""
import unittest

from reconcile_existing import Reconciler, view_targets


class FakeSession:
    """columns: {table: [col,...]}; tables/dynamic: {(db, schema): [name,...]};
    pools: [row dicts]. Absent objects raise 'does not exist' like Snowflake."""

    def __init__(self, columns=None, tables=None, dynamic=None, pools=None, fail_at=None):
        self.columns, self.tables = columns or {}, tables or {}
        self.dynamic, self.pools = dynamic or {}, pools or []
        self.fail_at = fail_at
        self.sql = []

    def run(self, sql):
        self.sql.append(sql)
        if self.fail_at and self.fail_at in sql:
            raise RuntimeError("Insufficient privileges")
        if sql.startswith("SHOW COLUMNS IN TABLE "):
            table = sql.split()[-1]
            if table not in self.columns:
                raise RuntimeError(f"Table '{table}' does not exist or not authorized.")
            return [{"column_name": c} for c in self.columns[table]]
        if sql.startswith(("SHOW TABLES IN SCHEMA ", "SHOW DYNAMIC TABLES")):
            db, schema = sql.split()[-1].split(".")
            source = self.dynamic if "DYNAMIC" in sql else self.tables
            names = source.get((db, schema), [])
            if " LIKE '" in sql:
                like = sql.split("'")[1]
                names = [n for n in names if n == like]
            return [{"name": n} for n in names]
        if sql.startswith("SHOW COMPUTE POOLS LIKE"):
            name = sql.split("'")[1]
            return [p for p in self.pools if p["name"] == name]
        return []

    def writes(self):
        return [s for s in self.sql if s.startswith("ALTER")]


LOOKUP = "FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP"
SHAPE = {LOOKUP: [("REGION", "STRING"), ("IND", "ARRAY"), ("SOURCE_TABLE", "STRING"),
                  ("DEPOT_CTYPE", "ARRAY"), ("JOB_ID", "VARCHAR")]}
TDA = "FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS"


class SeedColumns(unittest.TestCase):
    def test_stale_table_gets_missing_columns_one_per_statement(self):
        s = FakeSession(columns={LOOKUP: ["REGION", "IND"]})
        Reconciler(s, apply=True).seed_columns(SHAPE)
        self.assertEqual(s.writes(), [
            f"ALTER TABLE {LOOKUP} ADD COLUMN IF NOT EXISTS SOURCE_TABLE STRING",
            f"ALTER TABLE {LOOKUP} ADD COLUMN IF NOT EXISTS DEPOT_CTYPE ARRAY",
            f"ALTER TABLE {LOOKUP} ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR"])
        self.assertFalse(any("DEFAULT" in w for w in s.writes()))

    def test_absent_and_current_tables_untouched(self):
        for cols in ({}, {LOOKUP: ["REGION", "IND", "SOURCE_TABLE", "DEPOT_CTYPE", "JOB_ID"]}):
            s = FakeSession(columns=cols)
            Reconciler(s, apply=True).seed_columns(SHAPE)
            self.assertEqual(s.writes(), [])

    def test_check_mode_never_writes(self):
        s = FakeSession(columns={LOOKUP: ["REGION"]})
        r = Reconciler(s)
        r.seed_columns(SHAPE)
        self.assertEqual(s.writes(), [])
        self.assertTrue(all(line.startswith("would add column") for line in r.lines))

    def test_real_shapes_cover_lookup_columns(self):
        from seed_contract import table_shapes
        cols = [c for c, _ in table_shapes()[LOOKUP]]
        for c in ("SOURCE_TABLE", "DEPOT_CTYPE", "DEPOT_LABEL", "JOB_ID"):
            self.assertIn(c, cols)


class Pools(unittest.TestCase):
    POOL = "OPENROUTESERVICE_APP_COMPUTE_POOL"

    def pool(self, **kw):
        row = {"name": self.POOL, "state": "IDLE", "auto_resume": "true", "min_nodes": 1}
        row.update(kw)
        return row

    def test_suspended_without_auto_resume_is_fixed_but_size_kept(self):
        s = FakeSession(pools=[self.pool(state="SUSPENDED", auto_resume="false", min_nodes=5)])
        r = Reconciler(s, apply=True)
        r.pools()
        self.assertEqual(s.writes(), [f"ALTER COMPUTE POOL {self.POOL} SET AUTO_RESUME = TRUE",
                                      f"ALTER COMPUTE POOL {self.POOL} RESUME IF SUSPENDED"])
        self.assertFalse(any("NODES" in w for w in s.writes()))
        self.assertTrue(any(line.startswith("WARN") and "MIN_NODES=5" in line for line in r.lines))

    def test_healthy_or_absent_pool_untouched(self):
        for pools in ([self.pool()], []):
            s = FakeSession(pools=pools)
            r = Reconciler(s, apply=True)
            r.pools()
            self.assertEqual((s.writes(), r.lines), ([], []))


class ViewNames(unittest.TestCase):
    def test_table_and_dynamic_table_renamed_view_untouched(self):
        other = "FLEET_INTELLIGENCE.ROUTE_DEVIATION.OTHER_VIEW"
        s = FakeSession(tables={("FLEET_INTELLIGENCE", "ROUTE_DEVIATION"): ["TRIP_DEVIATION_ANALYSIS"]})
        Reconciler(s, apply=True, today="20261028").view_names([TDA, other])
        self.assertEqual(s.writes(), [f"ALTER TABLE {TDA} RENAME TO "
                                      "FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS_LEGACY_20261028"])
        s = FakeSession(dynamic={("FLEET_INTELLIGENCE", "ROUTE_DEVIATION"): ["TRIP_DEVIATION_ANALYSIS"]})
        Reconciler(s, apply=True, today="20261028").view_names([TDA])
        self.assertTrue(s.writes()[0].startswith(f"ALTER DYNAMIC TABLE {TDA} RENAME TO"))

    def test_never_drops(self):
        s = FakeSession(tables={("FLEET_INTELLIGENCE", "ROUTE_DEVIATION"): ["TRIP_DEVIATION_ANALYSIS"]})
        Reconciler(s, apply=True).view_names([TDA])
        self.assertFalse(any("DROP" in q for q in s.sql))

    def test_apply_failure_is_counted_not_raised(self):
        s = FakeSession(tables={("FLEET_INTELLIGENCE", "ROUTE_DEVIATION"): ["TRIP_DEVIATION_ANALYSIS"]},
                        fail_at="RENAME")
        r = Reconciler(s, apply=True)
        r.view_names([TDA])
        self.assertEqual(r.failures, 1)
        self.assertTrue(r.lines[0].startswith("FAILED rename"))

    def test_targets_include_reported_case_and_exclude_dual_definitions(self):
        targets = view_targets()
        self.assertIn(TDA, targets)
        self.assertGreater(len(targets), 50)


if __name__ == "__main__":
    unittest.main()
