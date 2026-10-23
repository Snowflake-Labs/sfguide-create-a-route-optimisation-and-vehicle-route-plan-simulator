#!/usr/bin/env python3
"""Resolve each Overture theme: reuse, Marketplace, then public S3.

--check is read-only and never accepts terms, creates stages, or loads data.
S3 copies are global so existing global Overture tools do not silently return an
AOI subset. File-byte and statement-time limits bound the bulk load. Run through
this entry point, not the upstream eval scripts (which replace tables).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request
import uuid
from contextlib import contextmanager

from overture_contract import (
    CONTRACT_VERSION, FLEET_SEMANTIC_VIEWS, LAYOUTS, LISTINGS, SEMANTIC_VIEWS, columns, database, definitions,
    projection, schema_errors,
)

TRACK = {"origin": "sf_sit-is-fleet", "name": "oss-install-fleet-apps",
         "version": {"major": 1, "minor": 0},
         "attributes": {"is_quickstart": 1, "source": "sql", "component": "overture-s3"}}
COMMENT = json.dumps(TRACK, separators=(",", ":"))
CONTROL = "FLEET_INTELLIGENCE.OVERTURE_LOAD"
STAC_URL = "https://stac.overturemaps.org/catalog.json"
RELEASE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\.\d+")
SCRIPTS = pathlib.Path(__file__).resolve().parent


def identifier(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", value):
        raise ValueError(f"Expected an unquoted Snowflake identifier: {value!r}")
    return '"' + value.upper() + '"'


def owned(comment):
    try:
        value = json.loads(comment or "{}")
        return (value.get("origin") == TRACK["origin"]
                and value.get("attributes", {}).get("component") == "overture-s3")
    except (ValueError, AttributeError):
        return False


def imported(existing):
    return str(existing.get("kind", "")).upper() == "IMPORTED DATABASE" or bool(existing.get("origin"))


def choose_source(existing, listing):
    """Permission/unknown readiness errors must not be mistaken for unavailability."""
    if existing:
        if imported(existing):
            return "imported"
        if owned(existing.get("comment")):
            return "s3"
        return "existing-local"
    if listing is None:
        return "s3"
    ready = str(listing.get("is_ready_for_import", "")).lower()
    if ready in ("true", "yes", "1"):
        return "marketplace"
    if ready in ("false", "no", "0"):
        return "s3"
    raise RuntimeError("Listing readiness is unknown; refusing to infer S3 fallback")


def published_release(document):
    release = document.get("latest")
    if not isinstance(release, str) or not RELEASE_RE.fullmatch(release):
        raise RuntimeError("STAC catalog has no valid published latest release")
    return release


def fetch_release():
    # Only a fixed public metadata GET; no account data or credentials leave here.
    with urllib.request.urlopen(STAC_URL, timeout=30) as response:
        return published_release(json.load(response))


class Session:
    def __init__(self, connection, warehouse, timeout):
        import snowflake.connector
        from snowflake.connector import DictCursor
        self.connection = snowflake.connector.connect(
            connection_name=connection,
            session_parameters={"QUERY_TAG": COMMENT,
                                "STATEMENT_TIMEOUT_IN_SECONDS": timeout})
        self.cursor = self.connection.cursor(DictCursor)
        if warehouse:
            self.run("USE WAREHOUSE " + identifier(warehouse))
        self.query_id = None

    def run(self, sql, params=None):
        self.cursor.execute(sql, params)
        self.query_id = self.cursor.sfqid
        return self.cursor.fetchall()

    @contextmanager
    def transaction(self):
        self.run("BEGIN")
        try:
            yield
            self.run("COMMIT")
        except BaseException:
            self.run("ROLLBACK")
            raise

    def close(self):
        self.cursor.close()
        self.connection.close()


class Preparer:
    def __init__(self, session, *, check=False, max_bytes=500_000_000_000,
                 refresh=False, release=None):
        self.session = session
        self.check = check
        self.max_bytes = max_bytes
        self.refresh = refresh
        self.release = release
        self.run_id = uuid.uuid4().hex
        self.control_ready = False
        self.reserved_bytes = 0

    def run(self, sql, params=None):
        return self.session.run(sql, params)

    def ensure_control(self):
        if self.control_ready:
            return
        self.run(f"CREATE SCHEMA IF NOT EXISTS {CONTROL} COMMENT = '{COMMENT}'")
        self.run(f"CREATE TABLE IF NOT EXISTS {CONTROL}.LOAD_LOG ("
                 "RUN_ID VARCHAR, THEME VARCHAR, RELEASE VARCHAR, CONTRACT_VERSION VARCHAR, "
                 "STATUS VARCHAR, DETAIL VARCHAR, QUERY_ID VARCHAR, RECORDED_AT TIMESTAMP_LTZ) "
                 f"COMMENT = '{COMMENT}'")
        self.control_ready = True

    def log(self, theme, status, detail):
        query_id = self.session.query_id
        self.run(f"INSERT INTO {CONTROL}.LOAD_LOG VALUES (%s,%s,%s,%s,%s,%s,%s,CURRENT_TIMESTAMP())",
                 (self.run_id, theme, self.release, CONTRACT_VERSION, status, detail, query_id))

    def describe(self, theme, schema="CARTO", *, exact=False):
        for table in LAYOUTS[theme]:
            rows = self.run(f"DESCRIBE TABLE {database(theme)}.{schema}.{table}")
            errors = schema_errors(theme, table, rows, exact=exact)
            if errors:
                raise RuntimeError("; ".join(errors))

    def loaded(self, theme):
        # A database or empty table is not evidence of a successful load.
        rows = self.run(f"SELECT RELEASE, CONTRACT_VERSION FROM {CONTROL}.LOAD_LOG "
                        "WHERE THEME=%s AND STATUS='READY' ORDER BY RECORDED_AT DESC LIMIT 1",
                        (theme,))
        return bool(rows and rows[0]["CONTRACT_VERSION"] == CONTRACT_VERSION
                    and (self.release is None or rows[0]["RELEASE"] == self.release))

    def grant(self, theme, existing, role):
        if not existing:
            return "PENDING: source absent; no privileges granted"
        role_sql = identifier(role)
        target_db = database(theme)
        if imported(existing):
            self.run(f"GRANT IMPORTED PRIVILEGES ON DATABASE {target_db} TO ROLE {role_sql}")
        elif owned(existing.get("comment")):
            self.describe(theme, exact=True)
            if not self.loaded(theme):
                raise RuntimeError(f"{theme}: no validated load; refusing reader grants")
            self.run(f"GRANT USAGE ON DATABASE {target_db} TO ROLE {role_sql}")
            self.run(f"GRANT USAGE ON SCHEMA {target_db}.CARTO TO ROLE {role_sql}")
            for table in LAYOUTS[theme]:
                self.run(f"GRANT SELECT ON TABLE {target_db}.CARTO.{table} TO ROLE {role_sql}")
            for view in SEMANTIC_VIEWS.get(theme, {}):
                self.run(f"GRANT SELECT ON SEMANTIC VIEW {target_db}.CARTO.{view} TO ROLE {role_sql}")
        else:
            raise RuntimeError(f"{theme}: existing local source is not loader-owned; "
                               "its owner must grant reader access explicitly")
        return "reader access granted"

    def ensure_semantic_views(self, theme):
        """Recreate the vendor semantic views a share ships alongside its tables.

        Only for loader-owned copies: a share brings its own. Created from the
        vendor's exported YAML (overture_places_semantic_view.yaml) so member
        names, types, synonyms, descriptions, instructions and verified queries
        match; only expressions that no longer resolve on the current table
        columns are corrected. SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML replaces
        with COPY GRANTS, so a rerun keeps reader grants.
        """
        for view, spec in SEMANTIC_VIEWS.get(theme, {}).items():
            text = (SCRIPTS / spec).read_text()
            self.run("CALL SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML(%s, %s)",
                     (f"{database(theme)}.CARTO", text))
            print(f"  semantic view {database(theme)}.CARTO.{view} created", flush=True)

    def import_listing(self, theme):
        listing = LISTINGS[theme]
        self.run(f"CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', '{listing}')")
        # Do not retry errors through S3: an import failure may be a permission or
        # legal/policy error, not a region problem. CREATE without IF NOT EXISTS
        # also rejects a database created by another installer after our probe.
        self.run(f"CREATE DATABASE {database(theme)} FROM LISTING {listing}")

    def ensure_fleet_semantic_view(self, theme):
        """Build the agents' fleet-owned semantic view over whichever source won.

        Same YAML as the S3 in-share copy, only renamed: the base table name is
        identical for a share and an S3 copy, and both carry the contract schema.
        FLEET_APP_USER needs no share privilege for it (verified): the existing
        ALL/FUTURE semantic view grants on the schema are sufficient.
        """
        if theme not in FLEET_SEMANTIC_VIEWS:
            return None
        schema, view, spec = FLEET_SEMANTIC_VIEWS[theme]
        text, count = re.subn(r"(?m)^name: \S+$", f"name: {view}", (SCRIPTS / spec).read_text(), count=1)
        if count != 1:
            raise RuntimeError(f"{spec}: no top-level name to override")
        self.run(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        self.run("CALL SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML(%s, %s)", (schema, text))
        return f"{schema}.{view}"

    def prepare(self, theme, existing, listing):
        result = self.resolve(theme, existing, listing)
        if self.check or result.startswith("PENDING"):
            return result
        # Non-fatal: the tables are usable without it; prune_agent_specs.py then
        # removes query_overture_global, exactly as for any missing view.
        try:
            fqn = self.ensure_fleet_semantic_view(theme)
        except Exception as exc:
            return result + f"; WARN fleet semantic view not built: {str(exc)[:300]}"
        return result + (f"; semantic view {fqn} built" if fqn else "")

    def resolve(self, theme, existing, listing):
        source = choose_source(existing, listing)
        if source in ("imported", "existing-local"):
            self.describe(theme)
            return source + ": reused compatible tables (source data not modified)"
        if source == "marketplace":
            if self.check:
                return "marketplace: ready for acquisition; privileges/terms still required"
            self.import_listing(theme)
            self.describe(theme)
            return "marketplace: acquired and schema checked"
        if existing and self.loaded(theme) and not self.refresh:
            self.describe(theme, exact=True)
            if not self.check:
                self.ensure_semantic_views(theme)
            return "s3: reused validated global copy"
        if self.check:
            return "PENDING: S3 fallback needed; public stage access and load budget checked during install"
        self.ensure_control()
        if self.release is None:
            self.release = fetch_release()
        self.log(theme, "STARTED", "global S3 fallback")
        try:
            self.load_theme(theme, existing)
            self.ensure_semantic_views(theme)
        except Exception as exc:
            self.log(theme, "FAILED", str(exc)[:2000])
            raise
        return f"s3: global {theme} loaded, release {self.release}"

    def load_theme(self, theme, existing):
        target_db = database(theme)
        if not existing:
            self.run(f"CREATE DATABASE {target_db} COMMENT = '{COMMENT}'")
        self.run(f"CREATE SCHEMA IF NOT EXISTS {target_db}.CARTO COMMENT = '{COMMENT}'")
        staging = "LOAD_" + self.run_id.upper()
        self.run(f"CREATE SCHEMA {target_db}.{staging} COMMENT = '{COMMENT}'")
        try:
            self.run(f"CREATE FILE FORMAT {target_db}.{staging}.PARQUET_FMT TYPE=PARQUET "
                     f"BINARY_AS_TEXT=FALSE USE_LOGICAL_TYPE=TRUE COMMENT = '{COMMENT}'")
            # Reserve the budget for ALL tables before starting any bulk scan.
            for table in LAYOUTS[theme]:
                stage = f"{target_db}.{staging}.STG_{table}"
                url = (f"s3://overturemaps-us-west-2/release/{self.release}/"
                       f"theme={theme}/type={table.lower()}/")
                self.run(f"CREATE STAGE {stage} URL='{url}' "
                         f"FILE_FORMAT={target_db}.{staging}.PARQUET_FMT COMMENT = '{COMMENT}'")
                files = self.run(f"LIST @{stage} PATTERN='.*[.]parquet'")
                if not files or any(int(row["size"]) <= 0 for row in files):
                    raise RuntimeError(f"Published release lacks complete nonempty files for {table}")
                size = sum(int(row["size"]) for row in files)
                if self.reserved_bytes + size > self.max_bytes:
                    raise RuntimeError(f"S3 file-byte budget exceeded at {theme}/{table}: "
                                       f"{self.reserved_bytes + size} > {self.max_bytes}; "
                                       "review cost before increasing OVERTURE_MAX_BYTES")
                self.reserved_bytes += size
                print(f"  {table}: {len(files)} files, {size:,} bytes; global load", flush=True)
            existing_tables = {row["name"]: row for row in self.run(
                f"SHOW TABLES IN SCHEMA {target_db}.CARTO")}
            for table in LAYOUTS[theme]:
                if table in existing_tables:
                    if not owned(existing_tables[table].get("comment")):
                        raise RuntimeError(f"Refusing to replace unowned table {target_db}.CARTO.{table}")
                    errors = schema_errors(theme, table, self.run(
                        f"DESCRIBE TABLE {target_db}.CARTO.{table}"), exact=True)
                    if errors:
                        raise RuntimeError("; ".join(errors))
            counts = {}
            for table in LAYOUTS[theme]:
                staged = f"{target_db}.{staging}.{table}"
                self.run(f"CREATE TABLE {staged} ({definitions(theme, table)}) COMMENT = '{COMMENT}'")
                names = ", ".join('"' + name + '"' for name, _ in columns(theme, table))
                self.run(f"INSERT INTO {staged} ({names}) SELECT {projection(theme, table)} "
                         f"FROM @{target_db}.{staging}.STG_{table}")
                self.log(theme, "TABLE_LOADED", table)
                stats = self.run(f"SELECT COUNT(*) AS N, COUNT(DISTINCT ID) AS IDS, COUNT_IF(ID IS NULL OR GEOMETRY IS NULL) AS BAD "
                                 f"FROM {staged}")[0]
                if stats["N"] == 0 or stats["IDS"] != stats["N"] or (stats["BAD"] or 0) != 0:
                    raise RuntimeError(f"{table}: empty source, duplicate ID, or invalid/missing ID/geometry: {stats}")
                if table == "PLACE":
                    shaped = self.run(f"SELECT COUNT_IF(IS_ARRAY(ADDRESSES)) AS ARRAYS, "
                                      f"COUNT_IF(BASIC_CATEGORY IS NOT NULL) AS CATEGORIES FROM {staged}")[0]
                    if not shaped["ARRAYS"] or not shaped["CATEGORIES"]:
                        raise RuntimeError("PLACE: missing address arrays or BASIC_CATEGORY; schema drift")
                if table == "ADDRESS":
                    shaped = self.run(f"SELECT COUNT_IF(IS_ARRAY(ADDRESS_LEVELS)) AS ARRAYS, "
                                      f"COUNT_IF(COUNTRY IS NOT NULL) AS COUNTRIES FROM {staged}")[0]
                    if not shaped["ARRAYS"] or not shaped["COUNTRIES"]:
                        raise RuntimeError("ADDRESS: missing address-level arrays or COUNTRY; schema drift")
                counts[table] = stats["N"]
            self.describe(theme, staging, exact=True)
            existing_tables = {row["name"]: row for row in self.run(
                f"SHOW TABLES IN SCHEMA {target_db}.CARTO")}
            for table in LAYOUTS[theme]:
                if table in existing_tables and not owned(existing_tables[table].get("comment")):
                    raise RuntimeError(f"Refusing to replace unowned table {target_db}.CARTO.{table}")
                self.run(f"CREATE TABLE IF NOT EXISTS {target_db}.CARTO.{table} "
                         f"({definitions(theme, table)}) COMMENT = '{COMMENT}'")
            self.describe(theme, exact=True)
            # No DDL inside this transaction. All tables in a theme and its READY
            # marker publish together. DELETE preserves object identities/grants.
            with self.session.transaction():
                for table in LAYOUTS[theme]:
                    self.run(f"DELETE FROM {target_db}.CARTO.{table}")
                    names = ", ".join('"' + name + '"' for name, _ in columns(theme, table))
                    self.run(f"INSERT INTO {target_db}.CARTO.{table} ({names}) "
                             f"SELECT {names} FROM {target_db}.{staging}.{table}")
                self.log(theme, "READY", json.dumps(counts, sort_keys=True))
        finally:
            try:
                self.run(f"DROP SCHEMA {target_db}.{staging}")
            except Exception as cleanup_error:
                print(f"WARN: staging cleanup failed for {target_db}.{staging}: {cleanup_error}", flush=True)
                # Do not replace a load failure with a cleanup error. A committed
                # theme remains valid; its staging schema is tagged for cleanup.



def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", "-c", required=True)
    parser.add_argument("--warehouse")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--grant-role", help="Grant access to existing sources only; never load")
    parser.add_argument("--force-s3", action="store_true",
                        help="Ignore available listings and load absent themes from S3 (testing, or avoiding listing terms)")
    parser.add_argument("--release")
    parser.add_argument("--max-bytes", type=int, default=500_000_000_000)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args(argv)
    if args.check and args.grant_role:
        parser.error("--check cannot grant privileges")
    if args.grant_role:
        identifier(args.grant_role)
    if args.max_bytes <= 0 or args.timeout <= 0:
        parser.error("Budget and timeout must be positive")
    if args.release and not RELEASE_RE.fullmatch(args.release):
        parser.error("Release must be YYYY-MM-DD.N")
    session = Session(args.connection, args.warehouse, args.timeout)
    try:
        identity = session.run("SELECT CURRENT_ACCOUNT_NAME() AS ACCOUNT, CURRENT_ROLE() AS ROLE, "
                               "CURRENT_REGION() AS REGION, CURRENT_WAREHOUSE() AS WAREHOUSE")[0]
        print("Overture target: " + json.dumps(identity), flush=True)
        if not identity["WAREHOUSE"] and not args.check:
            raise RuntimeError("Select a warehouse with --warehouse before loading")
        # Exact-name match after SHOW; LIKE underscores alone are not exact.
        databases = {row["name"]: row for row in session.run("SHOW DATABASES LIKE 'OVERTURE_MAPS__%'")}
        listing_error = None
        try:
            listings = {} if (args.grant_role or args.force_s3) else {
                row["global_name"]: row for row in session.run("SHOW AVAILABLE LISTINGS")}
        except Exception as exc:
            listings = {}
            listing_error = str(exc)
        preparer = Preparer(session, check=args.check, max_bytes=args.max_bytes,
                            refresh=args.refresh, release=args.release)
        failures = 0
        for theme, listing_id in LISTINGS.items():
            try:
                existing = databases.get(database(theme))
                if not existing and listing_error:
                    raise RuntimeError("Marketplace capability unknown: " + listing_error)
                outcome = (preparer.grant(theme, existing, args.grant_role) if args.grant_role
                           else preparer.prepare(theme, existing, listings.get(listing_id)))
                print(f"{theme}: {outcome}", flush=True)
                failures += outcome.startswith("PENDING:")
            except Exception as exc:
                failures += 1
                print(f"FAILED {theme}: {exc}", flush=True)
        print("S3 copies use the versioned " + CONTRACT_VERSION + " table contract and "
              "recreate the vendor Places semantic view from its exported YAML.")
        return 2 if failures else 0
    finally:
        session.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"ERROR: Overture preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
