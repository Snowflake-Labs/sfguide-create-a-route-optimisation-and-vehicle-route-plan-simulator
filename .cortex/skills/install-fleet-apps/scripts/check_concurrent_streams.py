#!/usr/bin/env python3
"""Gate: a vehicle's telemetry may carry TWO CONCURRENT POSITION STREAMS, and
every consumer that assumes one must keep its guard.

WHAT WENT WRONG. The generator emits a trip-less IDLE heartbeat pinned at the
vehicle's HOME POI with no knowledge of whether a trip is running, and it
under-reserved day spill so two of a vehicle's own trips could run at the same
time (UsTexas: 42 strictly overlapping trip pairs / 24 vehicles / up to 1,030
minutes of true concurrency; SanFrancisco: 0, which is why none of this was
visible on the seed dataset). Downstream, on UsTexas 2026-09-03:

  - DT_SITE_VISITS' per-vehicle SEQ saw the foreign ping as a discontinuity, so
    ONE 18.4-minute dwell became three "visits" and V-DRI-00086 produced 36
    visits to a single site in one day.
  - The ping at MAX(SEQ)+1 became the EXIT_TS evidence, so the feed published
    DEPARTED for a vehicle that had not moved - 53 of 216 Texas departures had
    an exit ping over 5 km from the site, one of them four days later.
  - LIVE_FLEET_STATUS' last_pos took plain MAX(TS) and plotted the depot 520 km
    away, so ON_SITE could not match and JUST_LEFT failed its 15-minute
    back-drive gate. At 01:00 the fleet read 16 DRIVING / 73 IDLE with ZERO
    ON_SITE and ZERO JUST_LEFT - the two states the page exists to show.

WHY A GATE. Every one of those failures was SILENT. Nothing threw, no row was
missing, and every individual number was correct about the wrong ping - so the
map, the feed and the readiness table each looked internally consistent while
disagreeing with each other. A regression here does not break a build or a
test; it just quietly starts lying again.

Comments are STRIPPED before matching. A gate in this repo has twice
false-passed on the prose explaining the very trap it was meant to catch.
"""
import json
import os
import pathlib
import re
import sys

# parents[4], not [3]: this file sits at
# <repo>/.cortex/skills/install-fleet-apps/scripts/, so [0]=scripts,
# [1]=install-fleet-apps, [2]=skills, [3]=.cortex, [4]=repo. Getting this wrong
# makes every rule inspect an empty string and pass, which is why the vacuity
# counter at the bottom exists - it caught exactly this mistake here.
#
# CONCURRENT_STREAMS_REPO lets the negative-test companion point the gate at a
# TEMP COPY of the tree. Mutating the real files in place is how a driver leaves
# a repo broken when it dies half-way, so the mutations never touch the checkout.
REPO = pathlib.Path(
    os.environ.get("CONCURRENT_STREAMS_REPO")
    or pathlib.Path(__file__).resolve().parents[4]
)
SKILL = REPO / ".cortex" / "skills" / "install-fleet-apps"
SCRIPTS = SKILL / "scripts"
DSV = SCRIPTS / "delivery_sync_layer.sql"
LIVE = SCRIPTS / "analytic_layer_live_routing.sql"
VIEWGEN = SCRIPTS / "add_delivery_sync_view.py"
APPVIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"
ENGINE = (SKILL / "fleet_admin_app" / "ui" / "src" / "server" / "studio"
          / "engine.ts")

failures: list[str] = []
checked = 0


def strip_sql_comments(text: str) -> str:
    return "\n".join(re.sub(r"--.*$", "", ln) for ln in text.splitlines())


def strip_slash_comments(text: str) -> str:
    out = []
    for ln in text.splitlines():
        s = re.sub(r"//.*$", "", ln)
        out.append(s)
    text = "\n".join(out)
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def strip_hash_comments(text: str) -> str:
    return "\n".join(re.sub(r"(?<!['\"])#.*$", "", ln) for ln in text.splitlines())


def read(p: pathlib.Path, stripper) -> str:
    if not p.exists():
        failures.append("MISSING FILE: %s" % p)
        return ""
    return stripper(p.read_text())


def fail(rule: str, msg: str) -> None:
    failures.append("%s: %s" % (rule, msg))


def body_of(sql: str, create_marker: str) -> str:
    """The text of one statement, from its CREATE to the terminating `;`.

    Scoped deliberately: an unscoped whole-file search lets a predicate deleted
    from the statement that needs it pass because some OTHER statement still
    mentions the token.
    """
    i = sql.find(create_marker)
    if i < 0:
        return ""
    j = sql.find(";", i)
    return sql[i:j if j > 0 else len(sql)]


# ---------------------------------------------------------------------------
# RULE A - the detector drops the trip-less IDLE heartbeat.
# ---------------------------------------------------------------------------
dsv = read(DSV, strip_sql_comments)
if dsv:
    checked += 1
    dt = body_of(dsv, "CREATE OR REPLACE DYNAMIC TABLE "
                      "FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS")
    if not dt:
        fail("RULE A", "DT_SITE_VISITS statement not found in %s" % DSV.name)
    else:
        # Scoped to the pts CTE: the exclusion has to be on the PING SOURCE, not
        # anywhere in a 200-line query.
        m = re.search(r"\bpts AS \((.*?)\n\),", dt, re.S)
        if not m:
            fail("RULE A", "pts CTE not found in DT_SITE_VISITS")
        else:
            pts = m.group(1)
            has_excl = re.search(
                r"NOT\s*\(\s*\w*\.?TRIP_ID\s+IS\s+NULL\s+AND\s+\w*\.?STATUS\s*=\s*'IDLE'\s*\)",
                pts, re.I | re.S)
            if not has_excl:
                fail("RULE A",
                     "pts must exclude the trip-less IDLE home heartbeat with "
                     "NOT (TRIP_ID IS NULL AND STATUS = 'IDLE'). Without it one "
                     "dwell shreds into several visits and the heartbeat becomes "
                     "the DEPARTED evidence.")
            # Must NOT widen to all trip-less pings: SanFrancisco's 20,789
            # trip-less DWELL_RECHARGE pings are genuine stops behind 411 visits.
            too_wide = re.search(
                r"WHERE\s+\w*\.?TRIP_ID\s+IS\s+NOT\s+NULL", pts, re.I)
            if too_wide:
                fail("RULE A",
                     "pts must not require TRIP_ID IS NOT NULL: that drops the "
                     "trip-less DWELL_RECHARGE stops behind 411 SanFrancisco "
                     "visits. Exclude STATUS='IDLE' only.")

# ---------------------------------------------------------------------------
# RULE B - EXIT_TS carries BOTH plausibility gates, measured from the last
#          in-fence ping.
# ---------------------------------------------------------------------------
if dsv:
    checked += 1
    dt = body_of(dsv, "CREATE OR REPLACE DYNAMIC TABLE "
                      "FLEET_INTELLIGENCE.DELIVERY_SYNC.DT_SITE_VISITS")
    if dt:
        # Scoped to the exit JOIN, not the statement. Asserting the mere presence
        # of the token `EXIT_MAX_GAP_SECONDS` false-passed: it also appears in the
        # `prm` CTE's SELECT list, so deleting the predicate that USES it left the
        # rule green. Presence of a name is not presence of a guard.
        jm = re.search(r"LEFT JOIN pts x(.*?)(?=LEFT JOIN|\bWHERE\b)", dt, re.S)
        join = jm.group(1) if jm else ""
        if not join:
            fail("RULE B", "the EXIT_TS join over `pts` was not found")
        elif not re.search(
                r"DATEDIFF\(\s*'second'[^)]*\)\s*BETWEEN\s*0\s*AND\s*prm\.EXIT_MAX_GAP_SECONDS",
                join, re.I | re.S):
            fail("RULE B",
                 "the exit join must bound the candidate ping with "
                 "DATEDIFF(...) BETWEEN 0 AND prm.EXIT_MAX_GAP_SECONDS. "
                 "Unbounded, the 'next ping' was observed four days and 256 km "
                 "later (V-DRI-00084) and still published a DEPARTED event.")

        iff = dt[dt.find("IFF(x.TS IS NOT NULL"):]
        iff = iff[:iff.find("AS EXIT_TS")] if "AS EXIT_TS" in iff else iff
        if "prm.MAX_IMPLIED_SPEED_KMH" not in iff:
            fail("RULE B",
                 "EXIT_TS must be gated on MAX_IMPLIED_SPEED_KMH. This is the "
                 "gate that rejects a cross-stream ping: 434 km in 4 s implies "
                 "390,000 km/h. A distance threshold cannot do it, because a "
                 "legitimate exit may be far if the gap is long.")
        else:
            # The reference point matters as much as the ratio. Measuring from the
            # SITE centroid is wrong by up to the fence radius.
            if "EXIT_FROM_LON" not in iff or "EXIT_FROM_LAT" not in iff:
                fail("RULE B",
                     "the implied-speed test must measure from the episode's "
                     "last in-fence position (EXIT_FROM_LON/EXIT_FROM_LAT), not "
                     "the site centroid, or an ordinary exit just outside the "
                     "fence computes as hundreds of km/h and is discarded.")
            if "DATEDIFF('millisecond'" not in iff:
                fail("RULE B",
                     "the implied-speed test must use millisecond resolution: "
                     "second-granular pings floor to a divisor that turns a "
                     "normal exit into an impossible speed.")

# ---------------------------------------------------------------------------
# RULE C - every live last-position picker ranks trip pings above the heartbeat.
# ---------------------------------------------------------------------------
live = read(LIVE, strip_sql_comments)


def cte_blocks(sql: str):
    """Yield (name, body) for every `name AS ( ... )` CTE, paren-balanced.

    Needed because the naive regex for a per-vehicle QUALIFY also matches the
    VISIT pickers over DT_SITE_VISITS (on_site ORDER BY PREF, just_left ORDER BY
    DEPARTURE_TS, next_site ORDER BY ARRIVAL_TS). Those rank rows of a already-
    detected visit, not raw pings, and the heartbeat rule is meaningless for
    them - so an unscoped rule reported three failures with the wrong cause.
    """
    for m in re.finditer(r"\b(\w+)\s+AS\s*\(", sql):
        name = m.group(1)
        i = m.end() - 1
        depth = 0
        for j in range(i, len(sql)):
            if sql[j] == "(":
                depth += 1
            elif sql[j] == ")":
                depth -= 1
                if depth == 0:
                    yield name, sql[i + 1:j]
                    break


if live:
    checked += 1
    # A PING picker is a CTE that reads the raw telemetry view AND collapses it to
    # one row per vehicle. That is exactly the set this rule governs.
    ping_pickers = [
        (n, b) for n, b in cte_blocks(live)
        if "V_FACT_VEHICLE_TELEMETRY_CURRENT" in b
        and re.search(r"QUALIFY ROW_NUMBER\(\) OVER \(\s*PARTITION BY VEHICLE_ID",
                      b, re.S)
    ]
    if not ping_pickers:
        fail("RULE C",
             "no per-vehicle last-position picker over "
             "V_FACT_VEHICLE_TELEMETRY_CURRENT found in %s - the rule cannot be "
             "vacuously satisfied" % LIVE.name)
    for name, body in ping_pickers:
        q = re.search(
            r"QUALIFY ROW_NUMBER\(\) OVER \(\s*PARTITION BY VEHICLE_ID(.*?)\)\s*=\s*1",
            body, re.S)
        order = q.group(1) if q else ""
        if "TRIP_ID IS NULL" not in order or "IDLE" not in order:
            fail("RULE C",
                 "CTE '%s' picks the latest ping by recency alone:\n    %s\n"
                 "  It must rank trip pings above the trip-less IDLE heartbeat "
                 "(ORDER BY IFF(TRIP_ID IS NULL AND STATUS = 'IDLE', 1, 0), "
                 "TS DESC), or the map plots the depot while the vehicle is on "
                 "site and both ON_SITE and JUST_LEFT become unreachable."
                 % (name, " ".join(order.split())))
        # The heartbeat must remain a FALLBACK, never be filtered out here: a
        # vehicle parked at base all day has nothing else and would vanish.
        if re.search(r"NOT\s*\(\s*\w*\.?TRIP_ID\s+IS\s+NULL", body, re.I):
            fail("RULE C",
                 "CTE '%s' EXCLUDES the heartbeat instead of outranking it. A "
                 "vehicle parked at base has no other ping and would disappear "
                 "from the vehicles layer instead of drawing as IDLE at its "
                 "depot." % name)

# ---------------------------------------------------------------------------
# RULE D - the vehicles layer highlights the selected vehicle AND keeps status.
# ---------------------------------------------------------------------------
if APPVIEWS.exists():
    checked += 1
    spec = json.loads(APPVIEWS.read_text())
    ds = spec.get("delivery_sync")
    if not ds:
        fail("RULE D", "delivery_sync view missing from app-views.json")
    else:
        mapcfg = ds["areas"]["map"]["config"]
        veh = [l for l in mapcfg.get("layers", []) if l.get("id") == "vehicles"]
        if not veh:
            fail("RULE D", "vehicles layer missing from the delivery_sync map")
        else:
            fc = veh[0].get("fillColor")
            if not isinstance(fc, dict):
                fail("RULE D", "vehicles fillColor must be a colour object")
            else:
                if "palette" in fc:
                    fail("RULE D",
                         "vehicles fillColor carries `palette`, so colorAccessor "
                         "takes the CategoricalColor branch first and the "
                         "selection highlight is dead code. The status palette "
                         "must ride in as baseColumn + basePalette.")
                if fc.get("whenViewStateEquals") != "selected_vehicle":
                    fail("RULE D",
                         "vehicles fillColor must highlight on selected_vehicle. "
                         "All three tables already emit that key and nothing "
                         "consumed it, so a row click named a vehicle the reader "
                         "had to find by hovering ~90 identical dots.")
                if fc.get("matchColumn") != "vehicle_id":
                    fail("RULE D",
                         "vehicles fillColor.matchColumn must be vehicle_id")
                if not fc.get("baseColumn") or not fc.get("basePalette"):
                    fail("RULE D",
                         "vehicles fillColor must keep baseColumn + basePalette. "
                         "Without them every UNSELECTED vehicle flattens to one "
                         "blue and the whole status legend is lost - trading one "
                         "missing affordance for a worse one.")

# ---------------------------------------------------------------------------
# RULE E - a row click is a distinct focus gesture per row.
# ---------------------------------------------------------------------------
if APPVIEWS.exists():
    checked += 1
    spec = json.loads(APPVIEWS.read_text())
    ds = spec.get("delivery_sync") or {}
    if ds:
        focus = ds["areas"]["map"]["config"].get("focusOn") or {}
        if not focus.get("keyKey"):
            fail("RULE E",
                 "map focusOn must set keyKey. MapView de-dupes on the focus "
                 "signature, and all three events of one visit focus that "
                 "visit's SITE - one coordinate - so without a per-row key only "
                 "the first click of a site moved the camera.")
        for area in ("feed", "readiness", "inbound"):
            emits = (ds["areas"].get(area) or {}).get("emits") or {}
            if not emits.get("map_focus_key"):
                fail("RULE E",
                     "area '%s' must emit map_focus_key, or clicking its rows "
                     "cannot re-focus the camera." % area)

# ---------------------------------------------------------------------------
# RULE F - the generator cannot manufacture a concurrent stream.
# ---------------------------------------------------------------------------
eng = read(ENGINE, strip_slash_comments)
if eng:
    checked += 1
    # F1: the day-spill reservation is computed AFTER every time-advancing
    #     emission, not inside the trip loop before them.
    res = eng.find("busyUntilDayOffset = dayOffset + daysConsumed")
    idle = eng.find("'IDLE', currentOriginPoi")
    empty_leg = eng.find("emitEmptyLeg(member.home_poi)")
    if res < 0:
        fail("RULE F1", "the busyUntil day-spill reservation is gone entirely")
    elif idle < 0 or empty_leg < 0:
        fail("RULE F1",
             "could not locate the post-loop return-to-base leg and end-of-day "
             "idle; the ordering assertion cannot be evaluated")
    elif res < idle or res < empty_leg:
        fail("RULE F1",
             "the day-spill reservation is computed BEFORE the return-to-base "
             "leg and/or the end-of-day idle. Both advance the clock and the "
             "empty leg writes a trip row that can cross midnight, so "
             "reserving first under-reserves and the next vehicle-day runs "
             "concurrently with them - 42 overlapping trip pairs on UsTexas.")

    # F2: the shift-end test must read the clock in the same zone it was built in.
    if "getHours()" in eng:
        fail("RULE F2",
             "engine.ts uses getHours() (container-local) while the lifecycle "
             "clock is built with Date.UTC(...). On a non-UTC host the shift-end "
             "break fires at the wrong wall-clock hour and the day overruns "
             "further than the roster allows. Use getUTCHours().")

    # F3: the end-of-day idle heartbeat is bounded by the next shift start.
    if "nextShiftStartMs" not in eng or "budgetMin" not in eng:
        fail("RULE F3",
             "the end-of-day IDLE dwell must be clamped to the next shift "
             "start. Unbounded (its lognormal tail can double past max_min) it "
             "runs into the next shift and interleaves home-pinned pings into "
             "an active dwell.")
    else:
        seg = eng[eng.find("nextShiftStartMs"):]
        seg = seg[:2000]
        if "long_wait_probability" not in seg:
            fail("RULE F3",
                 "the clamped idle config must neutralise "
                 "long_wait_probability: emitDwell can redraw the duration as "
                 "rngFloat(max_min, max_min * 2), which overruns any cap "
                 "expressed only through max_min.")

    # F4: the ghost block must not be laid over a spillover day.
    ghost = eng.find("inGhostWindow")
    busy = eng.find("busyUntil.get(member.vehicle_id)")
    if ghost < 0 or busy < 0:
        fail("RULE F4", "could not locate the ghost branch or the busyUntil "
                        "guard; the ordering assertion cannot be evaluated")
    elif ghost < busy:
        fail("RULE F4",
             "the ghost-trailer branch runs BEFORE the busyUntil guard. It "
             "emits a midnight-anchored multi-day block of home-pinned IDLE "
             "pings regardless of state, so on a day the previous one spilled "
             "into, it lays that block over the tail of a still-active trip - "
             "manufacturing the exact artifact the reservation prevents.")

# ---------------------------------------------------------------------------
if checked < 6:
    print("FAIL: only %d of 6 rule groups could be evaluated - the gate is "
          "partly vacuous, which is worse than absent." % checked)
    for f in failures:
        print("  - %s" % f)
    sys.exit(1)

if failures:
    print("FAIL: concurrent-stream gate (%d issue(s))" % len(failures))
    for f in failures:
        print("  - %s" % f)
    sys.exit(1)

print("OK: concurrent-stream gate - %d rule groups checked" % checked)
