#!/usr/bin/env bash
# Resume and warm the routing engine so the first page load is not a cold start.
#
# Why: an install could finish with the region's ORS/VROOM services SUSPENDED
# (they idle-suspend after AUTO_SUSPEND_SECS, and a long install outlives the
# gateway's 1h timer). Every live view then called a sleeping engine on first
# load and rendered blank. auto_resume is on, but the first call still fails:
# the gateway's first request after idling returns "Could not connect to server"
# (routing-suspend.ts) and ORS reports not-ready while its graph loads.
#
# What it does, in order:
#   1. RESUME every SUSPENDED ORS_SERVICE_*, VROOM_SERVICE_* and the gateway
#      (DOWNLOADER is a build-time job and is left alone)
#   2. poll SHOW SERVICES until they are RUNNING
#   3. call ORS_STATUS(<region>) until it reports service_ready - the first call
#      absorbs the gateway cold start, so a failure is retried, not reported
#
# Usage:
#   prewarm_engine.sh <connection>            resume + wait + warm
#   prewarm_engine.sh <connection> --status   read-only: print each service's state
# Env: PREWARM_WAIT_S (default 900) bounds the whole wait.
# Exit: 0 every region ready, 2 not ready within the wait (degraded, not fatal),
#       1 could not read the services at all.
set -u

CONNECTION="${1:?usage: prewarm_engine.sh <connection> [--status]}"
MODE="${2:-}"
WAIT_S="${PREWARM_WAIT_S:-900}"
POLL_S=15
SCHEMA="OPENROUTESERVICE_APP.CORE"
# Every `snow sql` invocation is a new session, so the tag rides in each payload.
TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"prewarm"}}'
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK';"

# NAME STATUS AUTO_SUSPEND_SECS, one line per routing service (DOWNLOADER excluded).
services() {
  snow sql -c "$CONNECTION" --format json -q "SHOW SERVICES IN SCHEMA $SCHEMA" 2>/dev/null \
    | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for r in rows:
    n = r.get("name", "")
    if n.startswith(("ORS_SERVICE_", "VROOM_SERVICE_")) or n == "ROUTING_GATEWAY_SERVICE":
        s = r.get("auto_suspend_secs")
        # 0 is the keep-warm/no-suspend pin, NOT a missing value: `s or "-"`
        # rendered it as "idle-suspend -s" in the install summary.
        print(n, r.get("status", "?"), "-" if s in (None, "") else s)
'
}

print_status() {
  local any=0
  while read -r name status secs; do
    any=1
    case "$secs" in
      0)  printf '   %-30s %-10s no-suspend (keep-warm; reset to the default once idle)\n' "$name" "$status" ;;
      -)  printf '   %-30s %-10s idle-suspend unknown\n' "$name" "$status" ;;
      *)  printf '   %-30s %-10s idle-suspend %ss\n' "$name" "$status" "$secs" ;;
    esac
  done < <(services)
  [ "$any" = 1 ] || { echo "   (no routing services found in $SCHEMA)"; return 1; }
}

if [ "$MODE" = "--status" ]; then
  print_status
  exit $?
fi

LIST="$(services)" || { echo "[prewarm] could not read services in $SCHEMA"; exit 1; }
[ -n "$LIST" ] || { echo "[prewarm] no routing services in $SCHEMA - nothing to warm"; exit 1; }

# RESUME is re-issued on every poll, not once from the first snapshot: a service
# caught SUSPENDING when the script starts reaches SUSPENDED a minute later, and
# a resume-once pass skipped it and waited out the whole timeout (measured).
resume_suspended() {
  while read -r name status _; do
    [ "$status" = "SUSPENDED" ] || continue
    echo "[prewarm] resuming $name"
    snow sql -c "$CONNECTION" -q "$TAG_SQL ALTER SERVICE IF EXISTS $SCHEMA.$name RESUME" >/dev/null 2>&1 \
      || echo "[prewarm]   WARN: RESUME $name failed"
  done <<< "$1"
}

deadline=$(( $(date +%s) + WAIT_S ))
current="$LIST"
while :; do
  resume_suspended "$current"
  pending="$(awk '$2 != "RUNNING" {print $1"="$2}' <<< "$current" | tr '\n' ' ')"
  [ -z "${pending// /}" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[prewarm] WARN: not RUNNING after ${WAIT_S}s: $pending"
    print_status
    exit 2
  fi
  echo "[prewarm] waiting for: $pending"
  sleep "$POLL_S"
  current="$(services)"
done

REGIONS="$(awk '$1 ~ /^ORS_SERVICE_/ {sub(/^ORS_SERVICE_/, "", $1); print $1}' <<< "$LIST")"
not_ready=""
for rg in $REGIONS; do
  ready=""
  while :; do
    ready="$(snow sql -c "$CONNECTION" --format json \
      -q "SELECT $SCHEMA.ORS_STATUS('$rg'):service_ready::BOOLEAN AS R" 2>/dev/null \
      | python3 -c 'import json,sys
try: print(str(json.load(sys.stdin)[0]["R"]).lower())
except Exception: print("")' )"
    [ "$ready" = "true" ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    echo "[prewarm] $rg: engine not ready yet (${ready:-no answer}), retrying"
    sleep "$POLL_S"
  done
  if [ "$ready" = "true" ]; then
    echo "[prewarm] $rg: routing engine ready"
  else
    not_ready="$not_ready $rg"
  fi
done

print_status
if [ -n "$not_ready" ]; then
  echo "[prewarm] WARN: not ready within ${WAIT_S}s:$not_ready (the app resumes on first use and shows 'starting')"
  exit 2
fi
exit 0
