#!/usr/bin/env python3
"""Negative tests for check_ors_raise.py - each case re-creates a way a
live-routing view goes blank on a suspended engine instead of raising, or rots
the documented degrader list, and the gate must name the view or the entry."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
LIVE = f"{SKILL}/scripts/analytic_layer_live_routing.sql"
STARTER = f"{SKILL}/fleet_sa_app/app/starter/app-views.json"

h = Harness("check_ors_raise.py")


def multi(name: str, rel: str, pairs: list[tuple[str, str, str]], expect: str) -> None:
    """Several anchored replacements in one file, applied as ONE case. Each is
    (after, old, new): `old` is replaced at its first occurrence AFTER `after`,
    because the guard text is identical across many LIVE_* bodies."""
    p = h.path(rel)
    original = p.read_text()

    def apply():
        text = original
        for after, old, new in pairs:
            start = text.find(after)
            assert start >= 0, f"scope anchor not found in {rel}: {after[:80]!r}"
            at = text.find(old, start)
            assert at >= 0, f"anchor not found after {after[:60]!r}: {old[:80]!r}"
            text = text[:at] + new + text[at + len(old):]
        assert text != original, f"mutation leaves {rel} unchanged"
        p.write_text(text)

    h.custom(name, apply, lambda: p.write_text(original), expect)


GUARD = ("      -- ORS_FEATURES = the suspended-engine guard: raises instead of yielding\n"
         "      -- zero rows when the region's ORS service is down (see FLEET_APP.CORE).\n"
         "      LATERAL FLATTEN(input => FLEET_APP.CORE.ORS_FEATURES(resp.RESPONSE)) f\n")
UNGUARDED = "      LATERAL FLATTEN(input => resp.RESPONSE:features) f\n"

# A LIVE_* body that filters the suspended-engine NULL away: both catchment
# functions FLATTEN the raw features array, so a down engine yields zero rows.
multi("unguarded LIVE_* bodies: catchment view renders blank", LIVE, [
    ("FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT(", GUARD, UNGUARDED),
    ("FUNCTION FLEET_APP.CATCHMENT.LIVE_CATCHMENT_CATEGORIES(", GUARD, UNGUARDED),
], expect="view 'catchment' calls live routing")

# The historical delivery-sync defect: the approach ring returned GEOJSON as-is
# (NULL on a suspended engine, dropped by the layer compiler) and the ETA cast a
# missing durations array to NULL. Both hand-rolled raises reverted.
multi("hand-rolled raises reverted: delivery_sync map goes blank", LIVE, [
    ("FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_APPROACH_RING(",
     "           ELSE TO_GEOGRAPHY('ORS ' || COALESCE(r.RESPONSE:error::STRING, 'service_unreachable')\n"
     "                             || ' host=' || COALESCE(r.RESPONSE:ors_host::STRING, '?'))\n",
     "           ELSE NULL\n"),
    ("FUNCTION FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_INBOUND_ETA(",
     "      ELSE TO_NUMBER('ORS ' || COALESCE(m.R:error::STRING, 'service_unreachable')\n"
     "                     || ' host=' || COALESCE(m.R:ors_host::STRING, '?'))\n",
     "      ELSE NULL\n"),
], expect="view 'delivery_sync' calls live routing")

# A new view calling the engine directly and filtering the NULL geometry away.
starter = h.path(STARTER)
starter_original = starter.read_text()


def add_unguarded_view():
    views = json.loads(starter_original)
    views["negtest_ors"] = {
        "label": "Negtest",
        "areas": {"map": {"data": {"query": (
            "SELECT GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES("
            "'driving-car', ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.4, 37.8)), "
            "ARRAY_CONSTRUCT(10), 'time', :region)) WHERE GEOJSON IS NOT NULL")}}},
    }
    starter.write_text(json.dumps(views, indent=2))


h.custom("new view calls ISOCHRONES directly with no guard", add_unguarded_view,
         lambda: starter.write_text(starter_original),
         expect="view 'negtest_ors' calls live routing")

# Documented asymmetry rots: a degrader quietly gains a guard ...
h.replace(LIVE,
          "  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(\n"
          "    P_REGION, P_PROFILE, P_AS_OF, P_APPROACH_MIN, P_JUST_LEFT_MIN, P_MAX_STALENESS_MIN))\n",
          "  SELECT * FROM TABLE(FLEET_INTELLIGENCE.DELIVERY_SYNC.LIVE_FLEET_STATUS(\n"
          "    P_REGION, P_PROFILE, P_AS_OF, P_APPROACH_MIN, P_JUST_LEFT_MIN, P_MAX_STALENESS_MIN))\n"
          "  WHERE FLEET_APP.CORE.ORS_OK(NULL)\n",
          expect="LIVE_FLEET_STATUS now raises but is still listed in KNOWN_DEGRADERS",
          name="degrader acquires a guard but stays listed")
# ... or is renamed away while its exemption stays behind.
h.replace(LIVE, "LIVE_APPROACH_RINGS(", "LIVE_APPROACH_RING_SET(",
          expect="KNOWN_DEGRADERS lists LIVE_APPROACH_RINGS, which no longer exists",
          name="degrader renamed away", count=-1)

# The file every LIVE_* function now lives in drops out of the scan.
h.delete(LIVE, expect="analytic_layer_live_routing.sql: missing",
         name="live-routing SQL source missing")

sys.exit(h.finish())
