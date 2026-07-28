# Akron Discord

Official Discord bot for Akron's single community server. It manages server setup, verification, `.akr` submission scanning, R2 catalog publishing, and Discord forum to GitHub issue sync.

## Private diagnostics

The upload Worker accepts `POST /uploads/diagnostics` from Akron's consent menu.
Requests use JSON schema version 1, with a 32-character lowercase hexadecimal
`reportId`, UTC `createdUtc`, required `description`, `context`, `versions`,
`system`, `mods` and `logs`. The description may be empty and is limited to
4,000 UTF-16 code units. It is player-written text, preserved without automatic
redaction. The request is capped at 4 MiB. Each of the four allowlisted log
tails is capped at 1 MiB; the mod list is capped at 1,024 entries.

The Worker returns `201` with `{ "reportId": "...", "status": "received" }` only
after writing the report to `diagnostics/v1/<reportId>.json` in the private
`UPLOAD_QUARANTINE_BUCKET` and inserting its durable D1 delivery record.
This acknowledges upload and queueing, not Discord delivery. IDs cannot
overwrite existing reports; duplicates return `409`. If storage succeeds but
queueing fails, an identical retry can complete the queue insert.

The existing official bot polls the queue at startup and every 30 seconds.
It sends the description, map/context and version summary, plus the entire
stored JSON as an attachment, to private `#diagnostic-alert`
`1551699232992534558`. The recipient is fixed in server-side configuration.
All mentions are disabled. People with channel access can read the report
and its attachment; players should not include private information.

Claims have renewable five-minute leases and ownership tokens. Failures retry
with backoff from 30 seconds to one hour, without an attempt limit. After an
uncertain send or failed acknowledgement, the bot searches its channel history
for the report attachment before sending again. A stable Discord nonce also
deduplicates retries within Discord's nonce window. Delivery records and reports
are not removed by upload cleanup. Keep Read Message History permission for
recovery after outages; deleting an unacknowledged Discord post can cause it to
be posted again.

Reports are not published to the catalog or public bucket, and there is no
public retrieval or listing route. See [deployment and recovery](docs/setup.md#diagnostic-delivery)
before enabling this consumer.

Maintainer clients can retrieve a report with `POST /bot/diagnostics/<reportId>`
and body `{}`. Use the existing `signBotRequest` helper with `BOT_HMAC_SECRET`,
the exact path and body, and the `x-akron-timestamp`, `x-akron-nonce` and
`x-akron-signature` headers. Timestamp and nonce replay checks also apply to
diagnostic retrieval.

An authenticated Cloudflare operator can inspect a known report directly:

```sh
npx wrangler r2 object get \
  'akron-upload-quarantine/diagnostics/v1/<reportId>.json' \
  --remote --file report.json
```

Do not enable public access on the quarantine bucket. The client redacts common
secrets and local identifiers in automatic metadata and logs, but third-party
log text and the player's description may still contain personal data.
