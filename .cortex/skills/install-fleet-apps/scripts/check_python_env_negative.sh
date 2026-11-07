#!/usr/bin/env bash
#
# check_python_env_negative.sh - each mutation reintroduces one defect into a
# TEMP COPY and check_python_env.sh must fail on it. The real files are never
# touched.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$(cd "$HERE/../.." && pwd)"
GATE="$HERE/check_python_env.sh"
W="$(mktemp -d -t pyenvneg.XXXXXX)"
trap 'rm -rf "$W"' EXIT
SURVIVED=0

# mutate <name> <file-var> <python-replace-expr>
mutate() {
  local name="$1" which="$2" expr="$3" d="$W/$1"
  mkdir -p "$d/lib"
  cp "$HERE/lib/python_env.sh" "$d/lib/python_env.sh"
  cp "$HERE/install_fleet_apps.sh" "$d/install.sh"
  cp "$HERE/preflight_new_account.sh" "$d/preflight.sh"
  cp "$SKILLS/routing-prerequisites/SKILL.md" "$d/prereq.md"
  local f
  case "$which" in
    lib) f="$d/lib/python_env.sh" ;; inst) f="$d/install.sh" ;;
    pre) f="$d/preflight.sh" ;; doc) f="$d/prereq.md" ;;
  esac
  python3 - "$f" "$expr" <<'PY' || { echo "MUTATION $name did not apply"; exit 2; }
import sys
p, expr = sys.argv[1], sys.argv[2]
s = open(p).read()
old, new = expr.split("\x1f")
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
  if LIB="$d/lib/python_env.sh" INSTALLER="$d/install.sh" PREFLIGHT="$d/preflight.sh" PREREQ="$d/prereq.md" \
       bash "$GATE" >"$d/out" 2>&1; then
    echo "SURVIVED: $name"; SURVIVED=$((SURVIVED + 1))
  else
    echo "killed:   $name ($(grep -m1 FAIL "$d/out"))"
  fi
}
S=$'\x1f'

mutate always_venv     lib  "  if _python_env_ok python3; then${S}  if false; then"
mutate no_path_prepend lib  '  PATH="$venv/bin:$PATH"'"${S}"'  :'
mutate pip_unchecked   lib  '      && _python_env_ok "$venv/bin/python3" || {'"${S}"'      || {'
mutate vague_error     lib  'PYTHON_ENV_ERROR="pip install $PYTHON_ENV_PKGS into $venv failed'"${S}"'PYTHON_ENV_ERROR="pip failed'
mutate inst_no_call    inst 'ensure_python_env || { echo "ERROR: $PYTHON_ENV_ERROR"; exit 1; }'"${S}"':'
mutate inst_late_call  inst 'ensure_python_env || { echo "ERROR: $PYTHON_ENV_ERROR"; exit 1; }'"${S}"'python3 "$SCRIPTS/x.py"
ensure_python_env || { echo "ERROR: $PYTHON_ENV_ERROR"; exit 1; }'
mutate pre_ungated     pre  'if [ "$PY_READY" = "0" ]; then
  warn "listing probe skipped: python packages unavailable (see [1])"
elif [ "$CHECK_LISTINGS" = "1" ]; then'"${S}"'if [ "$CHECK_LISTINGS" = "1" ]; then'
mutate pre_no_call     pre  'if ensure_python_env; then'"${S}"'if true; then'
mutate pre_late_call   pre  'PY_READY=0
if ensure_python_env; then'"${S}"'python3 "$(dirname "$0")/x.py"
PY_READY=0
if ensure_python_env; then'
mutate doc_global_pip  doc  '- **Packages:** nothing to do.'"${S}"'- **Packages:** `python3 -m pip install pyyaml snowflake-connector-python requests`'

if [ "$SURVIVED" -gt 0 ]; then echo "python_env negative: $SURVIVED mutation(s) survived"; exit 1; fi
echo "python_env negative: all 10 mutations killed"
