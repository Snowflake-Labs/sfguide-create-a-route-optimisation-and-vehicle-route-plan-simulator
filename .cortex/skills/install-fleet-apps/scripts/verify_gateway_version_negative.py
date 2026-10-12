#!/usr/bin/env python3
"""Negative tests for the live gate verify_gateway_version.sh, replayed offline
from live_cassettes/gateway_version.json. SPCS keeps serving a node-cached image
for an unchanged tag, so the RUNNING gateway build must be the tag the spec
names. The tag is read from image-versions.env, not hardcoded, so this test does
not break on the next gateway release (re-record with record_live_cassettes.sh)."""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
ERR = {"rc": 1, "stdout": "", "stderr": "000904 (42000): SQL compilation error: invalid identifier"}

h = Harness("verify_gateway_version.sh", args=["replayed"],
            cassette=f"{S}/live_cassettes/gateway_version.json")
env = (h.root / ".cortex/skills/install-fleet-apps/openrouteservice_app/image-versions.env").read_text()
TAG = re.search(r"^ROUTING_REVERSE_PROXY_TAG=(\S+)", env, re.M).group(1).strip("\"'")
h.account("SPCS kept serving a stale cached image (version mismatch)",
          [{"match": "gateway_version::string",
            "replace": [[f'"{TAG}"', f'"{TAG}-stale"']]}],
          expect="!= expected")
h.account("the running gateway does not report a version",
          [{"match": "gateway_version::string", "replace": [[f'"{TAG}"', "null"]]}],
          expect="could not read ORS_STATUS")
h.account("ORS_STATUS cannot be called",
          [{"match": "gateway_version::string", **ERR}], expect="could not read ORS_STATUS")
sys.exit(h.finish())
