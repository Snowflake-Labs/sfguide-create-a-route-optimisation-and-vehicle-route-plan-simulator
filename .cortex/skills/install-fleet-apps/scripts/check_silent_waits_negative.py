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
# Cycle-2 defect (TIB, 2026-11-07): seed upload collected by a lowercase loop
# variable, invisible to the old *_PID-only pattern; ~7 min of silence.
h.replace(INST, '      wait_with_progress "${STAGE_PIDS[$i]}" "seed upload" "${STAGE_LOGS[$i]}" \\\n        || STAGE_FAIL=$((STAGE_FAIL + 1))',
          '      wait "${STAGE_PIDS[$i]}" || STAGE_FAIL=$((STAGE_FAIL + 1))',
          expect="RULE A bare wait on a background job",
          name="A: seed upload collected with a bare wait on an array element")
h.replace(INST, '      wait_with_progress "${STAGE_PIDS[$i]}" "seed upload" "${STAGE_LOGS[$i]}" \\\n        || STAGE_FAIL=$((STAGE_FAIL + 1))',
          '      pid="${STAGE_PIDS[$i]}"; wait "$pid" || STAGE_FAIL=$((STAGE_FAIL + 1))',
          expect="RULE A bare wait on a background job",
          name="A: the shipped form, a lowercase $pid loop variable")
h.replace(INST, '    with_heartbeat "seed load" /tmp/ifa_load.log \\\n      snow sql -c "$CONNECTION" -f /tmp/ifa_loader.sql || SEED_LOAD_RC=$?',
          '    snow sql -c "$CONNECTION" -f /tmp/ifa_loader.sql >/tmp/ifa_load.log 2>&1 || SEED_LOAD_RC=$?',
          expect="RULE C long step runs without a heartbeat",
          name="C: seed load back in the foreground, silent")
h.replace(INST, '  "$@" >"$log" 2>&1 &\n  wait_with_progress "$!" "$label" "$log"',
          '  "$@" >"$log" 2>&1',
          expect="RULE C with_heartbeat() missing",
          name="C: with_heartbeat runs the step without the heartbeat")
# Cycle-5 defect (TIB): baseline evals silent for ~17 min in step 6.6.
h.replace(INST, '  with_heartbeat "agent evals" /tmp/ifa_agent_evals.log \\\n      bash "$SCRIPTS/setup_agent_evals.sh" "$CONNECTION" $EVAL_ARGS \\\n',
          '  bash "$SCRIPTS/setup_agent_evals.sh" "$CONNECTION" $EVAL_ARGS \\\n      >/tmp/ifa_agent_evals.log 2>&1 \\\n',
          expect="RULE C long step runs without a heartbeat",
          name="C: baseline agent evals back in the foreground, silent")

sys.exit(h.finish())
