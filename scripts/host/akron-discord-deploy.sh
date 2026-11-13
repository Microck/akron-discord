#!/usr/bin/env bash
# Pulls the bot image the Deploy workflow publishes for main and recreates the
# container when it changed. Runs every few minutes from akron-discord-deploy.timer.
#
# Before switching it snapshots the database to data/akron-discord-pre-deploy.sqlite
# (one file, replaced each deploy). If the new container does not report ready
# within two minutes it restores the previous image, records the bad image ID so
# later runs skip it instead of flapping, and exits non-zero so OnFailure= alerts.
set -euo pipefail

# Production defaults. The overrides exist so the rollback path can be exercised
# against a disposable compose project and registry instead of the live bot.
dir="${AKRON_DEPLOY_DIR:-/home/ubuntu/akron-discord}"
image="${AKRON_DEPLOY_IMAGE:-ghcr.io/microck/akron-discord:main}"
container="${AKRON_DEPLOY_CONTAINER:-akron-discord-akron-discord-1}"
health_url="${AKRON_DEPLOY_HEALTH_URL:-http://127.0.0.1:3005/health}"
# Local-only tag that keeps the last running image for rollback; derived from the
# image so a test target never overwrites the production rollback image.
previous_tag="${image%:*}:previous"
failed_marker="$dir/data/.failed-image"
cd "$dir"

docker pull -q "$image" >/dev/null
new_id="$(docker image inspect -f '{{.Id}}' "$image")"
current_id="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)"

[ "$new_id" = "$current_id" ] && exit 0
if [ -f "$failed_marker" ] && [ "$(cat "$failed_marker")" = "$new_id" ]; then
  exit 0
fi

wait_ready() {
  for _ in $(seq 1 24); do
    if curl -fsS --max-time 5 "$health_url" 2>/dev/null | grep -q '"ready":true'; then
      return 0
    fi
    sleep 5
  done
  return 1
}

if [ -n "$current_id" ]; then
  docker exec "$container" node -e \
    "require('better-sqlite3')('/app/data/akron-discord.sqlite',{readonly:true}).backup('/app/data/akron-discord-pre-deploy.sqlite')"
  chmod 600 data/akron-discord-pre-deploy.sqlite
  docker tag "$current_id" "$previous_tag"
fi

echo "deploying ${new_id} (was ${current_id:-none})"
docker compose -f compose.json up -d
if wait_ready; then
  rm -f "$failed_marker"
  docker image prune -f >/dev/null
  echo "deployed ${new_id}"
  exit 0
fi

echo "${new_id} did not report ready; rolling back" >&2
printf '%s' "$new_id" > "$failed_marker"
if [ -n "$current_id" ]; then
  docker tag "$previous_tag" "$image"
  docker compose -f compose.json up -d
  wait_ready || echo "previous image did not report ready either" >&2
fi
exit 1
