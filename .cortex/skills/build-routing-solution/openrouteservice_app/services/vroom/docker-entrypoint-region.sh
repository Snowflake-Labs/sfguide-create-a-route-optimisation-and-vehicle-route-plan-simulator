#!/usr/bin/env bash
# Region-aware VROOM entrypoint.
# Substitutes __ORS_HOST__ in /conf/config.yml with the ORS_HOST env var so the
# same image can serve any provisioned region (ors-service-<region>) without a
# rebuild. Falls back to the legacy global hostname (ors-service) when ORS_HOST
# is unset.
set -e
TARGET_HOST="${ORS_HOST:-ors-service}"
if [ -f /conf/config.yml ]; then
  sed -i "s|__ORS_HOST__|${TARGET_HOST}|g" /conf/config.yml
fi
exec bash /docker-entrypoint.sh "$@"
