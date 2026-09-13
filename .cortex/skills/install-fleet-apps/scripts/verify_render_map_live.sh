#!/bin/bash
# Live negative-case probe for the deployed render_map verb.
# Each case MUST be rejected with its specific code; an accepted spec is a defect.
set -u
CONN="${1:-TIB}"
TAG='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
FAILS=0

run() {
  local name="$1" spec="$2" expect="$3"
  {
    printf "ALTER SESSION SET query_tag = '%s';\n" "$TAG"
    printf 'CALL OPENROUTESERVICE_APP.ROUTING.RENDER_MAP($$%s$$, NULL, NULL);\n' "$spec"
  } > /tmp/render_map_neg.sql
  local out
  out=$(snow sql -c "$CONN" --enable-templating NONE -f /tmp/render_map_neg.sql 2>&1 | tr -d '\n')
  local code
  code=$(printf '%s' "$out" | grep -oE '(INVALID_MAP_SPEC_[A-Z_]+|UNKNOWN_LAYER_TYPE)' | head -1)
  if [ -z "$code" ]; then
    printf '%-10s ACCEPTED - no rejection (DEFECT)\n' "$name"
    FAILS=$((FAILS + 1))
  elif [ "$code" != "$expect" ]; then
    printf '%-10s %s (expected %s)\n' "$name" "$code" "$expect"
    FAILS=$((FAILS + 1))
  else
    local detail
    detail=$(printf '%s' "$out" | grep -oE "${code}: [^|]{0,70}" | head -1)
    printf '%-10s ok  %s\n' "$name" "$detail"
  fi
}

run BAD_TYPE  '{"layers":[{"type":"heatmap","data":{"query":"SELECT 1"}}]}' UNKNOWN_LAYER_TYPE
run VIEWSTATE '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1","params":{"trip":"viewState.selected_trip"}}}]}' INVALID_MAP_SPEC_SHAPE
run WRITE     '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"DELETE FROM FLEET_APP.DWELL.VW_DWELL_ENRICHED"}}]}' INVALID_MAP_SPEC_SHAPE
run TOOMANY   '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_SHAPE
run EMPTY     '{"layers":[]}' INVALID_MAP_SPEC_SHAPE
run NOQUERY   '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{}}]}' INVALID_MAP_SPEC_SHAPE
run BADJSON   '{oops' INVALID_MAP_SPEC_JSON

if [ "$FAILS" -gt 0 ]; then
  echo ""
  echo "FAILED: $FAILS case(s)"
  exit 1
fi
echo ""
echo "PASSED: every invalid render_map spec was rejected with its specific code"
