#!/usr/bin/env bash
#
# check_python_env.sh
#
# Pins the fix for a fresh-Mac install that died at its first Python helper:
# Homebrew python3 lacked snowflake-connector-python, the documented
# `python3 -m pip install ...` is refused under PEP 668, and preflight reported
# the resulting ImportError as "Overture source capability could not be checked".
#
# Behavioural (fake python3 on PATH) for lib/python_env.sh, plus static checks
# that the installer provides the packages BEFORE its first python3 helper, that
# preflight stays read-only (--no-create) and that the prerequisite doc no longer
# prescribes a global pip install. Paths are overridable for the negative test:
#   LIB INSTALLER PREFLIGHT PREREQ
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$(cd "$HERE/../.." && pwd)"
LIB="${LIB:-$HERE/lib/python_env.sh}"
INSTALLER="${INSTALLER:-$HERE/install_fleet_apps.sh}"
PREFLIGHT="${PREFLIGHT:-$HERE/preflight_new_account.sh}"
PREREQ="${PREREQ:-$SKILLS/routing-prerequisites/SKILL.md}"
FAILS=0
bad() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

# fake_python <dir> : python3 whose imports succeed only when $FAKE_HAS=1 or,
# for a venv copy, once its own pip install marker exists.
fake_python() {
  local bin="$1/bin"
  mkdir -p "$bin"
  cat >"$bin/python3" <<'EOF'
#!/usr/bin/env bash
self_dir="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  -c)
    [ "${FAKE_HAS:-0}" = 1 ] && [ "$self_dir" = "$FAKE_SYS_BIN" ] && exit 0
    [ -f "$self_dir/.pkgs" ] && exit 0
    exit 1 ;;
  -m)
    case "$2" in
      venv) mkdir -p "$3/bin"; cp "$0" "$3/bin/python3"; exit 0 ;;
      pip)  [ "${FAKE_PIP_FAIL:-0}" = 1 ] && exit 1
            [ "${FAKE_PIP_FAIL:-0}" = 2 ] && exit 0
            touch "$self_dir/.pkgs"; exit 0 ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$bin/python3"
}

# run_case <name> <FAKE_HAS> <FAKE_PIP_FAIL> <arg>  -> prints rc|source|first python3|PATH head
run_case() {
  local w="$1" has="$2" pipfail="$3" arg="$4"
  rm -rf "$w"; mkdir -p "$w/sys" "$w/root"
  fake_python "$w/sys"
  FAKE_HAS="$has" FAKE_PIP_FAIL="$pipfail" FAKE_SYS_BIN="$w/sys/bin" PYTHON_ENV_ROOT="$w/root" \
  PATH="$w/sys/bin:/usr/bin:/bin" bash -c '
    source "$1"
    ensure_python_env $2; rc=$?
    ensure_python_env $2 >/dev/null 2>&1
    n=$(printf "%s" "$PATH" | tr ":" "\n" | grep -c "/root/.venv/bin" || true)
    printf "%s|%s|%s|%s|%s\n" "$rc" "$(command -v python3)" "$n" "$PYTHON_ENV_ERROR" "${PATH%%:*}"
  ' _ "$LIB" "$arg"
}

W="$(mktemp -d -t pyenv.XXXXXX)"
trap 'rm -rf "$W"' EXIT

# 1. python3 already has the packages: no venv, PATH untouched.
IFS='|' read -r rc py n err head <<<"$(run_case "$W/c1" 1 0 "")"
[ "$rc" = 0 ] || bad "packages present: rc=$rc ($err)"
[ ! -e "$W/c1/root/.venv" ] || bad "packages present: created .venv anyway"
[ "$py" = "$W/c1/sys/bin/python3" ] || bad "packages present: python3 rerouted to $py"

# 2. missing: venv created, packages installed, python3 resolves into it, once.
IFS='|' read -r rc py n err head <<<"$(run_case "$W/c2" 0 0 "")"
[ "$rc" = 0 ] || bad "missing: rc=$rc ($err)"
[ "$py" = "$W/c2/root/.venv/bin/python3" ] || bad "missing: python3 is $py, not the .venv"
[ "$n" = 1 ] || bad "missing: .venv/bin on PATH $n times after two calls"

# 3. pip fails: rc 1, message names the packages and the venv.
IFS='|' read -r rc py n err head <<<"$(run_case "$W/c3" 0 1 "")"
[ "$rc" = 1 ] || bad "pip failure: rc=$rc, expected 1"
case "$err" in *snowflake-connector-python*"$W/c3/root/.venv"*) ;; *) bad "pip failure message lacks packages/venv: '$err'" ;; esac
[ "$n" = 0 ] || bad "pip failure: broken .venv put on PATH"

# 3b. pip exits 0 but the packages still do not import: must not report success.
IFS='|' read -r rc py n err head <<<"$(run_case "$W/c3b" 0 2 "")"
[ "$rc" = 1 ] || bad "pip rc 0 without importable packages: rc=$rc, expected 1"

# 4. --no-create (preflight): no venv created, rc 1 with a reason.
IFS='|' read -r rc py n err head <<<"$(run_case "$W/c4" 0 0 "--no-create")"
[ "$rc" = 1 ] || bad "--no-create: rc=$rc, expected 1"
[ ! -e "$W/c4/root/.venv" ] || bad "--no-create: created .venv (preflight must not change state)"
[ -n "$err" ] || bad "--no-create: no PYTHON_ENV_ERROR"

# 5. installer: sources the lib and calls ensure_python_env (creating) before the
#    first executable python3 line after the toolchain loop.
src_ln=$(grep -nE '^[[:space:]]*source .*lib/python_env\.sh' "$INSTALLER" | head -1 | cut -d: -f1)
call_ln=$(grep -nE '^[[:space:]]*ensure_python_env( |$)' "$INSTALLER" | grep -v -- '--no-create' | head -1 | cut -d: -f1)
py_ln=$(grep -nE '^[^#]*python3 ["$]' "$INSTALLER" | head -1 | cut -d: -f1)
if [ -z "$src_ln" ] || [ -z "$call_ln" ]; then
  bad "installer does not source lib/python_env.sh and call ensure_python_env"
elif [ -n "$py_ln" ] && [ "$call_ln" -gt "$py_ln" ]; then
  bad "installer runs python3 (line $py_ln) before ensure_python_env (line $call_ln)"
fi

# 6. preflight: read-only call, and Python probes gated on it.
grep -qE 'ensure_python_env --no-create' "$PREFLIGHT" || bad "preflight does not call ensure_python_env --no-create"
grep -nE '^[[:space:]]*(if )?ensure_python_env' "$PREFLIGHT" | grep -qv -- '--no-create' \
  && bad "preflight calls ensure_python_env without --no-create (would create .venv)"
awk '
  { buf[NR % 7] = $0 }
  /^[^#]*python3 "/ {
    ok = 0
    for (i = 1; i <= 6; i++) if (buf[(NR - i) % 7] ~ /PY_READY/) ok = 1
    if (!ok) { print "line " NR ": " $0; bad = 1 }
  }
  END { exit bad }' "$PREFLIGHT" >/dev/null || bad "preflight runs a python3 helper not guarded by PY_READY"

# 7. prerequisite doc: no global pip install of the three packages.
grep -nE 'pip3? install[^`]*(snowflake-connector-python|pyyaml)' "$PREREQ" | grep -viE 'do not|venv/bin' \
  && bad "routing-prerequisites/SKILL.md still prescribes a global pip install"

if [ "$FAILS" -gt 0 ]; then echo "python_env: $FAILS failure(s)"; exit 1; fi
echo "python_env: OK (6 behavioural cases, installer order, preflight read-only, doc)"
