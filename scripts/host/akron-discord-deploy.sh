#!/usr/bin/env bash
# Pulls the bot image the Deploy workflow publishes for main and recreates the
# container when it changed. Runs every few minutes from akron-discord-deploy.timer.
#
# Before switching it snapshots the database to data/akron-discord-pre-deploy.sqlite
# (one file, replaced each deploy). If the new container does not report ready
# within two minutes it restores the previous image, records the bad image ID so
# later runs skip it instead of flapping, and exits non-zero so OnFailure= alerts.
set -euo pipefail

dir=/home/ubuntu/akron-discord
image=ghcr.io/microck/akron-discord:main
container=akron-discord-akron-discord-1
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
    if curl -fsS --max-time 5 http://127.0.0.1:3005/health 2>/dev/null | grep -q '"ready":true'; then
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
  docker tag "$current_id" akron-discord:previous
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
  docker tag akron-discord:previous "$image"
  docker compose -f compose.json up -d
  wait_ready || echo "previous image did not report ready either" >&2
fi
exit 1
