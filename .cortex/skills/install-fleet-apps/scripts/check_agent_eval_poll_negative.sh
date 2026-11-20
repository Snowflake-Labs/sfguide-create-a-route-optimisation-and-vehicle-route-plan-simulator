#!/usr/bin/env bash
#
# check_agent_eval_poll_negative.sh - each mutation brings back one defect of the
# baseline poll in a TEMP COPY of setup_agent_evals.sh; check_agent_eval_poll.sh
# must fail on every one. The real script is never touched.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check_agent_eval_poll.sh"
W="$(mktemp -d -t evalpollneg.XXXXXX)"
trap 'rm -rf "$W"' EXIT
SURVIVED=0
S=$'\x1f'

# mutate <name> <old\x1fnew> <expected gate message>
mutate() {
  local name="$1" expr="$2" expect="$3" f="$W/$1.sh"
  cp "$HERE/setup_agent_evals.sh" "$f"
  python3 - "$f" "$expr" <<'PY' || { echo "MUTATION $name did not apply"; exit 2; }
import sys
p, expr = sys.argv[1], sys.argv[2]
s = open(p).read()
old, new = expr.split("\x1f")
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
  if SCRIPT="$f" bash "$GATE" >"$W/$name.out" 2>&1; then
    echo "SURVIVED: $name"; SURVIVED=$((SURVIVED + 1))
  elif ! grep -q "$expect" "$W/$name.out"; then
    echo "SURVIVED: $name (failed for the wrong reason: $(grep -m1 FAIL "$W/$name.out"))"; SURVIVED=$((SURVIVED + 1))
  else
    echo "killed:   $name"
  fi
}

mutate exit_zero      '  exit 1
fi'"$S"'fi' "failed run: rc=0"
mutate raw_start_echo '  printf '"'"'%s\n'"'"' "$out" >>"$EVAL_RUN_LOG"'"$S"'  echo "$out" | tail -5' "raw snow table output"
mutate blind_heartbeat '    note "  $agent ${st:-starting} ($(( (SECONDS - t0) / 60 )) min)"'"$S"'    note "  $agent still running ..."' "heartbeat lacks status"
mutate failed_not_counted '      note "  $agent FAILED: $st after $(( (SECONDS - t0) / 60 )) min (details: $EVAL_RUN_LOG)"
      EVAL_FAILS=$((EVAL_FAILS + 1)) ;;'"$S"'      note "  $agent FAILED: $st after $(( (SECONDS - t0) / 60 )) min (details: $EVAL_RUN_LOG)" ;;' "failed run: rc=0"
mutate silent_giveup  '      note "  $agent still ${st:-unknown} after ${EVAL_POLL_MINS} min - stopped waiting (it keeps running server-side; raise EVAL_POLL_MINS)"'"$S"'      :' "gave up without saying so"
# Cycle-5 defect seen on TIB: substring COMPLETED stopped at INVOCATION_COMPLETED.
mutate substring_completed '      COMPLETED) break ;;'"$S"'      *COMPLETED*) break ;;' "before the judges scored"
mutate partial_is_success '    COMPLETED)
      note'"$S"'    COMPLETED|PARTIALLY_COMPLETED)
      note' "partially completed run: rc=0"
# Also seen on TIB: one PARTIALLY_COMPLETED read, then COMPLETED.
mutate no_settle '        [ "$bad" -ge "$EVAL_SETTLE_POLLS" ] && break'"$S"'        break' "transient PARTIALLY_COMPLETED reported as a failure"

# Real multi-statement CSV ends in a blank line, and the tagged call puts preamble
# result sets first: both parse forms below read an empty STATUS on real output.
mutate blank_line_wins 'c && NF {v=$c}'"$S"'c {v=$c}' "completed run: rc="
mutate first_line_header '/^RUN_NAME,/ {c=0; for (i=1;i<=NF;i++) if ($i=="STATUS") c=i; next} c && NF {v=$c} END {print v}'"$S"'NR==1 {for (i=1;i<=NF;i++) if ($i=="STATUS") c=i; next} c {print $c; exit}' "completed run: rc="

# Cycle-5 defect: one dropped STATUS connection killed the script under set -e.
mutate dropped_poll_kills $'END {print v}\' || true)\x1fEND {print v}\')' "one dropped STATUS poll killed the script"

if [ "$SURVIVED" -gt 0 ]; then echo "agent_eval_poll negative: $SURVIVED mutation(s) survived"; exit 1; fi
echo "agent_eval_poll negative: all 11 mutations killed"
