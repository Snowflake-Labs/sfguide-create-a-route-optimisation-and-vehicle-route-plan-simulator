#!/usr/bin/env bash
# Negative tests for check_number_formatting.py. Each mutation reintroduces one
# real defect; the gate must reject every one, and the tree must be restored.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

GATE="python3 .cortex/skills/install-fleet-apps/scripts/check_number_formatting.py"
SA=".cortex/skills/install-fleet-apps/fleet_sa_app"
ADMIN=".cortex/skills/install-fleet-apps/fleet_admin_app"
pass=0; fail=0

expect_fail() { # name file sed-expr
  local name="$1" file="$2" expr="$3"
  cp "$file" /tmp/nt.bak
  perl -0pi -e "$expr" "$file"
  if cmp -s /tmp/nt.bak "$file"; then
    echo "INCONCLUSIVE: $name - mutation changed nothing (pattern stale)"; fail=$((fail+1))
  elif $GATE >/tmp/nt.out 2>&1; then
    echo "NOT CONVICTED: $name - gate PASSED on a mutated tree"; sed 's/^/    /' /tmp/nt.out; fail=$((fail+1))
  else
    echo "convicted: $name"; pass=$((pass+1))
  fi
  cp /tmp/nt.bak "$file"
  cmp -s /tmp/nt.bak "$file" || { echo "RESTORE FAILED for $file"; exit 1; }
}

# Two-file variant. Some defects are only a defect in combination - see #8.
expect_fail2() { # name fileA exprA fileB exprB
  local name="$1" fa="$2" ea="$3" fb="$4" eb="$5"
  cp "$fa" /tmp/nt.a.bak; cp "$fb" /tmp/nt.b.bak
  perl -0pi -e "$ea" "$fa"; perl -0pi -e "$eb" "$fb"
  if cmp -s /tmp/nt.a.bak "$fa" || cmp -s /tmp/nt.b.bak "$fb"; then
    echo "INCONCLUSIVE: $name - one half of the mutation changed nothing"; fail=$((fail+1))
  elif $GATE >/tmp/nt.out 2>&1; then
    echo "NOT CONVICTED: $name - gate PASSED on a mutated tree"; sed 's/^/    /' /tmp/nt.out; fail=$((fail+1))
  else
    echo "convicted: $name"; pass=$((pass+1))
  fi
  cp /tmp/nt.a.bak "$fa"; cp /tmp/nt.b.bak "$fb"
  cmp -s /tmp/nt.a.bak "$fa" && cmp -s /tmp/nt.b.bak "$fb" || { echo "RESTORE FAILED"; exit 1; }
}

# The gate is STATIC, so it cannot see what the formatter RETURNS. Round two
# shipped because I tested the gate around the function and never the function
# itself: `YEAR 2026` -> "2,026" was invisible to every static rule. This executes
# it. Mutation 14 proves this suite can fail on a change no static rule can see.
run_behaviour() {
  (cd "$SA/ui" && npx tsx --eval '
import { formatCellValue } from "./src/lib/format-number.ts";
const cases: Array<[number,string,string]> = [
  [2026,"YEAR","2026"],[2026,"TRIP_YEAR","2026"],[14,"WEEK_NUM","14"],
  [94105,"ZIP","94105"],[10432,"OPERATOR_ID","10432"],[404,"STATUS_CODE","404"],
  [1234567,"ZIP_POPULATION","1,234,567"],[9876,"IDLE_DAYS","9,876"],[12345,"TOTAL_TRIPS","12,345"],
  [21289.670000000002,"TOTAL_OT_PREMIUM","21,289.67"],
  [1556.0899999999997,"TOTAL_PROJECTED_OT_HOURS","1,556.09"],
  [37.774929,"LATITUDE","37.77493"],[0.9969,"AVG_UTILIZATION","0.9969"],[0.041333,"DETOUR_RATE","0.0413"],
];
let bad = 0;
for (const [v,c,exp] of cases) {
  const out = formatCellValue(v, { column: c, grouping: true });
  if (out === exp) { continue; }
  bad += 1;
  console.error("  BAD " + c + ": got " + out + ", expected " + exp);
}
if (bad > 0) { process.exit(1); }
console.log("  " + cases.length + " behavioural cases pass");
' 2>&1)
}

# 1. The original defect: the chat grid stringifies a row value verbatim.
expect_fail "raw String(row[...]) in chat grid" \
  "$SA/ui/src/components/inline/data-table.tsx" \
  "s/\{formatCellValue\(row\[col\.key\][^\n]*\}/{String(row[col.key] ?? '')}/"

# 2. Formatter dropped entirely from a render site.
expect_fail "no formatter call in admin grid" \
  "$ADMIN/ui/src/components/shared/DataTable.tsx" \
  "s/formatCellValue\(row\[col\][^\n]*\)\}/String(row[col])}/"

# 3. A semantic metric loses its ROUND - the SQL half of the defect.
expect_fail "SV_LABOR total_ot_premium unwrapped" \
  "$SA/app/semantic_views.sql" \
  "s/ROUND\(SUM\(EST_OT_PREMIUM\), 2\)/SUM(EST_OT_PREMIUM)/"

# 4. Widening the cap: the policy constant itself.
expect_fail "MAX_DECIMALS widened to 6" \
  "$SA/ui/src/lib/format-number.ts" \
  "s/MAX_DECIMALS = 2/MAX_DECIMALS = 6/"

# 5. Dropping the coordinate exemption from the decision, leaving it defined but
#    unreachable - the mutation a 'constant is present' check would miss.
expect_fail "decimalsFor stops consulting isCoordinateColumn" \
  "$SA/ui/src/lib/format-number.ts" \
  "s/  if \(isCoordinateColumn\(column\)\) return COORD_DECIMALS;\n//"

# 6. Losing the sub-1 exemption.
expect_fail "SMALL_MAGNITUDE_DECIMALS removed" \
  "$SA/ui/src/lib/format-number.ts" \
  "s/SMALL_MAGNITUDE_DECIMALS/SMALL_MAGNITUDE_GONE/g"

# 7. Vacuity: a stale render-site path must fail, not silently inspect fewer.
expect_fail "listed render site missing" \
  ".cortex/skills/install-fleet-apps/scripts/check_number_formatting.py" \
  "s|components/inline/data-table.tsx|components/inline/data-table-GONE.tsx|"

# 8. The miss this rule exists for. BOTH halves are required, and finding that out
#    is the point: my first version only delisted the file, the gate passed, and it
#    was RIGHT to - a delisted file that still formats emits nothing raw. The
#    historical defect was unlisted AND raw at the same time, which is what let the
#    render_map tooltip ship a verbatim copy of the view-map bug while the gate
#    inspected 10 sites and reported no violations. Rule A cannot see a delisted
#    file; only rule E can.
expect_fail2 "unlisted AND raw emitter (the historical miss)" \
  ".cortex/skills/install-fleet-apps/scripts/check_number_formatting.py" \
  "s|    SA_UI / \"components/inline/render-map-inline.tsx\":\n        \"render_map tooltip - the agent's map, drawn inside a chat answer\",\n||" \
  "$SA/ui/src/components/inline/render-map-inline.tsx" \
  "s/    if \(v == null\) return '';\n    return escapeHtml\(formatCellValue\(v, \{ column: String\(col\), grouping: true, empty: '' \}\)\);/    return v == null ? '' : escapeHtml(v);/"

# 9. The string-only review going stale: a numeric feature property added to a
#    tooltip that was reviewed as strings-only.
expect_fail "string-only site reads a new property" \
  "$SA/ui/src/components/inline/route-map-inline.tsx" \
  "s/const title = props\.name != null \? String\(props\.name\) : '';/const title = props.name != null ? String(props.name) : String(props.distance_km ?? '');/"

# 10. The raw tooltip stringify itself, on the agent-facing inline map.
expect_fail "inline map tooltip raw escapeHtml(v)" \
  "$SA/ui/src/components/inline/render-map-inline.tsx" \
  "s/    if \(v == null\) return '';\n    return escapeHtml\(formatCellValue\(v, \{ column: String\(col\), grouping: true, empty: '' \}\)\);/    return v == null ? '' : escapeHtml(v);/"

# 11. NEGATIVE CONTROL: the JSX `value=` attribute must stay raw. Formatting it
#     would change the filter, not its presentation - so this mutation must be
#     ACCEPTED. It guards the negative lookbehind in RAW_CELL, which three
#     violations on the first run proved is load-bearing.
cp "$SA/ui/src/components/views/areas/view-combo-box.tsx" /tmp/nt_ctl.bak
if $GATE >/dev/null 2>&1; then
  echo "control: gate passes with the raw value= attribute (correct)"; pass=$((pass+1))
else
  echo "CONTROL FAILED: gate rejects the raw value= attribute it must allow"; fail=$((fail+1))
fi
cp /tmp/nt_ctl.bak "$SA/ui/src/components/views/areas/view-combo-box.tsx"

# 12. The identifier exemption defined but UNREACHABLE from the grouping decision.
#     This is the shape the round-two defect actually had: every constant present,
#     nothing consulting the predicate, so YEAR 2026 rendered as "2,026".
expect_fail "useGroupingFor stops consulting isIdentifierColumn" \
  "$SA/ui/src/lib/format-number.ts" \
  "s/  return \!\(Number\.isInteger\(value\) && isIdentifierColumn\(column\)\);/  return true;/"

# 13. formatNumber bypassing the decision entirely and taking the caller's flag
#     straight to toLocaleString - the exemption would be dead code.
expect_fail "formatNumber bypasses useGroupingFor" \
  "$SA/ui/src/lib/format-number.ts" \
  "s/  const grouping = useGroupingFor\(value, column, groupingRequested\);/  const grouping = groupingRequested;/"

# ── Behavioural assertions ────────────────────────────────────────────────────
# The gate is static, so it cannot see what the formatter RETURNS. These execute it.
# Round two shipped because I tested the gate around the function and never the
# function: YEAR 2026 -> "2,026" was invisible to every static rule.
echo "behaviour: executing the formatter ..."
if run_behaviour; then
  pass=$((pass+1))
else
  echo "BEHAVIOUR FAILED: the formatter does not match the documented policy"; fail=$((fail+1))
fi

# 14. Prove the behavioural suite can FAIL, on a change NO static rule can see.
#     Reverting IDENTIFIER_COLUMN_RE to the leading-token form leaves every
#     constant, predicate and call site intact - the static gate passes - but
#     ZIP_POPULATION stops being grouped. That is the exact false positive the
#     end-anchor was added for, and only executing the function catches it.
expect_behaviour_fail() { # name file sed-expr
  local name="$1" file="$2" expr="$3"
  cp "$file" /tmp/nt.bak
  perl -0pi -e "$expr" "$file"
  if cmp -s /tmp/nt.bak "$file"; then
    echo "INCONCLUSIVE: $name - mutation changed nothing (pattern stale)"; fail=$((fail+1))
  elif run_behaviour >/dev/null 2>&1; then
    echo "NOT CONVICTED: $name - the behavioural suite PASSED on a mutated tree"; fail=$((fail+1))
  else
    echo "convicted (behaviour): $name"; pass=$((pass+1))
  fi
  cp /tmp/nt.bak "$file"
  cmp -s /tmp/nt.bak "$file" || { echo "RESTORE FAILED for $file"; exit 1; }
}

expect_behaviour_fail "identifier regex loses its end anchor (static-invisible)" \
  "$SA/ui/src/lib/format-number.ts" \
  's/\|geoid\)\$\/i;/|geoid)(_|\$)\/i;/'

echo
if [ "$fail" -gt 0 ]; then
  echo "NEGATIVE TESTS FAILED: $pass convicted, $fail not convicted."
  exit 1
fi
echo "All $pass mutations convicted (restoration verified per mutation)."
