#!/usr/bin/env python3
"""Negative tests for check_image_versions.sh - each case makes one consumer of
image-versions.env disagree with it, and the gate must name the consumer and the
image:tag pair.

The defect class: SPCS serves images by tag and never re-pulls an unchanged tag,
so a tag bumped in one place and not the others either deploys the OLD container
or a spec that points at an image that was never pushed. GATEWAY_VERSION must
also equal ROUTING_REVERSE_PROXY_TAG, or the stale-image probe compares against
a lie."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
ENV = f"{SK}/image-versions.env"
SVC = f"{SK}/openrouteservice_app/services"
MOD = f"{SK}/openrouteservice_app/app/modules/03_region_management.sql"
BUILD = f"{SK}/references/build-images.md"
GUIDE = f"{SK}/references/snowflake-scripting-guidelines.md"
GW = f"{SVC}/gateway/routing_service.py"
MANIFEST = f"{SK}/openrouteservice_app/app/manifest.yml"
PAIRS = ["openrouteservice:v9.10.0", "downloader:v0.0.11",
         "routing_reverse_proxy:v1.1.16", "vroom-docker:v1.0.4"]

h = Harness("check_image_versions.sh")

# Tag bumped at the source of truth, the service spec left behind.
h.replace(ENV, "ROUTING_REVERSE_PROXY_TAG=v1.1.16", "ROUTING_REVERSE_PROXY_TAG=v1.1.17",
          expect="service YAMLs missing routing_reverse_proxy:v1.1.17",
          name="env bumped, service YAML not")

# The reverse: the spec bumped, the env (and every doc) left behind.
h.replace(f"{SVC}/vroom/vroom-service.yaml", "vroom-docker:v1.0.4", "vroom-docker:v1.0.5",
          expect="service YAMLs missing vroom-docker:v1.0.4",
          name="service YAML bumped, env not")

# A FROM SPECIFICATION string embedded in a SQL module keeps a stale tag.
h.replace(MOD, "image_repository/openrouteservice:v9.10.0", "image_repository/openrouteservice:v9.9.0",
          expect="SQL modules reference openrouteservice but not with tag v9.10.0",
          name="SQL module spec string with a stale tag")

h.replace(BUILD, "downloader:$DOWNLOADER_TAG", "downloader:latest", count=-1,
          expect="build-images.md missing downloader:v0.0.11",
          name="build doc no longer references the downloader tag")

h.replace(GUIDE, "| Downloader | downloader | v0.0.11 |", "| Downloader | downloader | v0.0.10 |",
          expect="snowflake-scripting-guidelines.md missing downloader:v0.0.11",
          name="guidelines table carries a stale tag")

# The gateway's baked-in build version drifts from its image tag.
h.replace(GW, "GATEWAY_VERSION = 'v1.1.16'", "GATEWAY_VERSION = 'v1.1.15'",
          expect="GATEWAY_VERSION (v1.1.15) in routing_service.py != ROUTING_REVERSE_PROXY_TAG (v1.1.16)",
          name="GATEWAY_VERSION drifts from ROUTING_REVERSE_PROXY_TAG")

h.replace(GW, "GATEWAY_VERSION = 'v1.1.16'", "GATEWAY_VERSION = os.environ.get('GW', 'v1.1.16')",
          expect="could not read GATEWAY_VERSION",
          name="GATEWAY_VERSION no longer a readable literal")

h.replace(f"{SVC}/downloader/downloader_spec.yaml", '"@CORE.ORS_SPCS_STAGE"', '"@PUBLIC.ORS_SPCS_STAGE"',
          expect="downloader_spec.yaml references volume schema @PUBLIC.",
          name="service volume on the wrong stage schema")

# Native App packaging: a manifest that misses one image.
h.add(MANIFEST, "images:\n" + "".join(f"  - /openrouteservice_app/core/image_repository/{p}\n"
                                      for p in PAIRS[:3]),
      expect="manifest.yml missing vroom-docker:v1.0.4",
      name="manifest missing one image")

# Native App packaging: a service spec pointing at a different repository.
dl = h.path(f"{SVC}/downloader/downloader_spec.yaml")
dl_orig = dl.read_text()
man = h.path(MANIFEST)


def repo_drift():
    man.write_text("images:\n" + "".join(f"  - /openrouteservice_app/public/image_repository/{p}\n"
                                         for p in PAIRS))
    assert "/core/image_repository/downloader:" in dl_orig
    dl.write_text(dl_orig.replace("/core/image_repository/downloader:", "/public/legacy_repo/downloader:"))


h.custom("service YAML repo path differs from the manifest", repo_drift,
         lambda: (man.unlink(missing_ok=True), dl.write_text(dl_orig)),
         expect="downloader_spec.yaml has repo path /openrouteservice_app/public/legacy_repo/, "
                "expected /openrouteservice_app/public/image_repository/")

h.delete(ENV, expect="image-versions.env not found", name="source of truth deleted")

# A consistent manifest with no /public/ path must not abort the gate before the
# checks that follow it: the GATEWAY_VERSION drift below is only reported if the
# manifest repo-path probe tolerated "no match".
gw = h.path(GW)
gw_orig = gw.read_text()


def manifest_then_gateway_drift():
    man.write_text("images:\n" + "".join(f"  - /openrouteservice_app/core/image_repository/{p}\n"
                                         for p in PAIRS))
    gw.write_text(gw_orig.replace("GATEWAY_VERSION = 'v1.1.16'", "GATEWAY_VERSION = 'v1.1.15'"))


h.custom("checks after a /public/-less manifest still run", manifest_then_gateway_drift,
         lambda: (man.unlink(missing_ok=True), gw.write_text(gw_orig)),
         expect="GATEWAY_VERSION (v1.1.15) in routing_service.py != ROUTING_REVERSE_PROXY_TAG")

sys.exit(h.finish())
