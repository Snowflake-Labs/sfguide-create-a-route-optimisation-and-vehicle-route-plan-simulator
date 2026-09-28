#!/usr/bin/env bash
# One full SA + CoWork regression pass over every synthetic dataset region.
#   1. validate_app_views.py - every app-views.json panel / filter / map layer,
#      render pass then selection pass, per region (page load + selector picks)
#   2. run_verbs.py          - custom pages' buttons, /api/tool + /api/ops verbs,
#      show_view / deep_link for every view, per region
#   3. run_agent.py          - one question per CoWork skill on the SA agent and
#      the CoWork super agent, per region; every emitted map layer is executed
# Usage: scripts/sa_regression/run_pass.sh <connection> <pass-name>
set -uo pipefail
CONN=${1:?connection}
PASS=${2:?pass name}
ROOT=$(git rev-parse --show-toplevel)
OUT="$ROOT/logs/sa_regression/$PASS"
mkdir -p "$OUT"
REGIONS="SanFrancisco UsTexas UnitedStatesOfAmerica"

python3 -u "$ROOT/.cortex/skills/install-fleet-apps/scripts/validate_app_views.py" -c "$CONN" \
  --report "$OUT/views.json" > "$OUT/views.log" 2>&1 &
for r in $REGIONS; do
  python3 -u "$ROOT/scripts/sa_regression/run_verbs.py" -c "$CONN" --region "$r" --workers 6 \
    --report "$OUT/verbs_$r.json" > "$OUT/verbs_$r.log" 2>&1 &
  python3 -u "$ROOT/scripts/sa_regression/run_agent.py" -c "$CONN" --region "$r" --workers 5 \
    --report "$OUT/agent_$r.json" > "$OUT/agent_$r.log" 2>&1 &
done
wait
echo "pass $PASS done: $OUT"
