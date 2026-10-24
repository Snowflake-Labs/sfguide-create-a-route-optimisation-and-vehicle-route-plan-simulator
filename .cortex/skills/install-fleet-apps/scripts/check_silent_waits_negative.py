#!/usr/bin/env python3
"""Negative tests for check_silent_waits.py: each case reintroduces a silent
wait on a background job and asserts the gate convicts it."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

INST = ".cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh"
h = Harness("check_silent_waits.py")

# The shipped defect: step 3 collected the engine image push with a bare wait.
h.replace(INST, 'if wait_with_progress "$ENGINE_IMAGES_PID" "engine image build+push" /tmp/ifa_engine_images.log; then',
          'if wait "$ENGINE_IMAGES_PID"; then',
          expect="RULE A bare wait on a background job",
          name="A: engine image phase collected with a bare wait")
h.replace(INST, 'wait_with_progress "$VERIFY_VIEWS_PID" "view verification" /tmp/ifa_verify.log || VERIFY_RC=$?',
          'wait "$VERIFY_VIEWS_PID" || VERIFY_RC=$?',
          expect="RULE A bare wait on a background job",
          name="A: view verification collected with a bare wait")
h.replace(INST, 'wait_with_progress "$APP_SA_PID" "SA app deploy" /tmp/ifa_sa_deploy.log || SA_RC=$?',
          'wait "$APP_SA_PID" || SA_RC=$?',
          expect="RULE A bare wait on a background job",
          name="A: parallel SA app deploy collected with a bare wait")
h.replace(INST, '    note "    $label still running',
          '    : "    $label still running',
          expect="RULE B poll loop prints no progress note",
          name="B: heartbeat loop that prints nothing")
h.replace(INST, '    sleep "${HEARTBEAT_SECS:-60}" &', '    true &',
          expect="RULE B poll loop never sleeps",
          name="B: heartbeat loop that never sleeps")
h.replace(INST, "wait_with_progress() {", "wait_for_job() {",
          expect="wait_with_progress() is not defined",
          name="helper renamed away")

sys.exit(h.finish())
