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

# A spec that MUST be accepted. The negatives above can all be satisfied by a verb
# that rejects everything, so at least one positive is needed to prove the gate is
# not simply closed - and this particular one proves the capability the agent specs
# promise (live routing geometry in a layer) is actually reachable.
accept() {
  local name="$1" spec="$2"
  {
    printf "ALTER SESSION SET query_tag = '%s';\n" "$TAG"
    printf 'CALL OPENROUTESERVICE_APP.ROUTING.RENDER_MAP($$%s$$, NULL, NULL);\n' "$spec"
  } > /tmp/render_map_pos.sql
  local out
  out=$(snow sql -c "$CONN" --enable-templating NONE -f /tmp/render_map_pos.sql 2>&1 | tr -d '\n')
  local code
  code=$(printf '%s' "$out" | grep -oE '(INVALID_MAP_SPEC_[A-Z_]+|UNKNOWN_LAYER_TYPE)' | head -1)
  if [ -n "$code" ]; then
    printf '%-10s REJECTED with %s (DEFECT - this spec is valid)\n' "$name" "$code"
    FAILS=$((FAILS + 1))
  else
    printf '%-10s ok  accepted\n' "$name"
  fi
}

run BAD_TYPE  '{"layers":[{"type":"heatmap","data":{"query":"SELECT 1"}}]}' UNKNOWN_LAYER_TYPE
run VIEWSTATE '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1","params":{"trip":"viewState.selected_trip"}}}]}' INVALID_MAP_SPEC_SHAPE
run WRITE     '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"DELETE FROM FLEET_APP.DWELL.VW_DWELL_ENRICHED"}}]}' INVALID_MAP_SPEC_SHAPE
run TOOMANY   '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}},{"type":"scatterplot","lng":"a","lat":"b","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_SHAPE
run EMPTY     '{"layers":[]}' INVALID_MAP_SPEC_SHAPE
run NOQUERY   '{"layers":[{"type":"scatterplot","lng":"a","lat":"b","data":{}}]}' INVALID_MAP_SPEC_SHAPE
run BADJSON   '{oops' INVALID_MAP_SPEC_JSON
# A database outside the dynamic read boundary. The EXPLAIN gate cannot catch this
# (owner's-rights turns it into "does not exist or not authorized", which that gate
# ignores on purpose), so it is the allowlist check or nothing - and "nothing" is
# what shipped an empty map beside a correct one.
run BADDB     '{"layers":[{"type":"scatterplot","lng":"origin_lon","lat":"origin_lat","data":{"query":"SELECT 1 FROM SYNTHETIC_DATASETS.UNIFIED.TRIPS"}}]}' INVALID_MAP_SPEC_DB
# Missing encodings. Each of these used to validate cleanly, echo, and then draw
# an EMPTY basemap at world zoom: the compiler filters its data on the column, so
# `undefined` removes every row silently. NOHEX is the exact shape of the "45 min
# ebike POI density" defect once the case fix made an UPPERCASE name legal.
run NOHEX     '{"layers":[{"type":"h3","valueColumn":"poi_count","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_ENCODING
run NOLATLNG  '{"layers":[{"type":"scatterplot","lng":"lon","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_ENCODING
run NOGEOJSON '{"layers":[{"type":"geojson","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_ENCODING
run NOTARGET  '{"layers":[{"type":"arc","source":{"lng":"a","lat":"b"},"data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_ENCODING
run NOPATH    '{"layers":[{"type":"path","data":{"query":"SELECT 1"}}]}' INVALID_MAP_SPEC_ENCODING
# ... and the legal path shapes must NOT be dragged in with them.
accept PATH_ENDS '{"layers":[{"type":"path","start":{"lng":"a","lat":"b"},"end":{"lng":"c","lat":"d"},"data":{"query":"SELECT 1 AS a, 2 AS b, 3 AS c, 4 AS d"}}]}'
# An UPPERCASE encoding is ACCEPTED: the client lowercases spec column refs to
# match /api/query's lowercased row keys, and this verb must not reject the very
# names its own description teaches (H3_CELL_R7, DWELL_MINUTES).
accept UPPERCASE '{"layers":[{"type":"h3","hexColumn":"H3_CELL_R7","valueColumn":"DWELL_MINUTES","data":{"query":"SELECT H3_CELL_R7, DWELL_MINUTES FROM FLEET_APP.DWELL.VW_DWELL_SESSIONS WHERE REGION = :region","params":{"region":"context.region"}}}]}'

# Live routing geometry in a layer: allowed, and the whole point of allowing
# ROUTING_PLATFORM. If this is ever rejected the agent guidance is lying again.
accept LIVE_ORS '{"layers":[{"type":"path","geojsonColumn":"g","data":{"query":"SELECT ST_ASGEOJSON(GEOJSON)::STRING AS g FROM TABLE(ROUTING_PLATFORM.CONTRACT.DIRECTIONS(:profile, ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.3894::FLOAT, 37.6156::FLOAT), ARRAY_CONSTRUCT(-122.4177::FLOAT, 37.7793::FLOAT))::VARIANT, :region, NULL::VARCHAR))","params":{"region":"context.region","profile":"context.vehicle_type"}}}]}'

if [ "$FAILS" -gt 0 ]; then
  echo ""
  echo "FAILED: $FAILS case(s)"
  exit 1
fi
echo ""
echo "PASSED: every invalid render_map spec was rejected with its specific code"
