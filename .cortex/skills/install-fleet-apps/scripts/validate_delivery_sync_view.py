#!/usr/bin/env python3
"""Validate the delivery_sync view's queries against the app's REAL context.

Why this exists
---------------
Two defects shipped to a user because queries were validated with bind values
chosen by hand rather than the ones the app actually sends:

  1. ":as_of_minute not set" - the query referenced a viewState bind that no area
     declared in data.params. Substituting a literal for it hid the omission.
  2. Four empty KPI cards - the app's context bar defaults the date range to
     `last_365_days` (app-config.json -> app-shell.tsx sets date_range_start =
     today-365, date_range_end = today). Validating with date_range_start = NULL
     never exercised that, and the view resolved to a day with no data.

So this harness deliberately binds what the RUNTIME binds, and asserts non-empty
where non-empty is expected. Executing SQL with convenient literals is not
validation; it is a spell-check.

Usage:
  python3 .cortex/skills/install-fleet-apps/scripts/validate_delivery_sync_view.py [connection] [view_id]

Read-only: issues SELECTs only. Exit code 1 if any expected-non-empty area is
empty, so it can gate a deploy.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

# A bind is ":name" NOT preceded by another colon, so the Snowflake cast operator
# "expr::TIMESTAMP_NTZ" is not mistaken for a bind called ":TIMESTAMP_NTZ".
BIND_RE = re.compile(r'(?<!:):([A-Za-z_][A-Za-z0-9_]*)')
# Single-quoted string literals must be removed before scanning, otherwise time
# format masks such as 'HH24:MI:SS' read as binds named MI and SS.
LITERAL_RE = re.compile(r"'(?:[^']|'')*'")


def find_binds(sql: str):
    """Bind names referenced by a statement, ignoring casts and string literals."""
    return sorted(set(BIND_RE.findall(LITERAL_RE.sub("''", sql))))

APP = (pathlib.Path(__file__).resolve().parents[1]
       / "fleet_sa_app" / "app" / "app-views.json")

CONNECTION = sys.argv[1] if len(sys.argv) > 1 else "fleet_test_evals"
VIEW_ID = sys.argv[2] if len(sys.argv) > 2 else "delivery_sync"

# Mirrors app-shell.tsx date_range handling for the `last_365_days` default
# declared in app-config.json's contextBar. If that default ever changes, this
# must change with it or the harness stops reflecting reality.
# Areas allowed to return zero rows, keyed by LAYER ID (not positional path - a
# path index moves whenever a layer is inserted, which would quietly point the
# exemption at the wrong query). Everything else returning nothing is treated as
# a defect: an empty panel is the failure mode this harness exists to catch, so
# exemptions are named explicitly rather than silently tolerated.
MAY_BE_EMPTY = {
    # One geofence layer per distinct BUFFER_RADIUS_M. The monitored site types
    # yield 200 m (WAREHOUSE) and 100 m (STORE / DESTINATION); the NJ dataset is
    # entirely warehouses, so the 100 m layer has nothing to draw there. The
    # layer is emitted regardless so the view stays correct on a dataset with
    # stores, which means "empty here" is the expected result, not a bug.
    "geofence-100": "NJ has no 100 m (STORE/DESTINATION) sites",
}

BINDS_SQL = {
    ":date_range_start": "DATEADD('day', -365, CURRENT_DATE())::DATE",
    ":date_range_end": "CURRENT_DATE()::DATE",
    ":as_of_minute": "540",     # Slider config.default (09:00, minutes since midnight)
    ":selected_site": "NULL",    # nothing clicked on first render
    ":dataset_id": "NULL",
    ":vehicle_type": "NULL",
}


def run_sql(sql: str):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql)
        path = f.name
    try:
        r = subprocess.run(["snow", "sql", "-c", CONNECTION, "-f", path,
                            "--format", "json"],
                           capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip().splitlines()
            return None, " | ".join(x.strip() for x in err[-3:])[:240]
        return json.loads(r.stdout), None
    except Exception as exc:                                  # noqa: BLE001
        return None, "%s: %s" % (type(exc).__name__, exc)
    finally:
        os.unlink(path)


def collect_queries(view: dict):
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            data = node.get("data")
            if isinstance(data, dict) and isinstance(data.get("query"), str):
                # Carry the layer/area `id` when present. Exemptions and reports key
                # off this rather than the positional path, because inserting one
                # layer renumbers every path after it and would silently move an
                # exemption onto the wrong query.
                found.append((path or "root", data["query"], data.get("params") or {},
                              node.get("id")))
            for key, val in node.items():
                walk(val, ("%s.%s" % (path, key)) if path else key)
        elif isinstance(node, list):
            for i, val in enumerate(node):
                walk(val, "%s[%d]" % (path, i))

    walk(view, "")
    return found


def main() -> int:
    views = json.loads(APP.read_text())
    if VIEW_ID not in views:
        print("ERROR: view %r not in app-views.json" % VIEW_ID, file=sys.stderr)
        return 1
    view = views[VIEW_ID]

    regions, err = run_sql(
        "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS "
        "WHERE IS_ACTIVE ORDER BY REGION;")
    if err:
        print("ERROR resolving active regions: %s" % err, file=sys.stderr)
        return 1
    region_list = [r["REGION"] for r in regions]

    queries = collect_queries(view)
    print("view=%s  areas_with_queries=%d  active_regions=%s"
          % (VIEW_ID, len(queries), ",".join(region_list)))

    failures = []
    for region in region_list:
        # Only the region the demo runs on is required to be non-empty; other
        # regions legitimately have no visits (their POI taxonomies are not in
        # the monitored site types), so they are reported but not enforced.
        enforce = region == "UsNewJersey"
        print("\n=== region %s %s ==="
              % (region, "(enforced non-empty)" if enforce else "(reported only)"))
        for path, query, params, layer_id in queries:
            # Report by layer id when there is one - "geofence-100" says what broke;
            # "areas.map.config.layers[3]" makes you go and count brackets.
            label = layer_id or path
            sql = query
            for name, expr in BINDS_SQL.items():
                sql = sql.replace(name, expr)
            sql = sql.replace(":region", "'%s'" % region)

            # A leftover bind means one the harness does not model; that is itself
            # a defect worth failing on rather than silently passing.
            leftover = find_binds(sql)
            if leftover:
                print("  UNMODELLED BIND %-28s %s" % (label, leftover[:3]))
                failures.append((region, label, "unmodelled bind %s" % leftover[:3]))
                continue

            rows, err = run_sql("SELECT COUNT(*) AS N FROM (\n%s\n);"
                                % sql.rstrip().rstrip(";"))
            if err:
                print("  SQL ERROR       %-28s %s" % (label, err))
                failures.append((region, label, err))
                continue
            n = rows[0]["N"] if rows else 0
            why_empty = MAY_BE_EMPTY.get(layer_id)
            if n == 0 and why_empty:
                # Legitimately empty on this dataset - reported, not failed.
                print("  BY-DESIGN %-24s rows=0  (%s)" % (label, why_empty))
                continue
            flag = "OK   " if (n > 0 or not enforce) else "EMPTY"
            print("  %s %-28s rows=%s" % (flag, label, n))
            if enforce and n == 0:
                failures.append((region, label, "returned 0 rows"))

    # Declared-bind audit: every :bind the SQL references must be declared in
    # that area's data.params, else the renderer never supplies it at runtime.
    print("\n=== declared-bind audit ===")
    ctx_supplied = {"region", "vehicle_type", "date_range_start",
                    "date_range_end", "dataset_id"}
    for path, query, params, layer_id in queries:
        label = layer_id or path
        refs = set(find_binds(query))
        missing = sorted(r for r in refs
                         if r not in params and r not in ctx_supplied)
        if missing:
            print("  MISSING %-28s %s" % (label, missing))
            failures.append(("*", label, "undeclared binds %s" % missing))
        else:
            print("  OK      %-28s refs=%d" % (label, len(refs)))

    print()
    if failures:
        print("FAILED: %d issue(s)" % len(failures))
        for region, path, why in failures:
            print("  [%s] %s -> %s" % (region, path, why))
        return 1
    print("PASSED: all enforced areas non-empty, all binds declared")
    return 0


if __name__ == "__main__":
    sys.exit(main())
