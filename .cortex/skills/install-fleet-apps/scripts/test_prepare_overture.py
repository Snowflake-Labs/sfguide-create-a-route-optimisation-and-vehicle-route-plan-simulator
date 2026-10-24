#!/usr/bin/env python3
"""Offline regression tests for the Overture source resolver and publication path."""
import pathlib
import re
import unittest
from contextlib import contextmanager

import yaml

import overture_contract as contract
from prepare_overture import (
    COMMENT, CONTROL, LAYER_COMMENT, Preparer, choose_source, identifier, owned, published_release, render_layer,
)

CREATED = re.compile(r"(?im)^create\s+(?:or\s+replace\s+)?(?:schema|view|table|semantic\s+view|cortex\s+search\s+service)"
                     r"\s+(?:if\s+not\s+exists\s+)?([\w.$]+)")


LAYER = (contract.FLEET_LAYER_SCHEMA, contract.FLEET_SV_SCHEMA)


def in_layer(name):
    return name in LAYER or name.startswith(tuple(schema + "." for schema in LAYER))


def layer_writes(session):
    """Objects the fleet semantic layer created, in order."""
    return [m.group(1) for sql in session.sql for m in [CREATED.search(sql)]
            if m and in_layer(m.group(1))]


def created(session):
    return [m.group(1) for sql in session.sql for m in [CREATED.search(sql)] if m]


def view_calls(session, schema):
    """(schema, yaml) params of every semantic view created in a schema."""
    return [p for sql, p in zip(session.sql, session.params)
            if "SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML" in sql and p[0] == schema]


FLEET_SCHEMA = "FLEET_INTELLIGENCE.SEMANTIC"
SHARE_SCHEMA = "OVERTURE_MAPS__PLACES.CARTO"


class FakeSession:
    def __init__(self, fail_at=None, files=None, ready=False, foreign_table=False):
        self.sql = []
        self.params = []
        self.query_id = "query-1"
        self.fail_at = fail_at
        self.files = files if files is not None else [{"size": 100, "name": "part.parquet"}]
        self.ready = ready
        self.foreign_table = foreign_table
        self.rolled_back = False

    def run(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)
        if self.fail_at and self.fail_at in sql:
            raise RuntimeError("injected failure")
        if sql.startswith("DESCRIBE TABLE"):
            table = sql.split(".")[-1]
            theme = next(theme for theme, tables in contract.LAYOUTS.items() if table in tables)
            return describe(theme, table)
        if sql.startswith("LIST @"):
            return self.files
        if sql.startswith("SHOW TABLES"):
            return [{"name": "PLACE", "comment": "foreign"}] if self.foreign_table else []
        if "SELECT RELEASE, CONTRACT_VERSION" in sql:
            return [{"RELEASE": "2026-10-21.0", "CONTRACT_VERSION": contract.CONTRACT_VERSION}] if self.ready else []
        if "COUNT(*) AS N" in sql:
            return [{"N": 10, "IDS": 10, "BAD": 0}]
        if "COUNT_IF(IS_ARRAY" in sql:
            return [{"ARRAYS": 10, "CATEGORIES": 10, "COUNTRIES": 10}]
        return []

    @contextmanager
    def transaction(self):
        self.run("BEGIN")
        try:
            yield
            self.run("COMMIT")
        except BaseException:
            self.rolled_back = True
            self.run("ROLLBACK")
            raise


def describe(theme, table):
    return [{"name": name, "type": "VARCHAR(16777216)" if kind == "VARCHAR" else kind,
             "null?": "Y", "kind": "COLUMN"} for name, kind in contract.columns(theme, table)]


class ContractTests(unittest.TestCase):
    def test_all_nine_schemas(self):
        expected = {"PLACE": 16, "ADDRESS": 12, "DIVISION": 21, "DIVISION_AREA": 14,
                    "DIVISION_BOUNDARY": 15, "SEGMENT": 21, "CONNECTOR": 5,
                    "BUILDING": 24, "BUILDING_PART": 22}
        for theme, tables in contract.LAYOUTS.items():
            for table in tables:
                with self.subTest(table=table):
                    self.assertEqual(len(contract.columns(theme, table)), expected[table])
                    self.assertEqual(contract.schema_errors(theme, table, describe(theme, table), exact=True), [])
                    self.assertIn("TRY_TO_GEOGRAPHY($1:geometry::BINARY, TRUE)", contract.projection(theme, table))

    def test_missing_or_wrong_columns_fail(self):
        rows = describe("addresses", "ADDRESS")
        self.assertTrue(contract.schema_errors("addresses", "ADDRESS", rows[:-1], exact=True))
        rows[8]["type"] = "VARIANT"
        self.assertTrue(contract.schema_errors("addresses", "ADDRESS", rows, exact=False))

    def test_order_length_scale_nullability(self):
        for mutate in (lambda rows: rows.reverse(),
                       lambda rows: rows[0].update(type="VARCHAR(20)"),
                       lambda rows: rows[-2].update(type="NUMBER(38,2)"),
                       lambda rows: rows[0].update(**{"null?": "N"})):
            rows = describe("addresses", "ADDRESS")
            mutate(rows)
            self.assertTrue(contract.schema_errors("addresses", "ADDRESS", rows, exact=True))

    def test_identifiers_and_release_are_validated(self):
        self.assertEqual(identifier("ROUTING_ANALYTICS"), '"ROUTING_ANALYTICS"')
        for invalid in ("X; DROP DATABASE X", "x.y", 'x"', ""):
            with self.assertRaises(ValueError):
                identifier(invalid)
        self.assertEqual(published_release({"latest": "2026-10-21.0"}), "2026-10-21.0")
        for value in (None, "latest", "2026-10-21.0/evil"):
            with self.assertRaises(RuntimeError):
                published_release({"latest": value})


class ResolverTests(unittest.TestCase):
    def test_sources(self):
        self.assertEqual(choose_source({"kind": "IMPORTED DATABASE", "origin": ""}, None), "imported")
        self.assertEqual(choose_source({"origin": "provider.share"}, None), "imported")
        self.assertEqual(choose_source({"comment": COMMENT}, None), "s3")
        self.assertEqual(choose_source({"comment": "not ours"}, None), "existing-local")
        self.assertEqual(choose_source(None, {"is_ready_for_import": "true"}), "marketplace")
        self.assertEqual(choose_source(None, {"is_ready_for_import": False}), "s3")
        self.assertEqual(choose_source(None, None), "s3")
        with self.assertRaises(RuntimeError):
            choose_source(None, {})
        self.assertFalse(owned("not-json"))

    def test_check_never_writes(self):
        session = FakeSession()
        preparer = Preparer(session, check=True)
        self.assertIn("PENDING", preparer.prepare("addresses", None, None))
        self.assertIn("marketplace", preparer.prepare("places", None, {"is_ready_for_import": True}))
        self.assertIn("reused", preparer.prepare("divisions", {"origin": "share"}, None))
        self.assertTrue(all(sql.startswith("DESCRIBE") for sql in session.sql))

    def test_import_error_does_not_fallback(self):
        session = FakeSession(fail_at="FROM LISTING")
        with self.assertRaises(RuntimeError):
            Preparer(session).prepare("places", None, {"is_ready_for_import": True})
        self.assertFalse(any("CREATE STAGE" in sql for sql in session.sql))

    def test_imported_never_replaced_even_with_refresh(self):
        session = FakeSession()
        Preparer(session, refresh=True, warehouse="WH").prepare("places", {"origin": "share"}, None)
        # The share is only read; every write targets the fleet-owned layer.
        writes = [sql for sql in session.sql if not sql.startswith("DESCRIBE")]
        self.assertTrue(writes)
        self.assertEqual(created(session), layer_writes(session))
        self.assertFalse(any("SEMANTIC_VIEW_FROM_YAML" in sql or sql.startswith(("INSERT", "DELETE"))
                             for sql in writes))
        self.assertEqual(view_calls(session, SHARE_SCHEMA), [])

    def test_validated_local_copy_reused(self):
        session = FakeSession(ready=True)
        result = Preparer(session, warehouse="WH").prepare("places", {"comment": COMMENT}, None)
        self.assertIn("reused", result)
        # No table rebuild: the vendor view restore, then only fleet-layer objects.
        self.assertFalse(any(sql.startswith(("INSERT", "DELETE")) for sql in session.sql))
        self.assertEqual(len(view_calls(session, SHARE_SCHEMA)), 1)
        self.assertEqual(created(session), layer_writes(session))

    def test_partial_database_retried_without_describing_missing_tables(self):
        session = FakeSession()
        Preparer(session, release="2026-10-21.0").prepare("places", {"comment": COMMENT}, None)
        first_describe = next(index for index, sql in enumerate(session.sql) if sql.startswith("DESCRIBE"))
        first_insert = next(index for index, sql in enumerate(session.sql) if sql.startswith("INSERT INTO OVERTURE"))
        self.assertLess(first_insert, first_describe)

    def test_grants_are_source_specific(self):
        for existing, imported in (({"origin": "share"}, True), ({"comment": COMMENT}, False)):
            session = FakeSession(ready=True)
            Preparer(session).grant("places", existing, "FLEET_APP_USER")
            grants = [sql for sql in session.sql if sql.startswith("GRANT")]
            self.assertTrue(grants)
            self.assertEqual(any("IMPORTED PRIVILEGES" in sql for sql in grants), imported)
            self.assertFalse(any("LOAD_LOG" in sql or "ALL TABLES" in sql for sql in grants))
        with self.assertRaises(RuntimeError):
            Preparer(FakeSession()).grant("places", {"comment": "foreign"}, "FLEET_APP_USER")


class LoadTests(unittest.TestCase):
    def load(self, session, theme="places", budget=1000):
        return Preparer(session, release="2026-10-21.0", max_bytes=budget, warehouse="WH").prepare(theme, None, None)

    def test_global_load_all_tables_and_atomic_publish(self):
        for theme in contract.LAYOUTS:
            with self.subTest(theme=theme):
                session = FakeSession()
                self.load(session, theme)
                queries = session.sql
                self.assertTrue(any("BINARY_AS_TEXT=FALSE" in sql for sql in queries))
                inserts = [sql for sql in queries if "SELECT" in sql and "FROM @" in sql]
                self.assertEqual(len(inserts), len(contract.LAYOUTS[theme]))
                self.assertTrue(all("WHERE" not in sql for sql in inserts))
                begin, commit = queries.index("BEGIN"), queries.index("COMMIT")
                deletes = [index for index, sql in enumerate(queries) if sql.startswith("DELETE FROM OVERTURE")]
                self.assertTrue(all(begin < index < commit for index in deletes))
                self.assertFalse(any(sql.startswith("CREATE") for sql in queries[begin:commit]))
                self.assertTrue(any(sql.startswith("DROP SCHEMA") for sql in queries[commit:]))
                # Source tables are never replaced; only the fleet layer uses OR REPLACE.
                self.assertFalse(any("OR REPLACE" in sql and not CREATED.search(sql).group(1).startswith("FLEET_INTELLIGENCE.")
                                     for sql in queries if "OR REPLACE" in sql))
                # The layer is built only after the tables publish.
                self.assertLess(commit, min(i for i, sql in enumerate(queries)
                                            if (m := CREATED.search(sql)) and in_layer(m.group(1))))

    def test_budget_and_missing_files_abort_before_scan(self):
        for session, budget in ((FakeSession(), 50), (FakeSession(files=[]), 1000),
                                (FakeSession(files=[{"size": 0}]), 1000)):
            with self.assertRaises(RuntimeError):
                self.load(session, budget=budget)
            self.assertFalse(any("FROM @" in sql for sql in session.sql))
            self.assertFalse(any(sql.startswith("DELETE FROM OVERTURE") for sql in session.sql))

    def test_scan_failure_keeps_published_data(self):
        session = FakeSession(fail_at="FROM @")
        with self.assertRaises(RuntimeError):
            self.load(session)
        self.assertFalse(any(sql.startswith("DELETE FROM OVERTURE") for sql in session.sql))
        self.assertTrue(any(params and "FAILED" in params for params in session.params))

    def test_publication_failure_rolls_back(self):
        session = FakeSession(fail_at="INSERT INTO OVERTURE_MAPS__PLACES.CARTO.PLACE")
        with self.assertRaises(RuntimeError):
            self.load(session)
        self.assertTrue(session.rolled_back)
        self.assertNotIn("COMMIT", session.sql)

    def test_foreign_table_not_overwritten(self):
        session = FakeSession(foreign_table=True)
        with self.assertRaisesRegex(RuntimeError, "unowned table"):
            self.load(session)
        self.assertFalse(any(sql.startswith("DELETE FROM OVERTURE") for sql in session.sql))

    def test_zero_rows_and_bad_geometry_not_published(self):
        for stats in ({"N": 0, "IDS": 0, "BAD": 0}, {"N": 10, "IDS": 10, "BAD": 1},
                      {"N": 10, "IDS": 9, "BAD": 0}):
            session = FakeSession()
            original = session.run
            def run(sql, params=None):
                result = original(sql, params)
                return [stats] if "COUNT(*) AS N" in sql else result
            session.run = run
            with self.assertRaises(RuntimeError):
                self.load(session)
            self.assertNotIn("BEGIN", session.sql)


class SemanticViewTests(unittest.TestCase):
    SV_CALL = "SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML"

    def test_s3_places_recreates_vendor_view_with_same_name(self):
        session = FakeSession()
        Preparer(session, release="2026-10-21.0", max_bytes=1000).prepare("places", None, None)
        calls = view_calls(session, SHARE_SCHEMA)
        self.assertEqual(len(calls), 1)
        schema, text = calls[0]
        self.assertIn("name: OVERTUREMAPS_PLACES_SEMANTIC_VIEW", text)
        # Created only after the tables publish.
        self.assertLess(session.sql.index("COMMIT"), next(
            i for i, sql in enumerate(session.sql) if self.SV_CALL in sql))

    def test_reused_s3_copy_restores_view(self):
        session = FakeSession(ready=True)
        Preparer(session).prepare("places", {"comment": COMMENT}, None)
        self.assertTrue(any(self.SV_CALL in sql for sql in session.sql))

    def test_imported_share_never_gets_in_share_view_and_check_writes_nothing(self):
        session = FakeSession()
        Preparer(session).prepare("places", {"origin": "share"}, None)
        self.assertEqual(view_calls(session, SHARE_SCHEMA), [])
        session = FakeSession(ready=True)
        Preparer(session, check=True).prepare("places", {"comment": COMMENT}, None)
        self.assertFalse(any(self.SV_CALL in sql or "CREATE" in sql for sql in session.sql))

    def test_fleet_layer_built_for_every_source_and_theme(self):
        cases = {
            "imported": (FakeSession, {"origin": "share"}, None, {}),
            "existing-local": (FakeSession, {"comment": "someone else"}, None, {}),
            "marketplace": (FakeSession, None, {"is_ready_for_import": "true"}, {}),
            "s3 load": (FakeSession, None, None, {"release": "2026-10-21.0", "max_bytes": 1000}),
            "s3 reuse": (lambda: FakeSession(ready=True), {"comment": COMMENT}, None, {}),
        }
        for theme, (view, _) in contract.FLEET_SEMANTIC_VIEWS.items():
            for label, (make, existing, listing, kwargs) in cases.items():
                with self.subTest(theme=theme, source=label):
                    session = make()
                    result = Preparer(session, warehouse="WH", **kwargs).prepare(theme, existing, listing)
                    fqn = f"{contract.FLEET_SV_SCHEMA}.{view}"
                    self.assertIn(f"semantic view {fqn} built", result)
                    self.assertEqual(layer_writes(session)[-1], fqn)
                    sources = {database for database in re.findall(r"\bfrom (OVERTURE_MAPS__\w+)\.CARTO", " ".join(session.sql))}
                    self.assertEqual(sources, {contract.database(theme)})

    def test_render_substitutes_only_contract_constants(self):
        for theme in contract.FLEET_SEMANTIC_VIEWS:
            with self.subTest(theme=theme):
                statements = render_layer(theme, "ROUTING_ANALYTICS")
                text = "\n".join(statements)
                self.assertNotIn("$", text)
                self.assertNotIn("OVERTUREMAPS_PLACES_SEMANTIC_VIEW", text)
                for statement in statements:
                    self.assertIn("comment = '" + LAYER_COMMENT.replace("'", "''") + "'", statement)
        with self.assertRaises(ValueError):
            render_layer("places", "WH; DROP DATABASE X")
        with self.assertRaises(RuntimeError):
            render_layer("places", None)

    def test_layer_comment_is_tracked_but_never_owned_source(self):
        self.assertIn("sf_sit-is-fleet", LAYER_COMMENT)
        self.assertFalse(owned(LAYER_COMMENT))

    def test_fleet_view_failure_is_reported_not_fatal(self):
        session = FakeSession(fail_at="CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE")
        result = Preparer(session, warehouse="WH").prepare("places", {"origin": "share"}, None)
        self.assertIn("WARN fleet semantic view not built", result)
        self.assertFalse(result.startswith("PENDING"))

    def test_agents_target_fleet_views_not_vendor_view(self):
        import json
        app = pathlib.Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app"
        repo = pathlib.Path(__file__).resolve().parents[4]
        expected = {f"{contract.FLEET_SV_SCHEMA}.{view}" for view, _ in contract.FLEET_SEMANTIC_VIEWS.values()}
        for path in (app / "agent-spec.json", app / "super-agent-spec.json"):
            with self.subTest(spec=path.name):
                spec = json.loads(path.read_text())
                self.assertEqual(spec["tool_resources"]["query_overture_global"]["semantic_view"],
                                 "FLEET_INTELLIGENCE.SEMANTIC.SV_OVERTURE_PLACES")
                used = {r.get("semantic_view") for r in spec["tool_resources"].values()}
                self.assertLessEqual(expected, used)
                self.assertEqual(spec["tool_resources"]["overture_category_search"]["name"], contract.CATEGORY_SEARCH)
        for path in (app / "agent-spec.json", app / "super-agent-spec.json",
                     repo / "semantic" / "extend_routing_agent.sql"):
            with self.subTest(file=path.name):
                self.assertNotIn("CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW", path.read_text())

    def test_layer_grants(self):
        session = FakeSession()
        Preparer(session).grant_layer("FLEET_APP_USER")
        self.assertIn(f"GRANT USAGE ON CORTEX SEARCH SERVICE {contract.CATEGORY_SEARCH} TO ROLE \"FLEET_APP_USER\"",
                      session.sql)
        self.assertTrue(all(contract.FLEET_LAYER_SCHEMA in sql for sql in session.sql))

    def test_owned_places_grant_includes_view(self):
        session = FakeSession(ready=True)
        Preparer(session).grant("places", {"comment": COMMENT}, "FLEET_APP_USER")
        self.assertTrue(any("ON SEMANTIC VIEW OVERTURE_MAPS__PLACES.CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW"
                            in sql for sql in session.sql))

    def test_yaml_matches_vendor_members_and_current_columns(self):
        spec = yaml.safe_load((pathlib.Path(__file__).parent / "overture_places_semantic_view.yaml").read_text())
        table = spec["tables"][0]
        self.assertEqual(table["base_table"], {"database": "OVERTURE_MAPS__PLACES", "schema": "CARTO", "table": "PLACE"})
        members = {m["name"] for k in ("dimensions", "time_dimensions", "metrics") for m in table[k]}
        self.assertEqual(len(members), 27)   # 23 dimensions + 1 time dimension + 3 metrics, as vendor
        live = {name for name, _ in contract.columns("places", "PLACE")}
        dead = {"CATEGORIES", "_META_LOADED_AT", "PRIMARY_CATEGORY_NAME"}
        text = " ".join(m["expr"] for k in ("dimensions", "time_dimensions", "metrics") for m in table[k])
        text += " " + " ".join(f["expr"] for f in table.get("filters") or [])
        self.assertNotRegex(text, r"\blist\[0\]\.element|\bCATEGORIES:|\bprimary_category_name\b")
        # Every bare identifier must be a live column, a member, or SQL syntax.
        # Literals, function names and variant path keys (after ':') are skipped.
        bare = re.sub(r"'[^']*'", "''", text)
        syntax = {"AS", "TEXT", "NULL", "TIMESTAMP_TZ", "ILIKE", "OR", "AND"}
        for column in re.findall(r"(?<![:\w])([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()", bare):
            name = column.upper()
            if name in syntax:
                continue
            self.assertNotIn(name, dead, f"expression references removed column {name}")
            self.assertIn(name, live | members, f"expression references unknown column {name}")


class IntegrationTests(unittest.TestCase):
    def test_installer_prepares_before_analytics(self):
        root = pathlib.Path(__file__).parent
        installer = (root / "install_fleet_apps.sh").read_text()
        self.assertLess(installer.index('python3 "$SCRIPTS/prepare_overture.py"'),
                        installer.index('-f "$ANALYTIC_SQL"'))
        self.assertIn("--grant-role FLEET_APP_USER", installer)
        self.assertIn('step "3.5 Overture sources" WARN', installer)
        analytic = (root / "analytic_layer.sql").read_text()
        self.assertNotIn("FROM LISTING GZT0", analytic)
        self.assertIn("IF (poi_count = 0 OR address_count = 0)", analytic)
        preflight = (root / "preflight_new_account.sh").read_text()
        self.assertIn('--connection "$CONNECTION" --check', preflight)
        self.assertNotIn("FROM LISTING $lid", preflight)


if __name__ == "__main__":
    unittest.main()
