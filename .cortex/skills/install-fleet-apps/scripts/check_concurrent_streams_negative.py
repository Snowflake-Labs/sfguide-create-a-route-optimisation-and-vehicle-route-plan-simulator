#!/usr/bin/env python3
"""Negative tests for check_concurrent_streams.py.

A gate that has never been seen to FAIL is documentation, not a gate. This
driver re-introduces each defect the gate exists to catch and asserts the gate
convicts it - and, just as importantly, that the gate reports the RIGHT cause.

Mutations are applied to a TEMP COPY of the tree (the gate honours
CONCURRENT_STREAMS_REPO), never to the checkout: an in-place driver that dies
half-way leaves the repo broken.

Every mutation is asserted to CHANGE the file. A mutation whose anchor has
drifted would otherwise silently apply nothing and "pass", which is the same
false-pass shape the positive gate's vacuity counter guards against.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[4]
GATE = pathlib.Path(__file__).resolve().parent / "check_concurrent_streams.py"

REL = {
    "dsv": ".cortex/skills/install-fleet-apps/scripts/delivery_sync_layer.sql",
    "live": ".cortex/skills/install-fleet-apps/scripts/analytic_layer_live_routing.sql",
    "views": ".cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json",
    "engine": (".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server"
               "/studio/engine.ts"),
}


def make_tree() -> pathlib.Path:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="cs-neg-"))
    for rel in REL.values():
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dst)
    return tmp


def run_gate(tree: pathlib.Path):
    env = dict(os.environ, CONCURRENT_STREAMS_REPO=str(tree))
    p = subprocess.run([sys.executable, str(GATE)], capture_output=True,
                       text=True, env=env, timeout=120)
    return p.returncode, p.stdout + p.stderr


def edit(tree: pathlib.Path, which: str, old: str, new: str) -> None:
    p = tree / REL[which]
    t = p.read_text()
    if old not in t:
        raise AssertionError(
            "mutation anchor not found in %s: %r" % (which, old[:80]))
    p.write_text(t.replace(old, new, 1))


def edit_json(tree: pathlib.Path, fn) -> None:
    p = tree / REL["views"]
    spec = json.loads(p.read_text())
    fn(spec)
    p.write_text(json.dumps(spec, indent=2))


def veh_layer(spec):
    m = spec["delivery_sync"]["areas"]["map"]["config"]
    return [l for l in m["layers"] if l.get("id") == "vehicles"][0]


# (name, mutate, expected rule token) ---------------------------------------
MUTATIONS = []


def mut(name, token):
    def deco(fn):
        MUTATIONS.append((name, fn, token))
        return fn
    return deco


@mut("M1 detector stops excluding the trip-less IDLE heartbeat", "RULE A")
def m1(tree):
    edit(tree, "dsv",
         "  WHERE NOT (t.TRIP_ID IS NULL AND t.STATUS = 'IDLE')\n", "")


@mut("M2 detector widens the exclusion to ALL trip-less pings", "RULE A")
def m2(tree):
    edit(tree, "dsv",
         "  WHERE NOT (t.TRIP_ID IS NULL AND t.STATUS = 'IDLE')",
         "  WHERE t.TRIP_ID IS NOT NULL")


@mut("M3 EXIT_TS loses the implied-speed gate", "RULE B")
def m3(tree):
    p = tree / REL["dsv"]
    t = p.read_text()
    start = t.index("      AND ST_DISTANCE(x.POINT_GEOM,")
    end = t.index("<= prm.MAX_IMPLIED_SPEED_KMH,") + len(
        "<= prm.MAX_IMPLIED_SPEED_KMH,")
    p.write_text(t[:start] + t[end:])


@mut("M4 EXIT_TS loses the time bound", "RULE B")
def m4(tree):
    edit(tree, "dsv",
         " AND DATEDIFF('second', a.FENCE_EXIT_TS, x.TS) BETWEEN 0 AND prm.EXIT_MAX_GAP_SECONDS",
         "")


@mut("M5 implied speed measured from the SITE CENTROID, not the last in-fence ping",
     "RULE B")
def m5(tree):
    edit(tree, "dsv",
         "ST_MAKEPOINT(a.EXIT_FROM_LON, a.EXIT_FROM_LAT)",
         "a.SITE_GEOG")


@mut("M6 implied speed drops to second resolution", "RULE B")
def m6(tree):
    edit(tree, "dsv",
         "GREATEST(DATEDIFF('millisecond', a.EXIT_FROM_TS, x.TS), 250) / 3600000.0",
         "GREATEST(DATEDIFF('second', a.EXIT_FROM_TS, x.TS), 1) / 3600.0")


@mut("M7 LIVE_FLEET_STATUS reverts to plain recency", "RULE C")
def m7(tree):
    edit(tree, "live",
         """    QUALIFY ROW_NUMBER() OVER (
              PARTITION BY VEHICLE_ID
              ORDER BY IFF(TRIP_ID IS NULL AND STATUS = 'IDLE', 1, 0), TS DESC) = 1
  ),
  -- The monitored-site set""",
         """    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TS DESC) = 1
  ),
  -- The monitored-site set""")


@mut("M8 LIVE_INBOUND_ETA reverts to plain recency", "RULE C")
def m8(tree):
    edit(tree, "live",
         """    QUALIFY ROW_NUMBER() OVER (
              PARTITION BY VEHICLE_ID
              ORDER BY IFF(TRIP_ID IS NULL AND STATUS = 'IDLE', 1, 0), TS DESC) = 1
  ),
  ordered AS (""",
         """    QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TS DESC) = 1
  ),
  ordered AS (""")


@mut("M9 last_pos EXCLUDES the heartbeat instead of outranking it", "RULE C")
def m9(tree):
    edit(tree, "live",
         """    WHERE REGION = P_REGION
      AND TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      AND TS >= DATEADD('minute', -1 * COALESCE(P_MAX_STALENESS_MIN, 20),""",
         """    WHERE REGION = P_REGION
      AND NOT (TRIP_ID IS NULL AND STATUS = 'IDLE')
      AND TS <= COALESCE(P_AS_OF, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      AND TS >= DATEADD('minute', -1 * COALESCE(P_MAX_STALENESS_MIN, 20),""")


@mut("M10 vehicles layer reverts to a CategoricalColor palette", "RULE D")
def m10(tree):
    def f(spec):
        v = veh_layer(spec)
        pal = v["fillColor"]["basePalette"]
        v["fillColor"] = {"column": "status", "palette": pal,
                          "default": [41, 181, 232, 240]}
    edit_json(tree, f)


@mut("M11 highlight added BESIDE a palette (the silent dead-code shape)", "RULE D")
def m11(tree):
    def f(spec):
        v = veh_layer(spec)
        fc = v["fillColor"]
        fc["palette"] = fc["basePalette"]
        fc["column"] = "status"
    edit_json(tree, f)


@mut("M12 highlight keeps selection but loses the status palette", "RULE D")
def m12(tree):
    def f(spec):
        v = veh_layer(spec)
        v["fillColor"].pop("baseColumn", None)
        v["fillColor"].pop("basePalette", None)
    edit_json(tree, f)


@mut("M13 focusOn loses its per-row key", "RULE E")
def m13(tree):
    def f(spec):
        spec["delivery_sync"]["areas"]["map"]["config"]["focusOn"].pop("keyKey")
    edit_json(tree, f)


@mut("M14 the feed stops emitting the focus key", "RULE E")
def m14(tree):
    def f(spec):
        spec["delivery_sync"]["areas"]["feed"]["emits"].pop("map_focus_key")
    edit_json(tree, f)


@mut("M15 generator reserves day spill BEFORE the post-loop legs", "RULE F1")
def m15(tree):
    p = tree / REL["engine"]
    t = p.read_text()
    block = """    const daysConsumed = Math.floor(
      (lifecycle.currentTime.getTime() - dayStartMidnight) / 86400000,
    );
    if (daysConsumed > 0) {
      busyUntilDayOffset = dayOffset + daysConsumed;
    }
"""
    if block not in t:
        raise AssertionError("M15 anchor drifted")
    t = t.replace(block, "")
    anchor = "    const idleDwell = config.dwell.idle;"
    t = t.replace(anchor, block + "\n" + anchor, 1)
    p.write_text(t)


@mut("M16 generator reads the shift clock in container-local time", "RULE F2")
def m16(tree):
    edit(tree, "engine",
         "lifecycle.currentTime.getUTCHours() + (lifecycle.currentTime.getUTCHours()",
         "lifecycle.currentTime.getHours() + (lifecycle.currentTime.getHours()")


@mut("M17 end-of-day idle loses its clamp", "RULE F3")
def m17(tree):
    p = tree / REL["engine"]
    t = p.read_text()
    start = t.index("    const idleDwell = config.dwell.idle;")
    end = t.index("    const daysConsumed = Math.floor(", start)
    p.write_text(t[:start] + """    const idleDwell = config.dwell.idle;
    if (idleDwell && 'median_min' in idleDwell) {
      points.push(...emitDwell(lifecycle, config, null, idleDwell as DwellConfig, 'IDLE', currentOriginPoi, memberRng));
    }

""" + t[end:])


@mut("M18 clamp keeps max_min but leaves the long-wait tail free", "RULE F3")
def m18(tree):
    edit(tree, "engine", "          long_wait_probability: undefined,\n", "")


@mut("M19 ghost block runs before the day-spill guard", "RULE F4")
def m19(tree):
    p = tree / REL["engine"]
    t = p.read_text()
    guard_start = t.index("    if ((busyUntil.get(member.vehicle_id) ?? -1) >= dayOffset) {")
    guard_end = t.index("    // Ghost trailer handling", guard_start)
    guard = t[guard_start:guard_end]
    ghost_end = t.index("    const operatingRate = config.fleet.daily_operating_rate")
    body = t[guard_end:ghost_end]
    p.write_text(t[:guard_start] + body + guard + t[ghost_end:])


def main() -> int:
    base = make_tree()
    try:
        rc, out = run_gate(base)
        if rc != 0:
            print("FAIL: the gate does not pass on the UNMUTATED tree, so no "
                  "negative result below would mean anything:\n%s" % out)
            return 1
    finally:
        shutil.rmtree(base, ignore_errors=True)

    bad = []
    for name, fn, token in MUTATIONS:
        tree = make_tree()
        try:
            try:
                fn(tree)
            except AssertionError as e:
                bad.append("%s -> mutation could not be applied: %s" % (name, e))
                continue
            rc, out = run_gate(tree)
            if rc == 0:
                bad.append("%s -> gate PASSED (should have failed)" % name)
            elif token not in out:
                bad.append("%s -> gate failed but never named %s, so it "
                           "reported the wrong cause:\n%s" % (name, token, out))
            else:
                print("  convicted: %s (%s)" % (name, token))
        finally:
            shutil.rmtree(tree, ignore_errors=True)

    if bad:
        print("\nFAIL: %d negative test(s) did not behave:" % len(bad))
        for b in bad:
            print("  - %s" % b)
        return 1
    print("\nOK: %d mutations all convicted with the right cause"
          % len(MUTATIONS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
