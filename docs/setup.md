# Akron Discord Setup

Install dependencies:

```sh
npm install
```

Copy `.env.example` to `.env` and fill in the values. Required for normal runtime:

```text
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
AKRON_ADMIN_ROLE_ID=
AKRON_MOD_ROLE_ID=
AKRON_MEMBER_ROLE_ID=
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_BUCKET=
CLOUDFLARE_R2_PUBLIC_BASE_URL=
AKRON_PUBLIC_ASSET_BASE_URL=https://akron.micr.dev
```

Optional but expected for production:

```text
NVIDIA_NIM_API_KEY=
NVIDIA_NIM_MODEL=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_TOKEN=
GITHUB_OWNER=
GITHUB_REPO=
```

Recommended NIM model:

```text
nvidia/llama-3.3-nemotron-super-49b-v1.5
```

This model is the current best fit for Akron's advisory review because it has a large context window and strong instruction-following behavior for structured JSON output. The deterministic `.akr` scanner remains the malware scanner; NIM only adds policy and content review. If the NIM API returns an auth or service error, the bot sends the submission to moderator review instead of publishing or flagging it.

Register slash commands for the configured guild:

```sh
npm run register-commands
```

Run locally:

```sh
npm run dev
```

Run production build:

```sh
npm run build
npm start
```

Run with Docker:

```sh
docker compose up -d --build
```

The container stores SQLite data in `./data` through the compose volume. It includes ImageMagick, FFmpeg, jpegtran, gifsicle, and svgo for `optimo`.

## Cloudflare R2

Create one private bucket for catalog archives and optimized map captures. Enable public `r2.dev` access or attach a public custom domain, then set `CLOUDFLARE_R2_PUBLIC_BASE_URL` to that raw storage origin.

Set `AKRON_PUBLIC_ASSET_BASE_URL=https://akron.micr.dev` so Discord embeds and catalog entries use branded URLs. The Vercel website should proxy the reserved asset paths to R2 and rewrite `/docs` to Mintlify. See `docs/akron-asset-urls.md`.

The bot uploads through the S3-compatible R2 API, so it also needs an R2 API token with Object Read & Write access scoped to that bucket. Copy the token's Access Key ID and Secret Access Key into the local deployment `.env`. Cloudflare only shows the secret once. Do not expose this token to Discord users or the website; `akron.micr.dev` should be public-read only.

Submitted `.akr` files are scanned in memory first. The bot only writes approved public downloads to R2. Flagged or review-blocked submissions stay in Discord and are not mirrored to the public bucket.

## Discord App Requirements

Enable these bot gateway intents in the Discord developer portal:

- Server Members Intent
- Message Content Intent

The bot needs permissions to manage roles, manage channels, manage threads, view channels, send messages, read message history, create public threads, attach files, and embed links.

## First Server Sync

The bot does not mutate the server on startup.

Run:

```text
/sync-server mode:dry-run
/sync-server mode:apply
```

`/sync-server` requires the configured `AKRON_ADMIN_ROLE_ID`. After sync, keep the created `Admin`, `Moderator`, and `Member` role IDs in `.env` so command authorization and verification stay explicit.

On a fresh server where `AKRON_ADMIN_ROLE_ID` is still blank, Discord users with the built-in Administrator permission can run the first `/sync-server mode:apply`. After role IDs are copied into `.env`, the bot uses the configured Akron roles.

## Submission Flow

Users post directly in forum channels. The bot scans the starter post and applies one status tag:

- `Published`
- `Needs Fix`
- `Needs Moderator Review`
- `Flagged`

Map catalog forums publish to R2 when validation passes:

- `startpos-packs`
- `auto-kill-areas`
- `auto-deafen-areas`

General pack forums are scanned but stay Discord-only:

- `keybind-packs`
- `hud-layouts`
- `audio-packs`
- `recorder-packs`

Map captures are optional but strongly recommended. If present, the bot validates the image, optimizes it through `optimo`, converts to WebP, and uploads only the optimized image to R2.

The deployment image must include ImageMagick's `magick` binary for `optimo` image conversion. If image optimization fails, the bot keeps the post out of the catalog and marks it `Needs Moderator Review`.

## GitHub Sync

`issues` and `suggestions` forum posts sync one-way to the configured GitHub repo. The GitHub issue body includes a source Discord link and quotes user text as untrusted content.

Use either `GITHUB_TOKEN` or the GitHub App fields. Fine-grained token minimum repository permissions:

- Contents: read
- Issues: read and write
- Metadata: read

GitHub App minimum repository permissions:

- Contents: read
- Issues: read and write
- Metadata: read

Manage labels:

```text
/sync-github-labels mode:dry-run
/sync-github-labels mode:apply
```

Manual commands:

```text
/sync-issue
/link-issue
/unlink-issue
/close-synced-issue
/set-map-mapping
```

Use `/set-map-mapping` to connect a supported GameBanana map URL to the canonical Celeste map SID, then run `/rescan` on affected `Needs Moderator Review` submissions.

## Verification

The `verify` channel contains a persistent `Verify Me` button. Clicking it grants the configured `Member` role and writes a verification log row to SQLite.

## Checks

```sh
npm run check
npm test
npm run build
```

`DISCORD-SPEC.md` is the product contract. Update it first when behavior changes.
