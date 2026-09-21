#!/usr/bin/env bash
# check_semantic_verdict_negative.sh - negative tests for install_fleet_apps.sh's
# semantic_optional_verdict classifier.
#
# WHY THIS EXISTS
#
# SV_OFFERS was broken by a one-line syntax error - a DIMENSIONS entry with its
# name and its source expression the wrong way round - and stayed broken. The
# view never existed in any account. Nothing reported a problem, because the
# installer mapped EVERY non-zero exit of semantic_views_marketplace.sql to
#
#     NOTE: SV_OFFERS skipped - FLEET_INTELLIGENCE.MARKETPLACE not present yet
#           (expected on a fresh install)
#
# That attribution was unconditional. A permanent defect and a fresh-install
# ordering skip produced byte-identical output, so a real compile error read as
# expected behaviour on every single install.
#
# The fix decides the verdict from the LOG. This file is what stops that decision
# from silently regressing to a constant: case 2 below IS the SV_OFFERS failure,
# and the pre-fix code fails it (verified: the unconditional form fails 4 of 5
# cases here, this one included).
#
# A static gate was tried first and REJECTED by its own evidence. The rule was
# "a bare-identifier RHS must not contain the dimension name", which is exactly
# the SV_OFFERS shape - but it flagged 7 legitimate entries on the current tree
# and 0 real defects. `sessions.h3_cell AS H3_CELL_R7` deploys and returns rows:
# H3_CELL_R7 is the real column and the shorter name is the author's choice, so
# containment in either direction is legal and no static rule can separate the
# two. Verifying the RHS names a real column needs the live table, which is the
# deploy's job. So the deploy is the oracle, and this test keeps the deploy
# honest about what it found.

set -uo pipefail

# scripts/ -> install-fleet-apps/ -> skills/ -> .cortex/ -> repo root. Four levels,
# not three: an off-by-one here made an earlier gate in this repo inspect zero
# files and pass, which is why the empty-extract guard below is a hard failure.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
INSTALLER="$REPO/.cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Source the function from the installer itself rather than restating it, so this
# test cannot pass against a copy that has drifted from what actually ships.
sed -n '/^  semantic_optional_verdict() {$/,/^  }$/p' "$INSTALLER" > "$TMP/fn.sh"
if [ ! -s "$TMP/fn.sh" ]; then
  echo "FAILED: semantic_optional_verdict not found in $INSTALLER"
  echo "  Either it was renamed or removed. If the conditional verdict is gone,"
  echo "  the SV_OFFERS class of defect is invisible again - read the header."
  exit 1
fi

note() { echo "$*"; }
STEP_STATUS=()
step() { STEP_STATUS+=("$1|$2"); }
# shellcheck source=/dev/null
. "$TMP/fn.sh"

verdict() {
  STEP_STATUS=()
  semantic_optional_verdict "L" "$1" "hint" >/dev/null 2>&1
  echo "${STEP_STATUS[0]#L|}"
}

fails=0
checked=0
assert() { # label expected actual
  checked=$((checked + 1))
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 -> $3"
  else
    echo "  FAIL $1 -> got '$3', want '$2'"
    fails=$((fails + 1))
  fi
}

# 1. Fresh install, source layer not built yet. This is the ONE case that is
#    genuinely expected and must stay SKIPPED, or the gate is just noise.
printf "002003 (02000): SQL compilation error:\nObject 'FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED' does not exist or not authorized.\n" > "$TMP/missing"
assert "missing source object" SKIPPED "$(verdict "$TMP/missing")"

# 2. THE REGRESSION. Verbatim shape of the SV_OFFERS failure.
printf "000904 (42000): SQL compilation error: error line 76 at position 4\ninvalid identifier 'LANE_VEHICLE_EQUIPMENT'\n" > "$TMP/invalid_ident"
assert "invalid identifier (the SV_OFFERS defect)" FAILED "$(verdict "$TMP/invalid_ident")"

# 3. Any other definition error is equally a defect.
printf "001003 (42000): SQL compilation error:\nsyntax error line 12 at position 6 unexpected ','.\n" > "$TMP/syntax"
assert "syntax error" FAILED "$(verdict "$TMP/syntax")"

# 4. Empty log - snow sql died before emitting. Must not be read as expected.
: > "$TMP/empty"
assert "empty log" FAILED "$(verdict "$TMP/empty")"

# 5. These files DEPLOY prose (COMMENT, AI_SQL_GENERATION), so words like
#    'error', 'invalid' and 'does not exist' can appear in the log as the text
#    being created rather than as a diagnostic. The classifier requires the full
#    'does not exist or not authorized', which no such prose has carried; this
#    case pins that. It is a real residual risk, not a proof of immunity - a
#    COMMENT containing the whole phrase would mask a defect.
printf "SQL compilation error:\ninvalid identifier 'X'\nCOMMENT = 'use this when the route does not exist'\n" > "$TMP/prose"
assert "deployed prose containing 'does not exist'" FAILED "$(verdict "$TMP/prose")"

echo
if [ "$checked" -eq 0 ]; then
  echo "FAILED: 0 cases ran - this test inspected nothing."
  exit 1
fi
if [ "$fails" -eq 0 ]; then
  echo "PASSED: $checked/$checked verdict classifications correct."
  exit 0
fi
echo "FAILED: $fails of $checked case(s). A constant verdict cannot tell a"
echo "  fresh-install ordering skip from a broken view definition."
exit 1
