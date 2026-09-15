#!/usr/bin/env bash
# check_backload_memo_negative.sh - prove check_backload_memo.py actually STOPS
# the defect it claims to guard. A gate never observed to fail is documentation.
#
# Each mutation is a form the fix could plausibly regress into. Two are included
# specifically because they are the shapes that have false-passed prose and
# selector rules in this repo before:
#   M7 - restores the flat A->B summary while LEAVING all the new chain text in
#        place, so every keyword rule still finds its keyword.
#   M8 - satisfies "final dropoff" wording in the agent spec from a NEIGHBOURING
#        bullet rather than the query_backload one.
set -uo pipefail

cd "$(dirname "$0")/.."
GATE="scripts/check_backload_memo.py"
VIEW="fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx"
HELPERS="fleet_sa_app/ui/src/components/views/areas/backload-matching/helpers.ts"
PACK="fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json"
MD="fleet_sa_app/app/cowork_skills/backload_matching/SKILL.md"
SPEC="fleet_sa_app/app/agent-spec.json"

TMP="$(mktemp -d)"
trap 'for f in "$VIEW" "$HELPERS" "$PACK" "$MD" "$SPEC"; do [ -f "$TMP/$(basename "$f")" ] && cp "$TMP/$(basename "$f")" "$f"; done; rm -rf "$TMP"' EXIT
for f in "$VIEW" "$HELPERS" "$PACK" "$MD" "$SPEC"; do cp "$f" "$TMP/$(basename "$f")"; done

pass=0; fail=0

# Baseline: the gate must PASS on the real tree, or nothing below means anything.
if python3 "$GATE" >/dev/null 2>&1; then
  echo "PASS baseline: gate passes on the unmutated tree"; pass=$((pass+1))
else
  echo "FAIL baseline: gate does not pass on the unmutated tree - every result below is meaningless"
  python3 "$GATE"; exit 1
fi

restore() { for f in "$VIEW" "$HELPERS" "$PACK" "$MD" "$SPEC"; do cp "$TMP/$(basename "$f")" "$f"; done; }

# convict <id> <expected-rule-letter> <description>
convict() {
  local id="$1" want="$2" desc="$3" out rc
  out="$(python3 "$GATE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL $id: gate PASSED on a broken tree ($desc)"; fail=$((fail+1))
  elif echo "$out" | grep -q "FAILED \[$want"; then
    echo "PASS $id: rule $want convicted - $desc"; pass=$((pass+1))
  else
    echo "FAIL $id: gate failed but NOT via rule $want ($desc)"; echo "$out" | sed 's/^/      /'; fail=$((fail+1))
  fi
  restore
}

# M1 (A) memo stops deriving from STOPS.
perl -0pi -e 's/describeTourChain\(a\.STOPS, MAX_CHAIN_STOPS\)/describeTourChain(undefined, MAX_CHAIN_STOPS)/' "$VIEW"
convict M1 A "memo no longer reads a.STOPS"

# M2 (B) load ids dropped from the memo.
perl -0pi -e 's/tour\.loadIds\.length > 1/false/' "$VIEW"
perl -0pi -e 's/CHAINED tour, \$\{tour\.loadIds\.length\} loads \$\{tour\.loadIds\.join\(. then .\)\}/tour/' "$VIEW"
convict M2 B "multi-load branch and CHAINED label removed"

# M3 (C) destination points at hop 1 - the original defect, exactly.
perl -0pi -e 's/const lastDrop = drops\.length \? drops\[drops\.length - 1\] : undefined;/const lastDrop = drops.length ? drops[0] : undefined;/' "$HELPERS"
convict M3 C "finalDropoff reads the FIRST dropoff"

# M4 (D) placeholder token set gutted.
perl -0pi -e "s/'origin', 'destination', 'drop-off', 'dropoff', 'unknown', 'depot',/'origin',/" "$HELPERS"
convict M4 D "5 of 6 placeholder tokens removed"

# M5 (D) scrub dropped from the memo drops list only - helpers still scrubs.
perl -0pi -e 's/\.map\(\(s\) => realPlace\(s\.city\) \?\? \(s\.offerId \? `unnamed site for \$\{s\.offerId\}` : null\)\)/.map((s) => s.city)/' "$VIEW"
convict M5 D "drops list stops scrubbing while the chain text still does"

# M6 (E) stale generated artifact: source correct, SKILL.md reverted.
perl -0pi -e 's/SEVERAL LOADS/several loads (stale)/g; s/more than one load/one load/g' "$MD"
convict M6 E "SKILL.md stale relative to pack-views.json"

# M7 (A) THE FALSE-PASS SHAPE: flat summary restored ALONGSIDE the chain text,
# so every keyword rule still finds its keyword and only the ban catches it.
perl -0pi -e 's/first pickup \$\{origin\} -> final dropoff \$\{dest\}/\$\{a.PICKUP_CITY || .?.\}->\$\{a.PROPOSAL_DROPOFF_CITY || .?.\} first pickup \$\{origin\} -> final dropoff \$\{dest\}/' "$VIEW"
convict M7 A "flat PICKUP_CITY->PROPOSAL_DROPOFF_CITY summary re-added next to the chain"

# M8 (F) THE OTHER FALSE-PASS SHAPE: the rule text moved out of the
# query_backload bullet into a neighbouring one.
python3 - "$SPEC" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
o = d["instructions"]["orchestration"]
moved = (" ONE ON-SCREEN TRIP MAY CARRY SEVERAL LOADS: a memo entry marked CHAINED tour visits its "
         "loads in sequence, so the FIRST dropoff is a handover where the next load is collected and "
         "the FINAL dropoff is the destination.")
assert moved in o, "mutation anchor not found"
o = o.replace(moved, "", 1)
# re-attach to the NEXT bullet instead (query_offers), same string, wrong place
o = o.replace("-> query_offers", "-> query_offers." + moved, 1)
d["instructions"]["orchestration"] = o
json.dump(d, open(p, "w"), indent=2)
PY
convict M8 F "multi-load rule moved to a neighbouring bullet"

# M9 (C) reachability: lastDrop still last, but finalDropoff stops using it.
perl -0pi -e 's/finalDropoff: lastDrop \? site\(lastDrop\) : null,/finalDropoff: firstPick ? site(firstPick) : null,/' "$HELPERS"
convict M9 C "finalDropoff no longer fed by lastDrop"

# M10 (B) distinct-load accumulation widened to push duplicates.
perl -0pi -e 's/if \(s\.offerId && !loadIds\.includes\(s\.offerId\)\) loadIds\.push\(s\.offerId\);/if (s.offerId) loadIds.push(s.offerId);/' "$HELPERS"
convict M10 B "loadIds no longer deduped, so a 1-load tour reads as 2"

echo
echo "convicted $pass, unconvicted $fail"
[ "$fail" -eq 0 ] || exit 1
