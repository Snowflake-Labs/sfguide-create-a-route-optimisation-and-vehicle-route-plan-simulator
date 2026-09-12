#!/usr/bin/env bash
set -o pipefail
cd /Users/obielov/Documents/GitHub/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator
export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true
export CONTAINER_CMD=docker
ts=$(date +%Y%m%d_%H%M%S)
LOG="logs/install_run_${ts}.log"
echo "$LOG" > logs/_latest_install_log.txt
bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection TIB > "$LOG" 2>&1
echo "INSTALL_EXIT=$?" >> "$LOG"
