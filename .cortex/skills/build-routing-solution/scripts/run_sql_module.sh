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
# Example:
#   for m in 01_core_infra.sql 02_routing_functions.sql ...; do
#     bash scripts/run_sql_module.sh "$CONN" \
#       ".../app/modules/$m" || exit 1
#   done
# ------------------------------------------------------------------
set -euo pipefail

CONN="${1:?connection name required as 1st arg}"
SQL_FILE="${2:?sql file path required as 2nd arg}"

if [ ! -f "$SQL_FILE" ]; then
  echo "FAIL: $SQL_FILE not found" >&2
  exit 1
fi

LOG="/tmp/$(basename "$SQL_FILE").log"

# `snow sql -f` itself can exit non-zero (auth/connectivity); allow
# that to propagate but also still grep for per-statement errors.
snow sql -f "$SQL_FILE" -c "$CONN" 2>&1 | tee "$LOG"

if grep -Eq "^(Error|[0-9]{6} \()" "$LOG"; then
  echo "FAIL: $(basename "$SQL_FILE") emitted SQL errors (see $LOG)" >&2
  exit 2
fi

echo "OK: $(basename "$SQL_FILE")"
