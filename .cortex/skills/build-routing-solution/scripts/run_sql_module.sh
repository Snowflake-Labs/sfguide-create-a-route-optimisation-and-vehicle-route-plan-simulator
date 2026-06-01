#!/usr/bin/env bash
# ------------------------------------------------------------------
# run_sql_module.sh — wrapper around `snow sql -f` that fails the
# script when the file emits SQL errors.
#
# Background: `snow sql -f <multi-statement-file>` returns exit 0
# even when individual statements fail to compile (friction-log F1,
# 2026-05-19, "REGION_CATALOG does not exist or not authorized").
# Plain `&& chaining` therefore happily proceeds past a partial
# failure, leaving the install in an unbuildable state.
#
# This wrapper runs `snow sql -f`, tees stdout+stderr to a log file
# under /tmp, then greps the log for the canonical Snowflake error
# prefix `NNNNNN (NNNNN):` (six-digit code followed by SQLSTATE) and
# for lines starting with `Error`. If either is present, the script
# exits non-zero and prints the path to the log so the user can
# inspect it.
#
# Usage:
#   bash scripts/run_sql_module.sh <connection> <sql-file>
#
# Observability (friction-log F1, 2026-05-29): when this wrapper is run in a
# backgrounded loop, the per-statement echo buries the OK:/FAIL: markers so a
# tail/filter can miss them and a module looks "hung" when it has finished.
# Two env knobs address that:
#   MODULE_STATUS_LOG  Append one compact line per module
#                      (`<ISO-ts> START|OK|FAIL <module>`). Defaults to
#                      ${TMPDIR:-/tmp}/run_sql_module_status.log. `tail -f` it to
#                      watch progress without the verbose statement echo.
#   QUIET=1            Suppress the verbose statement echo to stdout (the full
#                      per-statement log is still written to the per-file log);
#                      only the START/OK/FAIL status lines are printed.
#
# Example:
#   for m in 01_core_infra.sql 02_routing_functions.sql ...; do
#     bash scripts/run_sql_module.sh "$CONN" \
#       ".../app/modules/$m" || exit 1
#   done
# ------------------------------------------------------------------
set -euo pipefail

CONN="${1:?connection name required as 1st arg}"
SQL_FILE="${2:?sql file path required as 2nd arg}"
QUIET="${QUIET:-0}"
MODULE_STATUS_LOG="${MODULE_STATUS_LOG:-${TMPDIR:-/tmp}/run_sql_module_status.log}"

_status() {
  # _status <STATE> <module-basename>
  printf '%s %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" "$2" >> "$MODULE_STATUS_LOG" 2>/dev/null || true
}

if [ ! -f "$SQL_FILE" ]; then
  echo "FAIL: $SQL_FILE not found" >&2
  _status "FAIL" "$(basename "$SQL_FILE")"
  exit 1
fi

BASE="$(basename "$SQL_FILE")"
LOG="/tmp/${BASE}.log"
_status "START" "$BASE"

# `snow sql -f` itself can exit non-zero (auth/connectivity); allow
# that to propagate but also still grep for per-statement errors.
if [ "$QUIET" = "1" ]; then
  snow sql -f "$SQL_FILE" -c "$CONN" > "$LOG" 2>&1 || true
else
  snow sql -f "$SQL_FILE" -c "$CONN" 2>&1 | tee "$LOG"
fi

if grep -Eq "^(Error|[0-9]{6} \()" "$LOG"; then
  echo "FAIL: $BASE emitted SQL errors (see $LOG)" >&2
  _status "FAIL" "$BASE"
  exit 2
fi

echo "OK: $BASE"
_status "OK" "$BASE"
