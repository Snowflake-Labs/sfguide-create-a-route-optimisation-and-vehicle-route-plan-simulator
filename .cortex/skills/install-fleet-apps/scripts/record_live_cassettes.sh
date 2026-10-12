#!/usr/bin/env bash
#
# install-fleet-apps / record_live_cassettes.sh
#
# Re-record the cassettes the LIVE gates' negative tests replay offline
# (scripts/live_cassettes/*.json, see fake_snow.py). Run it against a HEALTHY,
# freshly installed account - the e2e harness does, after its live gates pass -
# or whenever a live gate's queries change (its negative test then fails with
# "UNRECORDED request").
#
# Every query is read-only. Output is scrubbed of the account locator,
# organization, account name and user before it is written, because the
# cassettes are committed. Each gate is replayed straight after recording and
# must pass on the replay, or the cassette is not kept.
#
# Usage: bash .cortex/skills/install-fleet-apps/scripts/record_live_cassettes.sh <connection> [gate ...]
#   gates: deployment_coherence stream_invariants labor_layer plan_standards_view
#          gateway_version render_map_live      (default: all)
# agent_eval_thresholds is synthetic (no fresh account has eval runs):
#   python3 .cortex/skills/install-fleet-apps/scripts/check_agent_eval_thresholds_negative.py --record
set -uo pipefail

CONN="${1:?connection name required}"; shift
S="$(cd "$(dirname "$0")" && pwd)"
C="$S/live_cassettes"
mkdir -p "$C"
REAL="$(command -v snow)" || { echo "ERROR: snow CLI not on PATH"; exit 2; }
FB="$(python3 -c "import sys; sys.path.insert(0, '$S'); import fake_snow; print(fake_snow.fake_snow_bin())")"

ID="$(snow sql -c "$CONN" --format json -q "ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}'; SELECT CURRENT_ACCOUNT() AS L, CURRENT_ORGANIZATION_NAME() AS O, CURRENT_ACCOUNT_NAME() AS N, CURRENT_USER() AS U" \
      | python3 -c 'import sys,json; r=json.load(sys.stdin)[-1][0]; print(r["L"], r["O"], r["N"], r["U"])')" \
  || { echo "ERROR: cannot query connection '$CONN'"; exit 2; }
read -r LOC ORG NAME USR <<<"$ID"
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
HOST="$(lc "$ORG")-$(lc "$NAME" | tr '_' '-')"
export FAKE_SNOW_SCRUB="$LOC=>XX00000;$(lc "$LOC")=>xx00000;$ORG-$NAME=>ORG-ACCOUNT;$HOST=>org-account;$NAME=>ACCOUNT;$USR=>GATE_USER;$(lc "$USR")=>gate_user"

declare_gate() {
  case "$1" in
    deployment_coherence) echo "bash $S/verify_deployment.sh -c $CONN --expect-engine" ;;
    stream_invariants)    echo "python3 $S/run_sql_must_be_empty.py -c $CONN $S/check_stream_invariants.sql" ;;
    labor_layer)          echo "python3 $S/run_sql_must_be_empty.py -c $CONN --status-column STATUS -D REGION=SanFrancisco $S/verify_labor_layer.sql" ;;
    plan_standards_view)  echo "python3 $S/check_plan_standards_view.py $CONN SanFrancisco" ;;
    gateway_version)      echo "bash $S/verify_gateway_version.sh $CONN" ;;
    render_map_live)      echo "bash $S/verify_render_map_live.sh $CONN" ;;
    *) return 1 ;;
  esac
}

GATES="${*:-deployment_coherence stream_invariants labor_layer plan_standards_view gateway_version render_map_live}"
FAIL=0
for g in $GATES; do
  CMD="$(declare_gate "$g")" || { echo "ERROR: unknown gate '$g'"; FAIL=1; continue; }
  NEW="$C/$g.json.new"; rm -f "$NEW"
  # shellcheck disable=SC2086
  if ! FAKE_SNOW_MODE=record FAKE_SNOW_CASSETTE="$NEW" FAKE_SNOW_REAL="$REAL" PATH="$FB:$PATH" $CMD >/tmp/ifa_cassette_$g.txt 2>&1; then
    echo "  FAIL  $g: the gate itself fails on '$CONN' - an unhealthy account cannot be a baseline (/tmp/ifa_cassette_$g.txt)"
    rm -f "$NEW"; FAIL=1; continue
  fi
  # shellcheck disable=SC2086
  if ! FAKE_SNOW_MODE=replay FAKE_SNOW_CASSETTE="$NEW" PATH="$FB:$PATH" $CMD >/tmp/ifa_cassette_$g.replay.txt 2>&1; then
    echo "  FAIL  $g: recorded, but the gate does not pass on its own replay (/tmp/ifa_cassette_$g.replay.txt)"
    rm -f "$NEW"; FAIL=1; continue
  fi
  if grep -qiE "$LOC|$USR|$HOST" "$NEW"; then
    echo "  FAIL  $g: account identifiers survived scrubbing - not writing it"; rm -f "$NEW"; FAIL=1; continue
  fi
  mv "$NEW" "$C/$g.json"
  echo "  OK    $g ($(python3 -c "import json; print(len(json.load(open('$C/$g.json'))))" ) requests)"
done
rm -rf "$FB"
exit "$FAIL"
