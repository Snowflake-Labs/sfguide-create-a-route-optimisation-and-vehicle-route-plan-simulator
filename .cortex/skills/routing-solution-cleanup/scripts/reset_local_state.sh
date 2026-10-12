#!/usr/bin/env bash
#
# routing-solution-cleanup / reset_local_state.sh
#
# Return THIS MACHINE to the state of one that has just cloned the repo: the
# local half of a "full teardown + reinstall" (the Snowflake half is
# references/drop-order.sql). Installed software - docker, node, snow, python,
# crane - is never touched; only state this solution left behind.
#
# Why it exists: a developed checkout reuses state a fresh clone does not have.
# Every deploy step runs `[ -d node_modules ] || npm ci`, so a stale tree masks
# lockfile drift; materialized synapse bundles, .next caches, /tmp logs and
# local images survive too. And three source files once existed ONLY here
# (swallowed by a generic .gitignore rule), so every install "worked" on this
# machine and 404'd on a fresh clone. An install from a reset checkout
# exercises what an external user actually gets.
#
# What it does (dry run unless --yes):
#   gates   refuse if the tracked tree is dirty or has untracked files (a fresh
#           clone has neither), or if check_no_ignored_source.py fails (the
#           reset would delete the only copy of a hidden source file)
#   repo    every gitignored path, classified by its .gitignore RULE:
#             GENERATED -> deleted (node_modules, .next, dist, __pycache__,
#                          synapse _installed/, tsbuildinfo, .DS_Store)
#             PERSONAL  -> LEFT IN PLACE (logs/*.md and *.log run histories,
#                          session plans, docs drafts, eval results, keys).
#                          No tracked script, build or app reads them, so they
#                          cannot change what an install does; moving them
#                          would only cost the user their notes.
#           then empty directories left behind (git does not track them)
#   /tmp    the installer's log/scratch files; a self-check fails if a script
#           writes a /tmp path this list does not cover
#   docker  `docker rmi` every local image of this solution (fleet_intelligence
#           and openrouteservice_app SPCS repos, any account) and `docker
#           logout` the target account's SPCS registry. Other images, the
#           build cache and other logins are untouched.
#
# Usage:
#   bash .cortex/skills/routing-solution-cleanup/scripts/reset_local_state.sh \
#        --connection <conn> [--yes] [--only repo|tmp|docker]
#
# --only limits the run to one area (default: all three). It exists so the repo
# half can be exercised in a scratch clone without touching the machine's real
# /tmp and docker state; a fresh-machine reset always runs all three.
#
# Then reinstall with an empty npm cache and uncached image builds - see
# "Full fresh-machine teardown + reinstall" in ../SKILL.md.
set -euo pipefail

CONNECTION=""
APPLY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--connection) CONNECTION="${2:-}"; shift 2 ;;
    --yes) APPLY=1; shift ;;
    --only) ONLY="${2:-}"; shift 2
            case "$ONLY" in repo|tmp|docker) ;; *) echo "ERROR: --only takes repo, tmp or docker"; exit 2 ;; esac ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'"; exit 2 ;;
  esac
done
[ -n "$CONNECTION" ] || { echo "ERROR: --connection <name> is required (it names the SPCS registry to log out of)"; exit 2; }

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"
IFA_SCRIPTS=".cortex/skills/install-fleet-apps/scripts"
CLASSIFIER="$IFA_SCRIPTS/check_no_ignored_source.py"
MODE="DRY RUN (pass --yes to apply)"; [ "$APPLY" = "1" ] && MODE="APPLY"
FAIL=0
note() { echo "[reset-local-state] $*"; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

note "repo=$REPO_ROOT  connection=$CONNECTION  mode=$MODE"

# ── 1. gates ─────────────────────────────────────────────────────────────────
DIRTY="$(git status --porcelain --untracked-files=all)"
if [ -n "$DIRTY" ]; then
  echo "ERROR: the working tree differs from a fresh clone of $(git branch --show-current):"
  echo "$DIRTY" | sed 's/^/  /' | head -40
  echo "Commit, stash or remove these first - an install from this tree would not be a fresh-clone install."
  exit 1
fi
MANIFEST="$(python3 "$CLASSIFIER" --manifest)" || {
  python3 "$CLASSIFIER" || true
  echo "ERROR: refusing to reset - the files above are source hidden by .gitignore, and deleting them would lose the only copy."
  exit 1
}

# ── 2. /tmp coverage self-check ──────────────────────────────────────────────
# Prefix families plus the exact scratch files the gate scripts write.
TMP_PREFIXES="ifa_ fleet_sa_ fleet_admin_ synapse_"
TMP_EXACT="nt.bak nt.a.bak nt.b.bak nt.out nt_ctl.bak geo_gate_mut.bak render_map_pos.sql render_map_neg.sql"
tmp_covered() { # <basename>
  local p
  for p in $TMP_PREFIXES; do case "$1" in "$p"*) return 0 ;; esac; done
  for p in $TMP_EXACT; do [ "$1" = "$p" ] && return 0; done
  return 1
}
UNCOVERED=""
for lit in $(git ls-files '.cortex/skills/install-fleet-apps/**.sh' '.cortex/skills/install-fleet-apps/**.py' \
               '.cortex/skills/install-fleet-apps/*.sh' '.cortex/skills/routing-agent/**.sh' \
             | grep -v '/node_modules/' | xargs grep -hoE '/tmp/[A-Za-z0-9_.-]+' 2>/dev/null | sort -u); do
  tmp_covered "${lit#/tmp/}" || UNCOVERED="$UNCOVERED ${lit}"
done
if [ -n "$UNCOVERED" ]; then
  echo "ERROR: install scripts write /tmp paths this reset does not clear:$UNCOVERED"
  echo "Add the prefix to TMP_PREFIXES (or the file to TMP_EXACT) in $0."
  exit 1
fi

# ── 3. repo: delete GENERATED, keep PERSONAL ─────────────────────────────────
N_GEN=$(printf '%s\n' "$MANIFEST" | grep -c '^GENERATED' || true)
N_PER=$(printf '%s\n' "$MANIFEST" | grep -c '^PERSONAL' || true)
if want repo; then
note "repo: $N_GEN generated entries to delete; $N_PER personal entries kept in place (nothing reads them)"
printf '%s\n' "$MANIFEST" | awk -F'\t' '$1=="GENERATED"{print $2}' \
  | sed -E 's#^(.*/)?(node_modules|\.next|__pycache__|dist)/$#<\2>#; s#^.*/_installed/.*#<synapse _installed>#; s#^(.*/)?\.DS_Store$#<.DS_Store>#' \
  | sort | uniq -c | sed 's/^/    delete: /'

if [ "$APPLY" = "1" ]; then
  printf '%s\n' "$MANIFEST" | while IFS="$(printf '\t')" read -r cls path _rule; do
    [ "$cls" = "GENERATED" ] || continue
    path="${path%/}"
    # `if`, not `test && rm`: a false test as the loop's last command would make
    # the pipeline fail and, under pipefail + set -e, abort the reset half-way.
    if [ -e "$path" ] || [ -L "$path" ]; then rm -rf -- "$path"; fi
  done
  # git never tracks a directory, so one emptied above is fresh-clone noise.
  find . -path ./.git -prune -o -type d -empty -print | sort -r | while read -r d; do
    rmdir -- "$d" 2>/dev/null || true
  done
fi
fi  # want repo

# ── 4. /tmp ──────────────────────────────────────────────────────────────────
if want tmp; then
TMP_HITS=""
for p in $TMP_PREFIXES; do
  for f in /tmp/"$p"*; do [ -e "$f" ] && TMP_HITS="$TMP_HITS $f"; done
done
for p in $TMP_EXACT; do [ -e "/tmp/$p" ] && TMP_HITS="$TMP_HITS /tmp/$p"; done
# image tarballs a crane push leaks if it is interrupted (mktemp -t => $TMPDIR)
for f in "${TMPDIR:-/tmp}"/orsimg.* "${TMPDIR:-/tmp}"/fleetsaimg.* "${TMPDIR:-/tmp}"/fleetadminimg.*; do
  [ -e "$f" ] && TMP_HITS="$TMP_HITS $f"
done
note "/tmp: $(echo $TMP_HITS | wc -w | tr -d ' ') installer files to delete"
if [ "$APPLY" = "1" ] && [ -n "$TMP_HITS" ]; then
  # shellcheck disable=SC2086
  rm -rf -- $TMP_HITS
fi
fi  # want tmp

# ── 5. docker ────────────────────────────────────────────────────────────────
IMAGE_RE='\.registry\.snowflakecomputing\.com/(fleet_intelligence|openrouteservice_app)/core/image_repository/'
if ! want docker; then
  :
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  IMAGES="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "$IMAGE_RE" || true)"
  N_IMG=$(printf '%s' "$IMAGES" | grep -c . || true)
  OTHER_BEFORE=$(docker images -q | sort -u | wc -l | tr -d ' ')
  HOST="$(snow sql -c "$CONNECTION" --format json -q "ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-routing-solution-cleanup\",\"version\":{\"major\":2,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}'; SELECT LOWER(CURRENT_ORGANIZATION_NAME() || '-' || REPLACE(CURRENT_ACCOUNT_NAME(), '_', '-')) AS H" 2>/dev/null \
          | python3 -c 'import sys,json; print(json.load(sys.stdin)[-1][0]["H"])' 2>/dev/null || true)"
  [ -n "$HOST" ] && HOST="$HOST.registry.snowflakecomputing.com"
  note "docker: $N_IMG solution image tags to remove; registry login to drop: ${HOST:-<could not resolve>}"
  [ -n "$HOST" ] || { echo "ERROR: could not resolve the SPCS registry host for connection '$CONNECTION'"; FAIL=1; }
  if [ "$APPLY" = "1" ]; then
    for ref in $IMAGES; do
      docker rmi "$ref" >/dev/null || { echo "ERROR: docker rmi $ref failed (a container still uses it?)"; FAIL=1; }
    done
    if [ -n "$HOST" ] && python3 -c "import json,os,sys; sys.exit(0 if sys.argv[1] in json.load(open(os.path.expanduser('~/.docker/config.json'))).get('auths',{}) else 1)" "$HOST" 2>/dev/null; then
      docker logout "$HOST" >/dev/null || { echo "ERROR: docker logout $HOST failed"; FAIL=1; }
    fi
    LEFT=$(docker images --format '{{.Repository}}' | grep -cE "$IMAGE_RE" || true)
    [ "$LEFT" = "0" ] || { echo "ERROR: $LEFT solution image tags still present"; FAIL=1; }
    note "docker: unique image ids before=$OTHER_BEFORE after=$(docker images -q | sort -u | wc -l | tr -d ' ')"
  fi
else
  note "docker: daemon not reachable - skipped (nothing of this solution can be cached in it)"
fi

# ── 6. post-condition ────────────────────────────────────────────────────────
# A fresh-clone install sees no GENERATED state and no local change. PERSONAL
# files are allowed to remain: nothing an install runs can read them.
if [ "$APPLY" = "1" ] && want repo; then
  LEFTOVER="$(python3 "$CLASSIFIER" --manifest | awk -F'\t' '$1!="PERSONAL"{print $1"  "$2}')"
  CHANGES="$(git status --porcelain --untracked-files=all)"
  if [ -n "$LEFTOVER" ] || [ -n "$CHANGES" ]; then
    echo "ERROR: the checkout still differs from a fresh clone:"
    { echo "$LEFTOVER"; echo "$CHANGES"; } | sed '/^$/d; s/^/  /' | head -40
    FAIL=1
  else
    note "checkout matches a fresh clone: no generated state, no local change ($N_PER personal entries kept)"
  fi
fi
[ "$FAIL" = "0" ] || exit 1
note "done ($MODE)"
