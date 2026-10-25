# Retry `npm ci` / `npm install` on failure. Sourced by every install script that
# fetches packages; defines an `npm` shell function, which `( cd ... && npm ci )`
# subshells inherit, so call sites need no change.
#
# Why: a single ECONNRESET ("npm error network aborted") from the registry in the
# SA app's fleet-kit `npm ci` failed the deploy and aborted a fresh install 69
# minutes in (wgb26798, 2026-10-25). npm's own fetch-retries did not cover an
# aborted socket. Deterministic failures retry too; that costs under a minute
# and the last attempt's output is what the caller reports.
NPM_RETRY_ATTEMPTS="${NPM_RETRY_ATTEMPTS:-3}"
NPM_RETRY_DELAY="${NPM_RETRY_DELAY:-10}"
npm() {
  case "${1:-}" in
    ci|install) ;;
    *) command npm "$@"; return ;;
  esac
  local i=1 rc=0
  while :; do
    command npm "$@" && return 0
    rc=$?
    [ "$i" -ge "$NPM_RETRY_ATTEMPTS" ] && return "$rc"
    echo "npm $1 failed (rc=$rc, attempt $i/$NPM_RETRY_ATTEMPTS) in $PWD - retrying in $((i * NPM_RETRY_DELAY))s" >&2
    sleep $((i * NPM_RETRY_DELAY))
    i=$((i + 1))
  done
}
