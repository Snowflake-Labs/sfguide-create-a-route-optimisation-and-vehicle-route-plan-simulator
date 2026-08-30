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

# Instants (minutes since midnight) the same-day invariant is swept over. NOT
# just the slider default: the ON_SITE regression was a parked-vehicle failure
# only visible in the early-morning window, so 05:00 is load-bearing here.
# Issued as ONE statement per instant - do NOT fold them into a single query with
# a correlated table function over a minutes list, which aborts with Snowflake
# internal error 300010.
INVARIANT_MINUTES = (300, 540, 780, 1020)   # 05:00, 09:00, 13:00, 17:00

# Resolved service day for a region: the busiest day, tie-broken deterministically.
# MIRRORS the `SD` fragment in add_delivery_sync_view.py - if that changes, change
# this with it, exactly like the context-bind mirroring above.
SD_SQL = ("(SELECT SERVICE_DATE FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
          "WHERE REGION = '%s' GROUP BY 1 "
          "ORDER BY COUNT(*) DESC, SERVICE_DATE DESC LIMIT 1)")


def same_day_invariant_sql(region: str, minute: int) -> str:
    """Count vehicles LIVE_FLEET_STATUS classifies against a site that is NOT on
    the service day the rest of the page is showing.

    Why this check exists
    --------------------
    `next_site` once resolved "the next visit EVER" (ARRIVAL_TS > as_of with no
    SERVICE_DATE filter), so a vehicle with nothing to do today was reported en
    route to a site days away. The ring layers ARE day-scoped, so that site had no
    isochrone: the map showed an APPROACHING vehicle with no ring anywhere near it.
    Every other check passed - the SQL was valid, the query returned rows and the
    view rendered - so only an explicit invariant catches it.

    Why it is SWEPT over several instants
    -------------------------------------
    The same defect class then recurred on the OTHER branch: the ON_SITE
    containment test joined the whole monitored POI estate, so a vehicle parked on
    an unplanned warehouse read "On site now" naming a site with no marker, no
    geofence circle and no feed row. That is a PARKED-vehicle failure, most
    visible in the early-morning window, and sampling one instant (09:00) is what
    let it ship. One instant is not a guard - it is a spot check.

    Expected result is 0. Uses the live function (so it exercises the real code
    path, ORS included, which this harness already requires).
    """
    sd = SD_SQL % region
    return (
        "WITH fs AS (SELECT VEHICLE_ID, STATUS_ENUM, SITE_ID FROM TABLE("
        "FLEET_APP.DELIVERY_SYNC.LIVE_FLEET_STATUS('{r}', "
        "(SELECT ORS_PROFILE FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
        "WHERE REGION = '{r}' LIMIT 1), "
        "DATEADD('minute', {m}, {sd}::TIMESTAMP_NTZ), "
        "(SELECT ROUND(APPROACH_SECONDS/60.0) FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
        "WHERE REGION = '{r}' LIMIT 1), 20, 20))), "
        "day_sites AS (SELECT DISTINCT SITE_ID FROM FLEET_APP.DELIVERY_SYNC.VW_SITE_VISITS "
        "WHERE REGION = '{r}' AND SERVICE_DATE = {sd}) "
        "SELECT COUNT(*) AS N FROM fs WHERE fs.SITE_ID IS NOT NULL "
        "AND fs.SITE_ID NOT IN (SELECT SITE_ID FROM day_sites);"
    ).format(r=region, m=minute, sd=sd)


def feed_map_coherence_sql(region: str, minute: int) -> str:
    """Count vehicles whose LATEST feed event says DEPARTED while the map still
    shows them ON_SITE at the same site.

    Why this check exists
    --------------------
    The feed used to label DEPARTURE_TS as 'DEPARTED', but DEPARTURE_TS is
    MAX(TS) over the STATIONARY CORE - the product-ready moment, not an exit. On
    UsNewJersey 2026-08-07 not one of the 134 visits had the vehicle outside its
    geofence at its own DEPARTURE_TS (107 next-ping-still-inside, real exit a
    median 85 s later; 27 with no further ping at all). So at 05:20 the feed read
    "DEPARTED / Phase III Trucking Inc / V-DRI-00023" while the tooltip on the
    same vehicle read "On site now - On site, unload complete", the vehicle being
    parked 38.8 m inside a 200 m fence with no later ping in existence.

    The fourth instance of one class: two different facts rendered under one
    label. The three fixes before it moved the MAP onto the fact the map plots;
    the feed kept the old vocabulary, so nothing caught it. DEPARTED is now
    emitted at EXIT_TS - the first ping actually observed OUTSIDE the fence - and
    omitted entirely when that was never observed, which makes this invariant
    structural rather than a tuning exercise.

    Expected result is 0, and it is non-zero on the pre-fix code, which is what
    makes it a guard rather than a restatement.

    Written as LEFT JOIN + COUNT, NOT correlated EXISTS: a correlated EXISTS over
    a table-function result fails "Unsupported subquery type cannot be evaluated".
    """
    sd = SD_SQL % region
    asof = "DATEADD('minute', %d, %s::TIMESTAMP_NTZ)" % (minute, sd)
    return (
        # Live map status at the instant.
        "WITH fs AS (SELECT VEHICLE_ID, STATUS_ENUM, SITE_ID FROM TABLE("
        "FLEET_APP.DELIVERY_SYNC.LIVE_FLEET_STATUS('{r}', "
        "(SELECT ORS_PROFILE FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
        "WHERE REGION = '{r}' LIMIT 1), {a}, "
        "(SELECT ROUND(APPROACH_SECONDS/60.0) FROM FLEET_APP.DELIVERY_SYNC.VW_ACTIVE_SCOPE "
        "WHERE REGION = '{r}' LIMIT 1), 20, 20))), "
        # The vehicle's most recent feed row at or before the same instant -
        # exactly what the notification feed shows at the top for that vehicle.
        "last_ev AS (SELECT VEHICLE_ID, SITE_ID, EVENT_TYPE FROM "
        "FLEET_APP.DELIVERY_SYNC.VW_EVENTS "
        "WHERE REGION = '{r}' AND SERVICE_DATE = {sd} AND EVENT_TS <= {a} "
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY EVENT_TS DESC) = 1) "
        "SELECT COUNT(*) AS N FROM fs "
        "LEFT JOIN last_ev e ON e.VEHICLE_ID = fs.VEHICLE_ID "
        "WHERE fs.STATUS_ENUM = 'ON_SITE' AND e.EVENT_TYPE = 'DEPARTED' "
        "AND e.SITE_ID = fs.SITE_ID;"
    ).format(r=region, a=asof, sd=sd)


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

    # Same-day invariant: a vehicle's status must never be about a site that is
    # not on the day being shown, or the map contradicts itself (an APPROACHING
    # marker with no approach ring, or a green "on site" dot on a POI with no
    # geofence circle and no feed row). Enforced for EVERY region, not just the
    # demo one: the regression is most visible on a sparse dataset, which is
    # exactly the region this harness would otherwise only "report". Swept over
    # INVARIANT_MINUTES because the statuses fail at different times of day.
    print("\n=== same-day status invariant ===")
    for region in region_list:
        worst = []
        errored = False
        for minute in INVARIANT_MINUTES:
            rows, err = run_sql(same_day_invariant_sql(region, minute))
            if err:
                print("  SQL ERROR       %-28s %02d:%02d %s"
                      % (region, minute // 60, minute % 60, err))
                failures.append((region, "same-day invariant", err))
                errored = True
                break
            n = rows[0]["N"] if rows else 0
            if n:
                worst.append((minute, n))
        if errored:
            continue
        if worst:
            detail = ", ".join("%02d:%02d=%s" % (m // 60, m % 60, n) for m, n in worst)
            print("  VIOLATED %-27s off-day site classifications at %s"
                  % (region, detail))
            failures.append((region, "same-day invariant",
                             "vehicle(s) target a site not on the shown service day (%s)"
                             % detail))
        else:
            print("  OK      %-28s no off-day site classifications (%d instants)"
                  % (region, len(INVARIANT_MINUTES)))

    # Feed-vs-map coherence: the notification feed and the map status must not
    # describe the same vehicle differently. Swept over the same instants and for
    # every region, for the same reason as above - a sparse dataset exposes it and
    # a dense one masks it.
    print("\n=== feed / map coherence invariant ===")
    for region in region_list:
        worst = []
        errored = False
        for minute in INVARIANT_MINUTES:
            rows, err = run_sql(feed_map_coherence_sql(region, minute))
            if err:
                print("  SQL ERROR       %-28s %02d:%02d %s"
                      % (region, minute // 60, minute % 60, err))
                failures.append((region, "feed/map coherence", err))
                errored = True
                break
            n = rows[0]["N"] if rows else 0
            if n:
                worst.append((minute, n))
        if errored:
            continue
        if worst:
            detail = ", ".join("%02d:%02d=%s" % (m // 60, m % 60, n) for m, n in worst)
            print("  VIOLATED %-27s feed says DEPARTED while map says ON_SITE at %s"
                  % (region, detail))
            failures.append((region, "feed/map coherence",
                             "vehicle(s) shown as departed in the feed and on site on "
                             "the map (%s)" % detail))
        else:
            print("  OK      %-28s feed and map agree (%d instants)"
                  % (region, len(INVARIANT_MINUTES)))

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
