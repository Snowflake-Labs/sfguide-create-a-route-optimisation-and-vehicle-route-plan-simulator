#!/usr/bin/env python3
"""Negative tests for check_npm_retry.py. M1 is the shipped defect."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
SRC = 'source "$(dirname "${BASH_SOURCE[0]}")/lib/npm_retry.sh"\n'

h = Harness("check_npm_retry.py")
h.replace(f"{S}/deploy_fleet_sa_app.sh", SRC, "",
          expect="A .cortex/skills/install-fleet-apps/scripts/deploy_fleet_sa_app.sh",
          name="M1 SA deploy runs npm ci with no retry (the original abort)")
h.replace(f"{S}/install_synapse_bundles.sh", SRC, "",
          expect="A .cortex/skills/install-fleet-apps/scripts/install_synapse_bundles.sh",
          name="M2 synapse bundles npm install with no retry")
h.replace(f"{S}/lib/npm_retry.sh", "    [ \"$i\" -ge \"$NPM_RETRY_ATTEMPTS\" ] && return \"$rc\"\n",
          "    return \"$rc\"\n",
          expect="B transient failure not retried", name="M3 helper gives up on the first failure")
h.replace(f"{S}/lib/npm_retry.sh", "    ci|install) ;;\n", "    ci|install|run) ;;\n",
          expect="B `npm run` was retried", name="M4 helper retries npm run (a build failure)")
h.add(f"{S}/new_step.sh", "#!/bin/bash\n( cd x && npm ci )\n",
      expect="A .cortex/skills/install-fleet-apps/scripts/new_step.sh:2",
      name="M5 a new script installs packages without the helper")
sys.exit(h.finish())
