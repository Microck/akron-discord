#!/usr/bin/env bash
# Posts a failed systemd unit to #bot-alerts. Runs from akron-discord-alert@.service,
# which the deploy and off-host backup units name in OnFailure=. It posts as the
# bot through the REST API so it still works when the bot container is down.
# Needs /etc/akron-discord/alert.env with DISCORD_TOKEN and DISCORD_ALERT_CHANNEL_ID.
set -euo pipefail

unit="${1:?usage: akron-discord-alert.sh <unit>}"
# shellcheck source=/dev/null
. /etc/akron-discord/alert.env

log_tail="$(journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | tail -c 1500)"
content="$(printf '%s failed on %s.\n```\n%s\n```' "$unit" "$(hostname)" "$log_tail")"
body="$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:1990]}))' "$content")"

curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bot ${DISCORD_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$body" \
  "https://discord.com/api/v10/channels/${DISCORD_ALERT_CHANNEL_ID}/messages"
