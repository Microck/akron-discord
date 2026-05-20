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
```

Optional but expected for production:

```text
NVIDIA_NIM_API_KEY=
NVIDIA_NIM_MODEL=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_OWNER=
GITHUB_REPO=akron-tracker
```

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
