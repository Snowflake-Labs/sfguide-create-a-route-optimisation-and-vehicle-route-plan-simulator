#!/usr/bin/env bash
#
# install-fleet-apps / lib/python_env.sh  (sourced, not executed)
#
# Guarantees the installer's Python helpers can import their three packages
# (PyYAML, snowflake-connector-python, requests) on a machine where the user
# cannot `pip install` into python3 at all. Homebrew Python (3.12+) is
# "externally managed" under PEP 668 and rejects a global `pip install`, so the
# documented remedy failed and the first python3 helper (prepare_overture.py)
# died with "No module named 'snowflake'", which preflight then reported as
# "Overture source capability could not be checked".
#
#   ensure_python_env [--no-create]
#     If python3 already imports all three, does nothing. Otherwise uses (or,
#     unless --no-create, creates) the repo-root .venv, installs the packages
#     there, and prepends .venv/bin to PATH so every child script's bare
#     `python3` resolves to it. .venv/ is GENERATED (check_no_ignored_source.py),
#     so reset_local_state.sh removes it and a fresh clone starts without one.
#     Returns 1 with PYTHON_ENV_ERROR set when it cannot provide the packages.

PYTHON_ENV_PKGS="pyyaml snowflake-connector-python requests"
PYTHON_ENV_IMPORTS="import yaml, snowflake.connector, requests"

_python_env_ok() { "$1" -c "$PYTHON_ENV_IMPORTS" >/dev/null 2>&1; }

ensure_python_env() {
  local create=1 root venv
  [ "${1:-}" = "--no-create" ] && create=0
  PYTHON_ENV_ERROR=""
  PYTHON_ENV_SOURCE=""

  if _python_env_ok python3; then
    PYTHON_ENV_SOURCE="python3 ($(command -v python3))"
    return 0
  fi

  # git first: BASH_SOURCE is empty when sourced from zsh, which resolved "/".
  root="${PYTHON_ENV_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
  [ -n "$root" ] || root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
  [ -n "$root" ] && [ "$root" != "/" ] || { PYTHON_ENV_ERROR="cannot locate the repo root for .venv"; return 1; }
  venv="$root/.venv"

  if [ ! -x "$venv/bin/python3" ]; then
    if [ "$create" = 0 ]; then
      PYTHON_ENV_ERROR="python3 lacks $PYTHON_ENV_PKGS; the installer creates $venv with them"
      return 1
    fi
    python3 -m venv "$venv" >/dev/null 2>&1 || {
      PYTHON_ENV_ERROR="python3 -m venv $venv failed (install a full Python 3, e.g. 'brew install python')"
      return 1
    }
  fi

  if ! _python_env_ok "$venv/bin/python3"; then
    if [ "$create" = 0 ]; then
      PYTHON_ENV_ERROR="$venv exists but lacks $PYTHON_ENV_PKGS; the installer installs them"
      return 1
    fi
    # One retry: a transient index/network failure was seen once and would
    # otherwise abort the whole install at step 0.
    # shellcheck disable=SC2086
    { "$venv/bin/python3" -m pip install -q --disable-pip-version-check $PYTHON_ENV_PKGS >/dev/null 2>&1 \
      || "$venv/bin/python3" -m pip install -q --disable-pip-version-check $PYTHON_ENV_PKGS >/dev/null 2>&1; } \
      && _python_env_ok "$venv/bin/python3" || {
        PYTHON_ENV_ERROR="pip install $PYTHON_ENV_PKGS into $venv failed (network or proxy?); retry with: $venv/bin/python3 -m pip install $PYTHON_ENV_PKGS"
        return 1
      }
  fi

  # No dedupe needed: a second call finds python3 resolving into the .venv and
  # returns at the first check.
  PATH="$venv/bin:$PATH"
  export PATH VIRTUAL_ENV="$venv"
  PYTHON_ENV_SOURCE="$venv"
  return 0
}
