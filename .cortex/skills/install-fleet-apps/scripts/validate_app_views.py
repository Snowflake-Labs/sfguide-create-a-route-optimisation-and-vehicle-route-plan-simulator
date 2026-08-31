#!/usr/bin/env python3
"""Execute EVERY SA app view's queries with the binds the runtime actually sends.

Why this exists
---------------
`check_view_usecases.py` inspects metadata only (useCase present, lowercase
`field`, no Unicode dashes) and `validate_delivery_sync_view.py` executes real
queries but covers ONE view. So 18 of 19 config-driven views had never been
executed by any automated check, and the failure mode they produce - a panel that
renders empty, or a KPI showing a dash - is invisible to every other gate: the
SQL is valid, the deploy succeeds, the app loads.

The bar this harness sets is deliberately higher than "the SQL compiles":

  1. BINDS COME FROM THE VIEW, NOT FROM THE AUTHOR. Every bind is resolved the
     way the renderer resolves it - `context.*` from the context bar's declared
     defaults in app-config.json (including the data-driven date range, resolved
     per region via its `boundsSource` query), `viewState.*` from the view's own
     Slider / FilterBar / toggle defaults. Substituting a convenient literal is
     what let ":as_of_minute not set" and four blank KPI cards ship.

  2. FILTER DEFAULTS ARE RESOLVED BY RUNNING THE FILTER. A FilterBar's first
     option is whatever its own query returns, so a region-scoped filter that
     returns nothing leaves its bind NULL and silently guts every dependent
     layer. That is a real shipped defect class, so the filter query is executed
     rather than assumed.

  3. EMPTY IS A FAILURE UNLESS DECLARED. Legitimately-empty panels are named in
     view-expectations.yaml with a reason. An undeclared empty result fails.

  4. NO `COUNT(*)` WRAPPER. Counting prunes the projection, and a pruned column
     is exactly how a NULL-returning ORS call passes a check it should fail. The
     harness selects the real projection and takes `LIMIT 1`.

Read-only by default (SELECT only). `--repair` re-runs the artifact that OWNS a
failing object; see REPAIR_MAP.

Usage:
  python3 .../validate_app_views.py [-c CONNECTION] [--view ID] [--repair]
                                    [--report PATH] [--list]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

try:
    import snowflake.connector
except ImportError:  # pragma: no cover
    print("ERROR: snowflake-connector-python is required (pip install "
          "snowflake-connector-python)", file=sys.stderr)
    raise SystemExit(2)

try:
    import yaml
except ImportError:  # pragma: no cover
    print("ERROR: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    raise SystemExit(2)

SKILL = pathlib.Path(__file__).resolve().parents[1]
APP_VIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"
APP_CONFIG = SKILL / "fleet_sa_app" / "app" / "app-config.json"
EXPECTATIONS = pathlib.Path(__file__).resolve().parent / "view-expectations.yaml"

QUERY_TAG = ('{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
             '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,'
             '"source":"sql","module":"validate-app-views"}}')

# A bind is ":name" NOT preceded by another colon, so the cast operator
# "expr::TIMESTAMP_NTZ" is not read as a bind named TIMESTAMP_NTZ.
BIND_RE = re.compile(r'(?<!:):([A-Za-z_][A-Za-z0-9_]*)')
# Strip single-quoted literals before scanning or time masks like 'HH24:MI:SS'
# read as binds named MI and SS.
LITERAL_RE = re.compile(r"'(?:[^']|'')*'")

# A suspended regional ORS service does not raise - the wrappers return NULL and
# the layer compiler drops the layer. The repo forces a cast failure carrying
# this token so the failure is visible; recognising it here keeps "the engine is
# asleep" separate from "the view is broken".
ORS_DOWN_TOKENS = ("service_unreachable", "ors-service-")

# Components that genuinely initialise their emitted value from their own query,
# the way a FilterBar filter does: an option picker mounts with row one selected.
# Everything else that emits (ClickableTable, MetricCards, Chart, Map) emits on
# CLICK, so its first-render value is NULL - see viewstate_binds.
QUERY_INITIALISED_CONTROLS = ("ComboBox", "Select", "Dropdown", "Filter", "FilterBar")

# Which artifact owns which schema. Used by --repair, and worth reading as
# documentation in its own right: it is the only place the mapping from "this
# view is empty" to "run this" is written down.
REPAIR_MAP = [
    ("FLEET_APP.CATCHMENT.", "catchment",
     "CALL FLEET_INTELLIGENCE.CATCHMENT.BUILD_CATCHMENT('{region}', TRUE)"),
    ("FLEET_APP.LOCATION.", "location",
     "CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()"),
    ("FLEET_APP.SOURCING.", "sourcing",
     "CALL FLEET_INTELLIGENCE.SOURCING.BUILD_SOURCING_DIAGNOSTICS()"),
    ("FLEET_APP.DELIVERY_SYNC.", "delivery_sync", "@FILE:delivery_sync_layer.sql"),
    ("FLEET_APP.DWELL.", "dwell", "@PACK:dwell"),
    ("FLEET_APP.UNIFIED_FLEET.", "unified_fleet", "@PACK:unified_fleet"),
    ("FLEET_APP.ROUTE_OPTIMIZATION.", "route_optimization", "@PACK:route_optimization"),
    ("FLEET_APP.BACKLOAD_MATCHING.", "backload_matching", "@PACK:backload_matching"),
    ("FLEET_APP.CORE.", "core_contract", "@FILE:../fleet_sa_app/app/scoped_contract.sql"),
    ("FLEET_APP.FLEET_OPS.", "core_contract", "@FILE:../fleet_sa_app/app/scoped_contract.sql"),
    ("FLEET_APP.EMERGENCY_RESPONSE.", "core_contract",
     "@FILE:../fleet_sa_app/app/scoped_contract.sql"),
    ("SYNTHETIC_DATASETS.UNIFIED.V_", "projections", "@FILE:projection_views.sql"),
    ("FLEET_INTELLIGENCE.CORE.DIM_VEHICLE", "catalog", "@FILE:vehicle_profile_catalog.sql"),
]


def find_binds(sql: str) -> list[str]:
    return sorted(set(BIND_RE.findall(LITERAL_RE.sub("''", sql))))


def lit(value) -> str:
    """Render a Python value as a SQL literal the way the renderer would."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'%s'" % str(value).replace("'", "''")


def substitute(sql: str, binds: dict) -> str:
    """Replace :name with a literal. Longest name first, so :selected_store does
    not clobber the prefix of :selected_store_band."""
    for name in sorted(binds, key=len, reverse=True):
        sql = re.sub(r'(?<!:):%s\b' % re.escape(name), lit(binds[name]), sql)
    return sql


def is_ors_down(err: str) -> bool:
    low = (err or "").lower()
    return any(tok in low for tok in ORS_DOWN_TOKENS)


class Session:
    """One Snowflake session for the whole run.

    Deliberately not `snow sql` per query: the CLI costs 4-5 s of startup per
    invocation, which on ~150 queries x N regions swamps the thing being measured
    and makes the harness too slow to run as an install step.
    """

    def __init__(self, connection: str):
        self.con = snowflake.connector.connect(connection_name=connection)
        cur = self.con.cursor()
        cur.execute("ALTER SESSION SET query_tag = '%s'" % QUERY_TAG)
        cur.close()

    def rows(self, sql: str, limit: int | None = None):
        """Return (rows, error). rows is a list of dicts."""
        cur = self.con.cursor(snowflake.connector.DictCursor)
        try:
            cur.execute(sql)
            data = cur.fetchmany(limit) if limit else cur.fetchall()
            return data, None
        except Exception as exc:                                  # noqa: BLE001
            return None, str(exc).replace("\n", " ")[:300]
        finally:
            cur.close()

    def close(self):
        try:
            self.con.close()
        except Exception:                                         # noqa: BLE001
            pass


def collect_query_nodes(view: dict):
    """Every node carrying data.query, labelled by its id when it has one.

    Labels prefer `id` over the positional path because inserting one layer
    renumbers every path after it, which would silently move an expectations
    entry onto a different query.
    """
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            data = node.get("data")
            if isinstance(data, dict) and isinstance(data.get("query"), str):
                found.append({
                    "label": node.get("id") or node.get("name") or path or "root",
                    "path": path,
                    "query": data["query"],
                    "params": data.get("params") or {},
                })
            for key, val in node.items():
                walk(val, ("%s.%s" % (path, key)) if path else key)
        elif isinstance(node, list):
            for i, val in enumerate(node):
                walk(val, "%s[%d]" % (path, i))

    walk(view, "")
    return found


def context_binds(sess: Session, region: str, vehicle_type: str, cfg: list) -> dict:
    """Resolve the context bar exactly as app-shell does.

    The date range is the interesting one: its default is `data_range`, resolved
    from a per-region `boundsSource` query, NOT a fixed window. Hardcoding
    today-365 (as the delivery-sync harness still does) can silently land on a
    range with no data on a dataset whose telemetry sits outside it.
    """
    binds = {"region": region, "vehicle_type": None, "dataset_id": None}
    for ctl in cfg or []:
        cid, ctype = ctl.get("id"), ctl.get("type")
        if ctype == "date_range":
            start = end = None
            src = ctl.get("boundsSource")
            if src:
                rows, err = sess.rows(substitute(src, {"region": region}))
                if not err and rows:
                    start = rows[0].get("MIN_DATE")
                    end = rows[0].get("MAX_DATE")
            if not start:      # documented fallback when the bounds query is empty
                start, end = None, None
            binds["date_range_start"] = start
            binds["date_range_end"] = end
        elif ctype == "enum":
            binds[cid] = ctl.get("default")
        elif ctype == "dataset":
            binds[cid] = None
    binds.setdefault("date_range_start", None)
    binds.setdefault("date_range_end", None)
    return binds


def viewstate_binds(sess: Session, view: dict, ctx: dict, seeds: dict | None = None) -> tuple[dict, list]:
    """Resolve viewState.* the way the controls initialise it.

    Slider  -> config.default
    Toggle  -> config.toggles[].default
    Filter  -> the FIRST ROW of the filter's own query, because that is what the
               FilterBar selects on mount. Executing it is the point: a
               region-scoped filter returning nothing leaves the bind NULL and
               empties every dependent layer, which is a defect the app cannot
               report and a hand-picked literal cannot reveal.
    Click   -> NULL, which is the genuine first-render state, unless a selection
               seed is supplied (see the two-pass design in main()).

    Every bind any area declares as `viewState.X` is registered, so a click-driven
    selection resolves to NULL rather than being reported as unmodelled. Without
    this the harness fails ~90 areas complaining about binds the app itself
    deliberately leaves unset until the user clicks something.
    """
    binds, notes = {}, []
    for node in collect_query_nodes(view):
        for bind, source in (node["params"] or {}).items():
            if isinstance(source, str) and source.startswith("viewState."):
                binds.setdefault(bind, None)
    for area_id, area in (view.get("areas") or {}).items():
        if not isinstance(area, dict):
            continue
        comp = area.get("component")
        conf = area.get("config") or {}
        emits = list((area.get("emits") or {}).keys())
        # Any control that declares a default supplies it to every key it emits.
        # Keyed on the presence of `default` rather than on the component name so
        # Slider / Checkbox / Select all work and a new control type does not
        # silently fall through to NULL.
        #
        # `defaultSource` wins when present, and is EXECUTED, for the same reason
        # the context bar's date `boundsSource` is executed: a literal default
        # encodes an assumption about the data that the data may not honour. If the
        # harness kept using the literal it would keep testing an instant the app
        # no longer opens on, and would report EMPTY for panels a user sees full.
        if emits and ("default" in conf or "defaultSource" in conf):
            value = conf.get("default")
            src = conf.get("defaultSource")
            if src:
                rows, err = sess.rows(substitute(src, dict(ctx)), limit=1)
                if rows and not err:
                    first = next(iter(rows[0].values()), None)
                    if first is not None:
                        lo, hi = conf.get("min"), conf.get("max")
                        step = conf.get("step") or 1
                        num = float(first)
                        if lo is not None:
                            num = max(float(lo), num)
                        if hi is not None:
                            num = min(float(hi), num)
                        base = float(lo) if lo is not None else 0.0
                        num = base + round((num - base) / step) * step
                        value = int(num) if float(num).is_integer() else num
                else:
                    notes.append(("slider:%s" % area_id,
                                  "defaultSource returned nothing%s"
                                  % (" (%s)" % err if err else "")))
            for key in emits:
                binds[key] = value
        # A control whose options come from a query (ComboBox, Select) initialises
        # to the first row, exactly like a FilterBar filter.
        #
        # Restricted to actual option pickers. This used to key only on "the area
        # emits something AND has a data.query", which also caught every
        # CLICK-driven display component - ClickableTable (18 areas) and
        # MetricCards. For those the first-render value is NULL, not row one:
        # nobody has clicked yet. The visible damage was on safety_risk_scorecard,
        # whose KPI card emits `selected_severity` and whose query selects
        # `total_events` first, so the harness bound severity to the event COUNT
        # (79440) and every dependent panel died on `79440 = 'all'` with
        # "Numeric value 'all' is not recognized" - three panels reported as
        # product ERRORs when the app itself is fine (the same predicate with a
        # NULL severity returns all 79440 events). A test that fabricates a
        # selection the UI never makes reports defects that do not exist, and
        # hides the IDLE state it should be asserting.
        elif (comp in QUERY_INITIALISED_CONTROLS and emits
              and isinstance(area.get("data"), dict) and area["data"].get("query")):
            sql = substitute(area["data"]["query"], dict(ctx))
            if not find_binds(sql):
                rows, err = sess.rows(sql, limit=1)
                if rows and not err:
                    row = rows[0]
                    value = row.get("VALUE", next(iter(row.values())))
                    for key in emits:
                        binds[key] = value
        for tog in conf.get("toggles") or []:
            if tog.get("key") is not None:
                binds[tog["key"]] = tog.get("default")
        if comp in ("FilterBar", "Filter"):
            for filt in area.get("filters") or []:
                data = filt.get("data") or {}
                query = data.get("query")
                keys = list((filt.get("emits") or {}).keys())
                if not (query and keys):
                    continue
                sql = substitute(query, dict(ctx))
                leftover = find_binds(sql)
                if leftover:
                    notes.append(("filter:%s" % filt.get("name"),
                                  "unresolved binds %s" % leftover[:3]))
                    for key in keys:
                        binds.setdefault(key, None)
                    continue
                rows, err = sess.rows(sql, limit=1)
                if err:
                    notes.append(("filter:%s" % filt.get("name"), err))
                    for key in keys:
                        binds.setdefault(key, None)
                    continue
                if not rows:
                    notes.append(("filter:%s" % filt.get("name"),
                                  "returned no options%s"
                                  % (" (required)" if filt.get("required") else "")))
                    for key in keys:
                        binds.setdefault(key, None)
                    continue
                row = rows[0]
                value = row.get("VALUE", next(iter(row.values())))
                for key in keys:
                    binds[key] = value
    # Seeded selections override the NULL first-render state on the second pass.
    # Applied IN DECLARATION ORDER, and each seed can reference binds resolved
    # before it. That matters for fidelity: in the app, clicking a journey also
    # fixes the vehicle it belongs to, so seeding the two independently produces a
    # vehicle/journey pair that never co-occurs and empties panels that join them.
    for key, expr in (seeds or {}).items():
        scope = dict(ctx)
        scope.update({k: v for k, v in binds.items() if v is not None})
        sql = substitute(expr, scope)
        leftover = find_binds(sql)
        if leftover:
            notes.append(("seed:%s" % key,
                          "seed references unresolved bind %s (declare it earlier)"
                          % leftover[:3]))
            continue
        rows, err = sess.rows(sql, limit=1)
        if err or not rows:
            notes.append(("seed:%s" % key, err or "seed query returned no rows"))
            continue
        binds[key] = next(iter(rows[0].values()))
    return binds, notes


def expectation_for(exp: dict, view_id: str, label: str) -> dict:
    node = ((exp.get("views") or {}).get(view_id) or {})
    areas = node.get("areas") or {}
    return areas.get(label) or {}


def run_config_views(sess, views, cfg, exp, datasets, only, results, pass_name="render"):
    """Execute every area of every config view.

    Two passes matter, and only running the first is what makes a harness feel
    green while the drill-downs are broken:

      pass "render"    - nothing clicked. Selection-driven layers legitimately
                         return nothing, so they are recorded as SELECTION_IDLE
                         rather than counted as empty.
      pass "selection" - each click bind seeded from the view's own data via
                         `selection_seeds` in view-expectations.yaml, so the
                         drill-down path is actually exercised and IS required
                         to return rows.
    """
    for region, vehicle_type in datasets:
        ctx = context_binds(sess, region, vehicle_type, cfg)
        print("\n################ [%s] region=%s vehicle=%s  date_range=%s..%s"
              % (pass_name, region, vehicle_type, ctx.get("date_range_start"),
                 ctx.get("date_range_end")))
        for view_id, view in views.items():
            if only and view_id not in only:
                continue
            nodes = collect_query_nodes(view)
            if not nodes:
                continue
            seeds = {}
            if pass_name == "selection":
                seeds = ((exp.get("selection_seeds") or {}).get(view_id) or {})
                if not seeds:
                    continue
            vs, notes = viewstate_binds(sess, view, ctx, seeds)
            binds = dict(ctx)
            binds.update(vs)
            # Which binds are still unset - used to tell "nothing selected yet"
            # apart from "this panel is broken".
            unset = {k for k, v in vs.items() if v is None}
            print("\n=== %s (%d queries)" % (view_id, len(nodes)))
            for label, why in notes:
                print("   FILTER-WARN  %-26s %s" % (label, why))
                results.append({"region": region, "view": view_id, "area": label,
                                "status": "FILTER_EMPTY", "detail": why,
                                "pass": pass_name})
            for node in nodes:
                label = node["label"]
                spec = expectation_for(exp, view_id, label)
                if spec.get("expect") == "skip":
                    print("   SKIP  %-28s (%s)" % (label, spec.get("reason", "")))
                    continue
                # Does this query depend on a selection that is not set?
                refs = set(find_binds(node["query"]))
                idle = bool(refs & unset)
                sql = substitute(node["query"], binds)
                leftover = find_binds(sql)
                if leftover:
                    print("   UNMODELLED-BIND %-22s %s" % (label, leftover[:3]))
                    results.append({"region": region, "view": view_id, "area": label,
                                    "status": "UNMODELLED_BIND",
                                    "detail": str(leftover[:3]), "pass": pass_name})
                    continue
                # Execute the query AS WRITTEN and take one row from the cursor.
                #
                # Do NOT wrap it as `SELECT * FROM (<query>) LIMIT 1`. Many of
                # these queries call a table function whose arguments are
                # correlated scalar subqueries, and nesting that inside a derived
                # table changes the plan: Snowflake then fails with internal error
                # 300010 or "Unsupported subquery type cannot be evaluated". The
                # wrapper produced 168 failures that did not exist in the app.
                # Wrapping in COUNT(*) is worse still - it prunes the projection,
                # and a pruned column is exactly how a NULL-returning ORS call
                # passes a check it should fail.
                rows, err = sess.rows(sql.rstrip().rstrip(";"), limit=1)
                if err:
                    if is_ors_down(err):
                        print("   ORS-DOWN %-25s %s" % (label, err[:70]))
                        results.append({"region": region, "view": view_id,
                                        "area": label, "status": "ORS_DOWN",
                                        "detail": err, "pass": pass_name})
                    else:
                        print("   ERROR %-28s %s" % (label, err[:110]))
                        results.append({"region": region, "view": view_id,
                                        "area": label, "status": "ERROR",
                                        "detail": err, "pass": pass_name})
                    continue
                if rows:
                    print("   OK    %-28s rows>=1" % label)
                    results.append({"region": region, "view": view_id, "area": label,
                                    "status": "OK", "detail": "", "pass": pass_name})
                    continue
                if idle and pass_name == "render":
                    print("   IDLE  %-28s rows=0  (awaits a selection)" % label)
                    results.append({"region": region, "view": view_id, "area": label,
                                    "status": "SELECTION_IDLE", "detail": "",
                                    "pass": pass_name})
                    continue
                allowed = spec.get("expect") in ("may_be_empty", "needs_generated_dataset")
                regions_ok = spec.get("regions")
                if regions_ok and region not in regions_ok:
                    allowed = False
                if allowed:
                    print("   BY-DESIGN %-24s rows=0  (%s)"
                          % (label, spec.get("reason", "declared")))
                    results.append({"region": region, "view": view_id, "area": label,
                                    "status": "BY_DESIGN",
                                    "detail": spec.get("reason", ""), "pass": pass_name})
                else:
                    print("   EMPTY %-28s rows=0" % label)
                    results.append({"region": region, "view": view_id, "area": label,
                                    "status": "EMPTY",
                                    "detail": "undeclared empty result", "pass": pass_name})


def run_code_views(sess, exp, results):
    """Code-registered views (vrp_simulator, emergency_response, backload_*,
    ops_console) hold their SQL in TypeScript, so the harness cannot enumerate
    their queries without parsing TS. Instead it asserts every object they read
    is present AND selectable, which is honest about what it covers and still
    catches the two classes that actually break them: an object no install step
    created, and a `SELECT *` view invalidated by an ADD COLUMN on its base.
    """
    code = exp.get("code_views") or {}
    if not code:
        return
    print("\n################ code-registered views (object reachability)")
    for view_id, spec in code.items():
        print("\n=== %s" % view_id)
        for obj in spec.get("objects") or []:
            rows, err = sess.rows("SELECT * FROM %s LIMIT 1" % obj)
            if err:
                print("   ERROR %-52s %s" % (obj, err[:90]))
                results.append({"region": "*", "view": view_id, "area": obj,
                                "status": "ERROR", "detail": err})
            elif rows:
                print("   OK    %-52s rows>=1" % obj)
                results.append({"region": "*", "view": view_id, "area": obj,
                                "status": "OK", "detail": ""})
            else:
                allowed = spec.get("expect") in ("may_be_empty", "needs_generated_dataset")
                status = "BY_DESIGN" if allowed else "EMPTY"
                print("   %-9s %-52s rows=0" % (status, obj))
                results.append({"region": "*", "view": view_id, "area": obj,
                                "status": status, "detail": spec.get("reason", "")})


def repair(sess, connection, results, datasets):
    """Re-run the artifact that owns each failing object. Idempotent by design:
    every target is a CALL to a builder proc or a CREATE OR REPLACE script the
    installer already runs, so repair never invents DDL of its own.
    """
    broken = {r["view"] + "|" + r["area"] for r in results
              if r["status"] in ("ERROR", "EMPTY", "FILTER_EMPTY")}
    if not broken:
        print("\nrepair: nothing to do")
        return []
    blobs = " ".join(broken).upper()
    region = datasets[0][0] if datasets else None
    done = []
    for prefix, name, action in REPAIR_MAP:
        # Match on the failing area labels AND on the detail text, since an
        # object name usually appears in the error rather than the label.
        details = " ".join(r["detail"] for r in results
                           if r["status"] in ("ERROR", "EMPTY", "FILTER_EMPTY")).upper()
        if prefix.upper() not in blobs and prefix.upper() not in details:
            continue
        if action.startswith("@PACK:"):
            pack = action.split(":", 1)[1]
            path = (SKILL / "fleet_sa_app" / "app" / "packs" / "fleet" / pack
                    / "setup.sql")
            print("\nrepair[%s]: %s" % (name, path.name))
            rc = subprocess.run(["snow", "sql", "-c", connection, "-f", str(path)],
                                capture_output=True, text=True, timeout=1800)
            ok = rc.returncode == 0
        elif action.startswith("@FILE:"):
            rel = action.split(":", 1)[1]
            path = (pathlib.Path(__file__).resolve().parent / rel).resolve()
            print("\nrepair[%s]: %s" % (name, path.name))
            rc = subprocess.run(["snow", "sql", "-c", connection, "-f", str(path)],
                                capture_output=True, text=True, timeout=3600)
            ok = rc.returncode == 0
        else:
            stmt = action.format(region=region or "")
            print("\nrepair[%s]: %s" % (name, stmt))
            _, err = sess.rows(stmt)
            ok = err is None
            if err:
                print("   %s" % err[:160])
        print("   %s" % ("OK" if ok else "FAILED"))
        done.append((name, ok))
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--connection", default="fleet_test_evals")
    ap.add_argument("--view", action="append", default=[],
                    help="restrict to one or more view ids")
    ap.add_argument("--repair", action="store_true",
                    help="re-run the artifact owning each failure, then revalidate")
    ap.add_argument("--report", default=None, help="write a JSON report here")
    ap.add_argument("--list", action="store_true", help="list views and exit")
    args = ap.parse_args()

    views = json.loads(APP_VIEWS.read_text())
    cfg = json.loads(APP_CONFIG.read_text()).get("contextBar") or []
    exp = yaml.safe_load(EXPECTATIONS.read_text()) if EXPECTATIONS.exists() else {}

    if args.list:
        for vid, v in views.items():
            print("%-32s queries=%d" % (vid, len(collect_query_nodes(v))))
        for vid in (exp.get("code_views") or {}):
            print("%-32s (code-registered)" % vid)
        return 0

    sess = Session(args.connection)
    try:
        rows, err = sess.rows(
            "SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS "
            "WHERE IS_ACTIVE ORDER BY REGION")
        if err:
            print("ERROR resolving active datasets: %s" % err, file=sys.stderr)
            return 2
        datasets = [(r["REGION"], r["VEHICLE_TYPE"]) for r in rows]
        if not datasets:
            print("ERROR: no active dataset in DIM_DATASETS", file=sys.stderr)
            return 2

        results: list[dict] = []
        run_config_views(sess, views, cfg, exp, datasets, set(args.view), results,
                         pass_name="render")
        run_config_views(sess, views, cfg, exp, datasets, set(args.view), results,
                         pass_name="selection")
        if not args.view:
            run_code_views(sess, exp, results)

        if args.repair:
            repair(sess, args.connection, results, datasets)
            print("\n################ revalidating after repair")
            results = []
            run_config_views(sess, views, cfg, exp, datasets, set(args.view), results,
                             pass_name="render")
            run_config_views(sess, views, cfg, exp, datasets, set(args.view), results,
                             pass_name="selection")
            if not args.view:
                run_code_views(sess, exp, results)

        tally: dict[str, int] = {}
        for r in results:
            tally[r["status"]] = tally.get(r["status"], 0) + 1
        print("\n" + "=" * 60)
        print("  ".join("%s=%d" % (k, tally[k]) for k in sorted(tally)))

        if args.report:
            pathlib.Path(args.report).write_text(json.dumps(results, indent=1))
            print("report -> %s" % args.report)

        hard = [r for r in results
                if r["status"] in ("ERROR", "EMPTY", "UNMODELLED_BIND", "FILTER_EMPTY")]
        if hard:
            print("\nFAILED: %d issue(s)" % len(hard))
            for r in hard[:40]:
                print("  [%s] %s / %s -> %s (%s)"
                      % (r["region"], r["view"], r["area"], r["status"],
                         r["detail"][:100]))
            if len(hard) > 40:
                print("  ... %d more (see --report)" % (len(hard) - 40))
            return 1
        print("\nPASSED: every area returned rows or is declared empty")
        return 0
    finally:
        sess.close()


if __name__ == "__main__":
    sys.exit(main())
