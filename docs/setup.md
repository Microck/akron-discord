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
GITHUB_WEBHOOK_SECRET=
GITHUB_WEBHOOK_PORT=3000
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

`issues` and `suggestions` forum posts sync to the configured GitHub repo. The GitHub issue body includes a source Discord link and quotes user text as untrusted content.

Use either `GITHUB_TOKEN` or the GitHub App fields. Fine-grained token minimum repository permissions:

- Contents: read
- Issues: read and write
- Metadata: read

GitHub App minimum repository permissions:

- Contents: read
- Issues: read and write
- Metadata: read

Configure a GitHub webhook that points at:

```text
https://<bot-host>/github/webhook
```

Set the same random value in GitHub and `GITHUB_WEBHOOK_SECRET`. Subscribe to these repository events:

- Issues
- Issue comments

The webhook listener defaults to `GITHUB_WEBHOOK_PORT=3000`. GitHub issue comments post back into the linked Discord thread. GitHub closes apply `GitHub Closed`, lock the thread, and archive it. GitHub reopens apply `GitHub Open`, unlock the thread, and unarchive it.

Manage labels:

```text
/sync-github-labels mode:dry-run
/sync-github-labels mode:apply
```

Manual commands:

```text
/sync-issue
/solved
/link-issue
/unlink-issue
/close-synced-issue
/set-map-mapping
```

`/sync-issue` reports the concrete outcome: created, already linked, or skipped with the reason. Manual sync can sync bot-authored posts from any forum channel; posts outside `issues` and `suggestions` sync as normal GitHub issues. Automatic background sync skips bot-authored posts and only syncs `issues` and `suggestions`.

Created GitHub issues include the forum post title, source Discord link, starter description, starter attachments, and up to 100 recent non-bot thread replies. Image attachments render inline in GitHub. Video attachments and other files are linked with content type and size metadata.

Re-run `/sync-issue` on an already-linked thread to refresh the GitHub issue title/body with the current Discord description, attachments, and conversation.

Use `/solved` in any forum post to apply the forum's completion tag and archive the thread. The thread author, moderators, and admins can run it.

Use `/set-map-mapping` to connect a supported GameBanana map URL to the canonical Celeste map SID, then run `/rescan` on affected `Needs Moderator Review` submissions.

## Verification

The `verify` channel contains a persistent `Verify Me` button. Clicking it grants the configured `Member` role and writes a verification log row to SQLite.

## Playtesting

The `playtesting` channel contains the public playtester application embed. Members click `Apply`, answer the private modal, and the bot creates a staff-only application thread in `playtester-applications`.

Staff can accept or deny from the application thread. Accepting grants `Tester` and starts inactivity tracking. Denying requires a reason, DMs the applicant, archives the review thread, and starts a 14-day reapply cooldown.

The bot records a playtest release when a message in the playtester `announcements` channel has a `.zip` attachment. For each release window, a tracked tester is active if they post in `tester-feedback` or `tester-bugs-n-issues`, or send at least 3 messages in playtester `chat`. After 3 consecutive missed releases, the bot removes `Tester` and logs the removal in `staff-chat`. Staff-managed `Beta` exempts a tester from inactivity removal.

## Checks

```sh
npm run check
npm test
npm run build
```

`DISCORD-SPEC.md` is the product contract. Update it first when behavior changes.
