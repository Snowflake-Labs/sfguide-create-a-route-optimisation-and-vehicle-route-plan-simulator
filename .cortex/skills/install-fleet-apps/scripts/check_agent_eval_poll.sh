#!/usr/bin/env bash
#
# check_agent_eval_poll.sh
#
# Behavioural test of setup_agent_evals.sh's baseline poll against a fake `snow`
# that scripts the EXECUTE_AI_EVALUATION STATUS answers. Defects it pins (TIB,
# 2026-11-08 eval run): every START/STATUS call printed raw snow tables into the
# console, the heartbeat said "still running ..." 23 times with no elapsed time,
# and the script exited 0 whatever a run ended as (or after silently giving up),
# so installer step 6.6 could never report a failed baseline.
#   SCRIPT=<path> overrides the script under test (negative test).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${SCRIPT:-$HERE/setup_agent_evals.sh}"
W="$(mktemp -d -t evalpoll.XXXXXX)"
trap 'rm -rf "$W"' EXIT
FAILS=0
bad() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

mkdir -p "$W/bin"
cat >"$W/bin/snow" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *SHOW\ DATASETS*) echo '[{"name":"EVAL_DS_FLEET_AGENT"}]'; exit 0 ;;
  *"'STATUS'"*)
    n=$(cat "$FAKE_DIR/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$FAKE_DIR/n"
    # FAKE_FAIL_AT=<poll#>: that poll fails like a dropped connection (TIB cycle 5).
    if [ "${FAKE_FAIL_AT:-0}" = "$n" ]; then
      echo "Invalid connection configuration. 250001: Could not connect to Snowflake backend" >&2; exit 1
    fi
    IFS=, read -ra seq <<<"$FAKE_STATUS"
    i=$(( n <= ${#seq[@]} ? n - 1 : ${#seq[@]} - 1 ))
    st="${seq[$i]}"
    if [[ "$args" == *"--format csv"* ]]; then
      # Real `snow sql --format csv` shape for a multi-statement -q (measured on
      # TIB): one "status" block per preamble statement, the CALL's result set,
      # then a trailing blank line. A parser keyed on line 1, or on the last line,
      # reads nothing.
      n_pre=$(grep -o ';' <<<"$args" | wc -l | tr -d ' ')
      for ((k = 1; k < n_pre; k++)); do printf 'status\nStatement executed successfully.\n\n'; done
      printf 'RUN_NAME,AGENT_NAME,AGENT_TYPE,STATUS,STATUS_DETAILS\nbaseline-x,FLEET_AGENT,Cortex Agent,%s,[]\n\n' "$st"
    else
      printf '+------+\n| STATUS %s |\n+------+\n' "$st"
    fi
    exit 0 ;;
esac
printf 'Statement executed successfully.\n+---------------------------------+\n| Function executed successfully. |\n+---------------------------------+\n'
exit 0
EOF
chmod +x "$W/bin/snow"

# run_case <name> <status sequence> <poll mins> -> sets RC, OUT
run_case() {
  rm -f "$W/n"
  OUT=$(cd "$HERE" && PATH="$W/bin:$PATH" FAKE_DIR="$W" FAKE_STATUS="$2" FAKE_FAIL_AT="${FAKE_FAIL_AT:-0}" \
        EVAL_POLL_SECS=0 EVAL_POLL_MINS="$3" \
        bash "$SCRIPT" FAKE --agents FLEET_AGENT 2>&1)
  RC=$?
  printf '%s\n' "$OUT" >"$W/$1.out"
}

# 1. the real TIB sequence: INVOCATION_COMPLETED is mid-run (judges still to score)
run_case done "INVOCATION_IN_PROGRESS,INVOCATION_COMPLETED,COMPUTATION_IN_PROGRESS,COMPLETED" 5
[ "$RC" = 0 ] || bad "completed run: rc=$RC, expected 0"
grep -q "FLEET_AGENT COMPLETED in" "$W/done.out" || bad "completed run: no one-line result"
grep -q "FLEET_AGENT COMPUTATION_IN_PROGRESS (" "$W/done.out" \
  || bad "completed run: stopped at INVOCATION_COMPLETED, before the judges scored"
[ "$(cat "$W/n")" = 4 ] || bad "completed run: polled $(cat "$W/n") times, expected 4 (stopped early or late)"
grep -qE '^\+-{3,}|Function executed successfully|^\| ' "$W/done.out" && bad "completed run: raw snow table output in the console"
grep -qE "FLEET_AGENT INVOCATION_IN_PROGRESS \([0-9]+ min\)" "$W/done.out" || bad "completed run: heartbeat lacks status + elapsed minutes"

# 2. failed: rc 1, named
run_case failed "INVOCATION_IN_PROGRESS,FAILED" 5
[ "$RC" = 1 ] || bad "failed run: rc=$RC, expected 1 (installer step 6.6 must see it)"
grep -q "FLEET_AGENT FAILED" "$W/failed.out" || bad "failed run: failure not reported"

# 2b. documented partial failure that persists: must not read as success
run_case partial "COMPUTATION_IN_PROGRESS,PARTIALLY_COMPLETED" 5
[ "$RC" = 1 ] || bad "partially completed run: rc=$RC, expected 1"
grep -q "FLEET_AGENT FAILED: PARTIALLY_COMPLETED" "$W/partial.out" || bad "partially completed run: not reported as a failure"

# 2c. observed on TIB: PARTIALLY_COMPLETED for one read, then COMPLETED, all scored
run_case settles "COMPUTATION_IN_PROGRESS,PARTIALLY_COMPLETED,COMPLETED" 5
[ "$RC" = 0 ] || bad "transient PARTIALLY_COMPLETED reported as a failure (rc=$RC); it settled to COMPLETED"

# 2d. observed on TIB cycle 5: one STATUS poll fails to connect; the run must go on
FAKE_FAIL_AT=2 run_case dropped "INVOCATION_IN_PROGRESS,INVOCATION_IN_PROGRESS,COMPLETED" 5
[ "$RC" = 0 ] || bad "one dropped STATUS poll killed the script (rc=$RC)"
grep -q "FLEET_AGENT COMPLETED in" "$W/dropped.out" || bad "one dropped STATUS poll: run never reported COMPLETED"

# 3. never terminal within the window: rc 1, says it stopped waiting
run_case timeout "INVOCATION_IN_PROGRESS" 0
[ "$RC" = 1 ] || bad "unfinished run: rc=$RC, expected 1"
grep -q "stopped waiting" "$W/timeout.out" || bad "unfinished run: gave up without saying so"

if [ "$FAILS" -gt 0 ]; then echo "agent_eval_poll: $FAILS failure(s)"; exit 1; fi
echo "agent_eval_poll: OK (real 4-phase sequence, partial/failed/unfinished runs, quiet console, timed heartbeat)"
