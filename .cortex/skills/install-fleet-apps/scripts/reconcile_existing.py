#!/usr/bin/env python3
"""reconcile_existing.py - bring a previously used account's objects into a
shape this installer can build on, BEFORE the steps that assume a fresh one.

Three classes of pre-existing object broke a reuse install, each far from its
cause:

  seed columns   `CREATE TABLE IF NOT EXISTS` keeps an older table shape, so the
                 loader's COPY failed mid-file (ROUTE_OPTIMIZATION.LOOKUP had 10
                 of 13 columns) and every later seed table was never created.
                 Fix: add each declared column the existing table lacks
                 (shapes from seed_contract.py, the same parser the
                 seed_copy_columns gate uses). Data is never touched.
  compute pools  a reused pool SUSPENDED with AUTO_RESUME = FALSE never starts,
                 so services hang. Fix: AUTO_RESUME = TRUE + RESUME IF SUSPENDED.
                 MIN/MAX_NODES are the owner's cost choice and are NOT changed;
                 MIN_NODES above the installer default is reported.
  view names     `CREATE OR REPLACE VIEW x` fails when x is a TABLE or DYNAMIC
                 TABLE (e.g. TRIP_DEVIATION_ANALYSIS left by the retired
                 route-deviation skill). Fix: rename it to x_LEGACY_<YYYYMMDD>,
                 rows kept. Never dropped.

  --check  read-only report (preflight).   --apply  make the changes (installer).
Exit 0 unless an --apply change failed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re
import sys

from seed_contract import strip_comments, table_shapes

SKILL = pathlib.Path(__file__).resolve().parents[1]
TRACK = {"origin": "sf_sit-is-fleet", "name": "oss-install-fleet-apps",
         "version": {"major": 1, "minor": 0},
         "attributes": {"is_quickstart": 1, "source": "sql", "component": "reconcile"}}
POOLS = {"FLEET_APPS_COMPUTE_POOL": 1, "OPENROUTESERVICE_APP_COMPUTE_POOL": 1}  # name -> installer MIN_NODES
_VIEW = re.compile(r"CREATE\s+OR\s+REPLACE\s+(?:SECURE\s+)?VIEW\s+([A-Z_][\w$]*\.[A-Z_][\w$]*\.[A-Z_][\w$]*)", re.I)
_TABLE = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+|DYNAMIC\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
                    r"([A-Z_][\w$]*\.[A-Z_][\w$]*\.[A-Z_][\w$]*)", re.I)
MISSING = ("does not exist", "not authorized")


def installer_sql():
    return [p for p in SKILL.rglob("*.sql") if "node_modules" not in p.parts]


def view_targets(paths=None):
    """FQNs the installer replaces with a view, minus names it ALSO creates as a
    table somewhere (renaming those would fight the installer itself)."""
    views, tables = set(), set()
    for path in paths or installer_sql():
        sql = strip_comments(path.read_text(errors="ignore"))
        views.update(m.group(1).upper() for m in _VIEW.finditer(sql))
        tables.update(m.group(1).upper() for m in _TABLE.finditer(sql))
    return sorted(views - tables)


class Reconciler:
    def __init__(self, session, apply=False, today=None):
        self.session = session
        self.apply = apply
        self.today = today or datetime.date.today().strftime("%Y%m%d")
        self.failures = 0
        self.lines = []

    def run(self, sql):
        return self.session.run(sql)

    def try_run(self, sql):
        try:
            return self.run(sql)
        except Exception as exc:
            if any(m in str(exc).lower() for m in MISSING):
                return None
            raise

    def act(self, what, sql):
        if not self.apply:
            self.lines.append("would " + what)
            return
        try:
            self.run(sql)
            self.lines.append(what)
        except Exception as exc:
            self.failures += 1
            self.lines.append(f"FAILED {what}: {str(exc)[:300]}")

    def seed_columns(self, shapes=None):
        for table, declared in (shapes or table_shapes()).items():
            db, schema, name = table.split(".")
            rows = self.try_run(f"SHOW COLUMNS IN TABLE {table}")
            if not rows:
                continue  # absent (fresh) - the loader creates it at full shape
            if self.is_dynamic(db, schema, name):
                continue  # not ALTERable; view_names() reports it if it matters
            have = {r["column_name"].upper() for r in rows}
            for column, ctype in declared:
                if column not in have and ctype:
                    # One column per statement, no DEFAULT: the only idempotent
                    # form (measured; see datasets/load-seed-data.sql).
                    self.act(f"add column {table}.{column} {ctype}",
                             f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ctype}")

    def is_dynamic(self, db, schema, name):
        rows = self.try_run(f"SHOW DYNAMIC TABLES LIKE '{name}' IN SCHEMA {db}.{schema}") or []
        return any(r["name"].upper() == name for r in rows)

    def pools(self, pools=POOLS):
        for pool, default_min in pools.items():
            rows = [r for r in (self.try_run(f"SHOW COMPUTE POOLS LIKE '{pool}'") or [])
                    if r["name"].upper() == pool]
            if not rows:
                continue
            row = rows[0]
            state = str(row.get("state", "")).upper()
            if str(row.get("auto_resume", "")).lower() not in ("true", "yes", "1"):
                self.act(f"set AUTO_RESUME = TRUE on {pool}",
                         f"ALTER COMPUTE POOL {pool} SET AUTO_RESUME = TRUE")
            if state == "SUSPENDED":
                self.act(f"resume {pool}", f"ALTER COMPUTE POOL {pool} RESUME IF SUSPENDED")
            min_nodes = int(row.get("min_nodes") or 0)
            if min_nodes > default_min:
                self.lines.append(f"WARN {pool} MIN_NODES={min_nodes} (installer default "
                                  f"{default_min}); left unchanged - it bills that many nodes while active")

    def view_names(self, targets=None):
        by_schema = {}
        for fqn in targets or view_targets():
            db, schema, name = fqn.split(".")
            by_schema.setdefault((db, schema), set()).add(name)
        for (db, schema), names in sorted(by_schema.items()):
            tables = {r["name"].upper() for r in (self.try_run(f"SHOW TABLES IN SCHEMA {db}.{schema}") or [])}
            dynamic = {r["name"].upper() for r in (self.try_run(f"SHOW DYNAMIC TABLES IN SCHEMA {db}.{schema}") or [])}
            for name in sorted(names & (tables | dynamic)):
                kind = "DYNAMIC TABLE" if name in dynamic else "TABLE"
                fqn, legacy = f"{db}.{schema}.{name}", f"{name}_LEGACY_{self.today}"
                self.act(f"rename {kind} {fqn} -> {legacy} (blocks the installer's view; rows kept)",
                         f"ALTER {kind} {fqn} RENAME TO {db}.{schema}.{legacy}")


class Session:
    def __init__(self, connection):
        import snowflake.connector
        from snowflake.connector import DictCursor
        self.connection = snowflake.connector.connect(
            connection_name=connection,
            session_parameters={"QUERY_TAG": json.dumps(TRACK, separators=(",", ":"))})
        self.cursor = self.connection.cursor(DictCursor)

    def run(self, sql):
        self.cursor.execute(sql)
        return self.cursor.fetchall()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("-c", "--connection", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    rec = Reconciler(Session(args.connection), apply=args.apply)
    for part in (rec.seed_columns, rec.pools, rec.view_names):
        try:
            part()
        except Exception as exc:
            rec.failures += 1
            rec.lines.append(f"FAILED {part.__name__}: {str(exc)[:300]}")
    for line in rec.lines or ["nothing to reconcile"]:
        print("  " + line)
    return 1 if rec.failures else 0


if __name__ == "__main__":
    sys.exit(main())
