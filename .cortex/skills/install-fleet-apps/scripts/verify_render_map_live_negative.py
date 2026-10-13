#!/usr/bin/env python3
"""Negative tests for verify_render_map_live.sh (live gate), replayed offline
from live_cassettes/render_map_live.json, recorded against the deployed verb.

The probe has two directions and both must be able to fail:
  * a NEGATIVE spec the verb ACCEPTS (a validation regression) - every invalid
    spec must still be rejected with its own code
  * the POSITIVE spec REJECTED - the live-routing layer the agent specs promise.
    This is the defect the probe caught on 2026-10-12, once it was registered:
    render_map's compile check bound params as untyped NULL, so the valid
    DIRECTIONS(:profile, ..., :region, ...) layer was refused.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
h = Harness("verify_render_map_live.sh", args=["replayed"],
            cassette=f"{S}/live_cassettes/render_map_live.json")
OK = {"rc": 0, "stdout": "+--------+\n| RENDER_MAP |\n|--------|\n| {\"ok\": true} |\n", "stderr": ""}
# The request keys hold only the SQL file's hash, so cases are matched on the
# file CONTENT the script writes: each spec is embedded in its own -f file.
import hashlib, json  # noqa: E402,E401
TAG = ('{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,'
       '"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}')


def key_for(spec: str) -> str:
    sql = (f"ALTER SESSION SET query_tag = '{TAG}';\n"
           f"CALL OPENROUTESERVICE_APP.ROUTING.RENDER_MAP($${spec}$$, NULL, NULL);\n")
    return "sha256:" + hashlib.sha256(sql.encode()).hexdigest()


src = (h.root / S / "verify_render_map_live.sh").read_text()
specs = {ln.split()[1]: ln.split("'", 1)[1].rsplit("'", 1)[0]
         for ln in src.splitlines() if ln.startswith(("run ", "accept ")) and "'" in ln}
assert {"BAD_TYPE", "TOOMANY", "LIVE_ORS"} <= specs.keys(), sorted(specs)
tape = json.loads((h.root / S / "live_cassettes/render_map_live.json").read_text())
for name in ("BAD_TYPE", "TOOMANY", "LIVE_ORS"):
    assert any(key_for(specs[name]) in k for k in tape), f"{name}: key derivation drifted"

h.account("an unknown layer type is ACCEPTED (validation regression)",
          [{"match": key_for(specs["BAD_TYPE"]), **OK}], expect="BAD_TYPE   ACCEPTED")
h.account("a five-layer spec is ACCEPTED (layer cap lost)",
          [{"match": key_for(specs["TOOMANY"]), **OK}], expect="TOOMANY    ACCEPTED")
h.account("a spec rejected with the WRONG code",
          [{"match": key_for(specs["BAD_TYPE"]), "rc": 1, "stdout": "",
            "stderr": "INVALID_MAP_SPEC_SHAPE: layer 0 is not an object"}],
          expect="(expected UNKNOWN_LAYER_TYPE)")
h.account("the valid live-routing layer is REJECTED (the 2026-10-12 defect)",
          [{"match": key_for(specs["LIVE_ORS"]), "rc": 1, "stdout": "",
            "stderr": "SynapseError: INVALID_MAP_SPEC_SQL: layer 0 data.query does not compile: "
                      "Invalid argument types for function 'ROUTING_PLATFORM.CONTRACT.DIRECTIONS': "
                      "(NULL, VARIANT, NULL, VARIANT)"}],
          expect="LIVE_ORS   REJECTED")
sys.exit(h.finish())
