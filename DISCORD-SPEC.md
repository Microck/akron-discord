# Akron Discord Bot Spec

This document records the current product and architecture decisions for Akron's official Discord bot. It is the implementation contract for the future `akron-discord` private repository.

## Scope

The bot is for one official Akron Discord server only. It is not a public multi-server bot, and it does not need tenant-specific settings.

The bot owns four jobs:

1. Create and maintain the official server structure.
2. Validate community `.akr` submissions posted by users in forum channels.
3. Publish approved map-specific packs to Cloudflare R2 for Akron's in-game catalog.
4. Keep moderation, verification, scan logs, and catalog state auditable.

## Technology

Use TypeScript with `discord.js` v14 as the Discord API layer.

Reasons:

- It is the best-maintained TypeScript default for slash commands, modals, buttons, embeds, attachments, forum threads, and guild channel management.
- It keeps the implementation close to Discord's API instead of hiding important permission and thread behavior behind a heavier framework.
- Sapphire can be reconsidered later if the bot becomes plugin-heavy, but the first implementation should stay on plain `discord.js` plus local modules.

Use Cloudflare R2 as the canonical storage backend for public catalog assets.

R2 stores:

- `.akr` files for published map-specific packs.
- Optional map capture images.
- The public `index.json` catalog consumed by Akron's in-game community pack browser.

Do not use Discord attachment URLs as the catalog contract. Discord can host the original forum post attachments, but R2 is the stable public source for the game client.

Use SQLite with Drizzle ORM as the persistent database for v1.

SQLite stores:

- Discord forum post scan state.
- Published catalog entry metadata.
- R2 object keys.
- Map-link resolver entries and moderator mappings.
- Verification logs.
- Moderation overrides and audit records.

This bot targets one official server, so SQLite is the simplest correct default. Move to Postgres only if the deployment later needs multiple writer processes or stronger remote operational tooling.

Use Octokit REST authenticated as a GitHub App for one-way GitHub issue sync.

Reasons:

- GitHub Apps use repo-scoped permissions and short-lived installation tokens.
- Octokit REST maps directly to issue creation, labels, comments, and state changes.
- Probot is not needed unless the bot later needs a full GitHub webhook framework.
- Fine-grained PATs are acceptable for throwaway prototypes, but not for the official long-running bot.
- One-way sync keeps v1 simple: Discord creates and links GitHub issues, but GitHub webhooks do not update Discord automatically.

## Server Sync

The bot must not silently mutate the server on startup.

Expose admin-only commands:

```text
/sync-server dry-run
/sync-server apply
```

`dry-run` reports planned role, category, channel, forum tag, and permission changes. `apply` performs those changes.

Server sync is intentionally non-destructive. Normal `apply` must not delete channels or replace same-name channels with incompatible types. If destructive reconciliation is needed later, it should be a separate explicit admin command or mode.

Only configured admins can run server sync.

## Roles

The bot creates or maintains these roles:

| Role | Purpose |
| --- | --- |
| `Admin` | Full trusted server operations. Can run server sync. |
| `Moderator` | Can review flagged posts and run manual rescans. |
| `Member` | Granted after verification. Unlocks normal community channels. |

The implementation should keep role IDs in config after first sync:

```text
AKRON_ADMIN_ROLE_ID=
AKRON_MOD_ROLE_ID=
AKRON_MEMBER_ROLE_ID=
```

Moderator-only actions must require `AKRON_MOD_ROLE_ID`. Admin-only actions must require `AKRON_ADMIN_ROLE_ID`.

## Verification

Use simple button verification for now.

Create a read-only `verify` channel visible to unverified users. The bot posts a persistent embed with a `Verify Me` button. Clicking it grants `Member`.

The bot logs each verification with:

- Discord user ID.
- Display name and username.
- Account creation age.
- Timestamp.

No captcha, OAuth, or external verification is required for the first version.

## Channel Naming

Use short lowercase names. Prefer conventional Discord names over verbose labels.

Examples:

- `verify`, not `verify-me`.
- `rules`.
- `announcements`.
- `general`.
- `staff-chat`.
- `mod-log`.
- `audit-log`.

Use hyphenated names for multi-word channels.

## Canonical Server Structure

### Info

| Channel | Type | Visibility | Purpose |
| --- | --- | --- | --- |
| `rules` | Text | Everyone can read | Server rules and submission policy. |
| `verify` | Text | Unverified users can read | Button verification entrypoint. |
| `announcements` | Announcement or text | Members can read | Official Akron announcements. |
| `welcome` | Text | Members can read | Post-verification orientation. |
| `faq` | Text | Members can read | Common questions and links. |
| `submission-guide` | Text | Members can read | How to make `.akr` submissions and map captures. |

### Community

| Channel | Type | Visibility | Purpose |
| --- | --- | --- | --- |
| `questions` | Forum | Members | Help and usage questions. |

`general` is intentionally omitted for now. The first server structure should prioritize structured support, submissions, issues, and suggestions over casual chat.

Do not add extra public channels in v1. The current public/member-facing structure is the initial canonical structure.

Suggested `questions` forum tags:

- `Akron Setup`
- `.akr Packs`
- `Map Catalog`
- `Bug Help`
- `Answered`
- `Needs Staff`

### Feedback

| Channel | Type | Visibility | Purpose |
| --- | --- | --- | --- |
| `issues` | Forum | Members | User-authored bug reports synced to GitHub issues. |
| `suggestions` | Forum | Members | User-authored feature suggestions. |

`issues` and `suggestions` should use forum post guidelines and tags so users can post naturally while the bot keeps the posts structured. Discord feedback posts are supported for convenience, but the channel copy should say that users should preferably open GitHub issues directly when they are comfortable doing so. Discord-created feedback remains one-way synced to GitHub.

### Map Catalog

These forum channels produce entries for Akron's in-game R2 catalog.

| Channel | Forum purpose | Accepted scope |
| --- | --- | --- |
| `startpos-packs` | StartPos packs tied to a map SID. | `StartPos` |
| `auto-kill-areas` | Auto Kill area packs tied to a map SID. | `AutoKill` |
| `auto-deafen-areas` | Auto Deafen area packs tied to a map SID. | `AutoDeafen` |

Each forum post is authored by the submitting user. The bot watches raw forum posts instead of forcing users through a slash-command-created post.

Required post data:

- One `.akr` attachment.
- A supported map link.
- A scope/tag matching the forum channel.
- Optional description.
- Optional but strongly recommended map capture image.

Each map catalog forum must have post guidelines that link to `submission-guide`.

### General Packs

These are Discord-only after scanning. They do not enter the in-game map catalog.

| Channel | Forum purpose | Accepted scope |
| --- | --- | --- |
| `keybind-packs` | Shared keybind packs. | `Keybinds` |
| `hud-layouts` | Shared HUD layouts. | `Hud` |
| `audio-packs` | Shared audio settings. | `Audio` |
| `recorder-packs` | Shared recorder settings. | `Recorder` |

`Whole` profile packs are not allowed for public posting in the first version.

Each general pack forum must have post guidelines that link to `submission-guide`.

### Staff

| Channel | Type | Visibility | Purpose |
| --- | --- | --- | --- |
| `staff-chat` | Text | Admin and Moderator | Staff discussion. |
| `mod-log` | Text | Admin and Moderator | Moderation actions and overrides. |
| `scan-log` | Text | Admin and Moderator | Submission scan summaries. |
| `audit-log` | Text | Admin only | Server sync, catalog writes, and high-risk actions. |
| `bot-alerts` | Text | Admin only | Runtime failures and storage/API errors. |
| `catalog-overrides` | Forum or text | Admin and Moderator | Manual map-link to map SID mappings. |
| `github-sync-log` | Text | Admin and Moderator | GitHub issue sync failures and backfills. |

## Forum Tags

Each submission forum should have status tags:

- `Pending Scan`
- `Published`
- `Needs Fix`
- `Needs Moderator Review`
- `Flagged`

Map catalog forums should also expose scope tags when useful:

- `StartPos`
- `Auto Kill`
- `Auto Deafen`

Tags are applied by the bot. Moderated tags should require `Moderator`.

## GitHub Issue Sync

The `issues` and `suggestions` forums are linked to a configured GitHub repository. Do not infer the repository from any local checkout. The bot must read the target from configuration.

The target repository should be `akron-tracker`. Create it as a private repository at first, then make it public later only if the project wants public issue visibility.

Required config:

```text
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_OWNER=
GITHUB_REPO=
```

Minimum GitHub App permissions:

- Repository contents: read.
- Issues: read and write.
- Metadata: read.

Issue forum post requirements:

- Clear title.
- Reproduction steps or observed behavior.
- Expected behavior when applicable.
- Version/build context when available.
- Optional attachments, screenshots, logs, or crash text.

On every synced forum post, the created GitHub issue must link back to the source Discord forum post.

On a valid new `issues` forum post, the bot should:

1. Create a GitHub issue with a normalized body.
2. Include the Discord forum post URL in the issue body.
3. Store the Discord thread ID to GitHub issue number mapping in SQLite.
4. Reply to the forum post with a bot embed containing the GitHub issue URL.
5. Apply a synced tag such as `Synced`.
6. Log the action to `github-sync-log`.

The bot should not trust user text when generating GitHub issue bodies. User text must be quoted or placed under clear headings. The bot must not let user content control labels, repository names, assignees, or issue state.

Default labels:

- `discord`
- `issue`
- `needs-triage`

Suggested issue forum tags:

- `Needs Info`
- `Synced`
- `GitHub Open`
- `GitHub Closed`
- `Duplicate`
- `Invalid`
- `Not Planned`

Suggestion forum post requirements:

- Clear title.
- Problem or opportunity being addressed.
- Proposed behavior or feature.
- Optional examples, mockups, screenshots, or related links.

On a valid new `suggestions` forum post, the bot should create a GitHub issue with a normalized body, include the Discord forum post URL in the issue body, store the Discord-to-GitHub mapping in SQLite, reply with a GitHub issue URL embed, and log the sync to `github-sync-log`.

Default suggestion labels:

- `discord`
- `suggestion`
- `needs-triage`

GitHub labels are managed as a canonical taxonomy. The bot should create missing labels through an admin-only dry-run/apply command before syncing issues.

Type labels:

- `issue`
- `suggestion`

Source label:

- `discord`

Triage/status labels:

- `needs-triage`
- `needs-info`
- `accepted`
- `not-planned`
- `duplicate`
- `invalid`

Priority labels:

- `high-prio`
- `medium-prio`
- `low-prio`

The label set is inspired by common GitHub issue taxonomies and the `pingdotgg/t3code` public issue labels, which use similar concepts such as `accepted`, `duplicate`, `invalid`, `needs-triage`, and `wontfix`.

The bot should only apply status and priority labels from trusted sources:

- A moderated forum tag.
- A moderator/admin command.
- A configured channel policy.

Regular user text must not be allowed to assign arbitrary GitHub labels.

Manual sync commands:

```text
/sync-issue
/close-synced-issue
/link-issue
/unlink-issue
/sync-github-labels dry-run
/sync-github-labels apply
```

These commands require `Moderator` or `Admin`.

The first implementation should support Discord-to-GitHub creation and status embeds. GitHub issue sync is one-way for v1. If a GitHub issue is closed, labeled, or reopened directly on GitHub, the bot does not update Discord automatically. Moderators can update Discord tags manually or use the bot's admin commands.

## File Limits

Default upload limits:

- `.akr` max size: 4 MB.
- Map capture max size: 8 MB before optimization.
- Allowed map capture formats: PNG, JPEG, and WebP.
- One `.akr` attachment is required per `.akr` submission.
- At most one map capture image is used as the catalog preview.
- Map captures are optional but heavily recommended for map-specific catalog posts.

The 4 MB `.akr` limit matches Akron's current in-game community pack download guardrail.

## Image Optimization

Use `optimo` before uploading map capture images to R2.

Pipeline:

1. Download the Discord image attachment to a temporary working directory.
2. Validate MIME type and decoded dimensions.
3. Run `optimo` with metadata stripping.
4. Resize large captures to a catalog-friendly width.
5. Upload only the optimized output to R2.
6. Store the optimized R2 URL as `imageUrl` in `index.json`.

Recommended first settings:

- Convert map captures to WebP for catalog images.
- Resize to `w1280` unless the source is smaller.
- Strip EXIF metadata.
- Keep the original Discord attachment only as part of the user-authored forum post, not as the catalog image.

If `optimo` or one of its native dependencies is unavailable, the bot should mark the post `Needs Moderator Review` instead of uploading an unoptimized image.

## Submission Guide Content

The bot should post and maintain a prettified guide embed in `submission-guide`.

The guide should cover:

- Which forum channel to use for each `.akr` scope.
- Which `.akr` scopes are allowed in the in-game catalog.
- Which `.akr` scopes are Discord-only.
- Why `Whole` profile packs are not allowed yet.
- How to export a scoped `.akr` pack from Akron.
- How to include a supported map link.
- How to include a short useful description.
- How to attach a map capture image.
- That map capture images are optional but heavily recommended because Akron can already generate them easily.
- How to read bot feedback when a post is `Needs Fix` or `Flagged`.

The map capture section should explain:

- Use Akron's room/map capture feature when possible.
- Show the relevant StartPos markers, Auto Kill areas, or Auto Deafen areas clearly.
- Avoid cropping out room context.
- Prefer PNG for raw captures; the bot will optimize the final catalog image.
- Do not include private desktop content, tokens, or personal overlays in screenshots.

The guide should include examples of valid forum posts:

```text
Title: Beginner Lobby StartPos Pack
Map: https://gamebanana.com/mods/150453
Description: Start positions for common lobby practice rooms.
Attachments: beginner-startpos.akr, beginner-startpos-capture.png
```

Server sync should create or update the guide message idempotently, using a stored message ID when available.

## Submission Lifecycle

Raw user forum posts are accepted.

Lifecycle:

```text
Pending Scan -> Published
Pending Scan -> Needs Fix
Pending Scan -> Needs Moderator Review
Pending Scan -> Flagged
```

The bot should automatically scan new forum posts and debounced edits to the first post. Archived and locked `Flagged` posts must not be rescanned automatically after user edits. A moderator or admin must explicitly unlock/unarchive and run `/rescan`.

Manual rescan:

```text
/rescan
```

`/rescan` is restricted to `Moderator` and `Admin`.

Manual map resolver updates:

```text
/set-map-mapping
```

`/set-map-mapping` is restricted to `Moderator` and `Admin`. It stores a supported map URL, the canonical Celeste map SID, and a display name in SQLite. Moderators should run `/rescan` on affected `Needs Moderator Review` posts after adding a mapping.

## Needs Fix

Use `Needs Fix` for recoverable submission problems:

- Missing `.akr` attachment.
- Missing map link for map-specific forums.
- Missing or wrong forum tag.
- Unsupported map link.
- `.akr` scope does not match the forum channel.
- Optional map capture is missing but the pack is otherwise valid.

The bot replies with a clear embed that lists the exact problems and how to fix them. The post remains visible but does not publish.

## Flagged

Use `Flagged` when the post should not stay publicly accessible without staff action.

Flagged cases include:

- Zip path traversal.
- Absolute paths in archive entries.
- Nested archives if the implementation disallows them.
- Zip bomb or extreme compression ratio.
- Too many files or oversized payloads.
- Missing `manifest.json` or `profile.json`.
- Extra unexpected files.
- Manifest/profile scope mismatch.
- Map SID mismatch for a map-specific forum.
- `Whole` profile pack.
- Suspicious file paths, process names, shell commands, URLs, tokens, or credentials in config content.
- Huge or malformed values likely intended to crash parsing or rendering.
- Offensive, hateful, doxxing, scam, spam, impersonation, or social-engineering content.
- High-severity NVIDIA NIM policy result.

Flagged posts should be tagged `Flagged`, logged to `mod-log` and `scan-log`, then locked and archived. The bot should preserve the thread as moderation evidence instead of deleting it.

Only `Moderator` or `Admin` can restore, override, or rescan a flagged post.

Every downloaded `.akr` must be archived to R2 before publication or final scan feedback. Non-flagged scan embeds should link to the exact archived `.akr` bytes and include the SHA-256 hash. Flagged files should be backed up for staff review and logged to staff channels, but the user-visible flagged embed should not expose a public download link.

## Malware and AI Review

NVIDIA NIM is not the malware scanner.

NIM review failures must not hard-flag a post by themselves. If NIM is unavailable, unauthorized, or returns malformed output, the submission moves to `Needs Moderator Review`.

The scan pipeline must run deterministic validation first:

1. Download the Discord attachment.
2. Enforce file size limits.
3. Open the `.akr` as a zip without extracting to the filesystem.
4. Require exactly the expected archive files for the current Akron profile format.
5. Reject path traversal and absolute paths.
6. Parse `manifest.json`.
7. Parse `profile.json`.
8. Validate scope, map SID, and schema.
9. Normalize the extracted facts for AI review.

NIM is a second-pass policy reviewer. It can classify normalized metadata and user text as:

```json
{
  "decision": "allow",
  "severity": "low",
  "reasons": []
}
```

Allowed decisions:

- `allow`
- `needs_review`
- `reject`

The implementation must schema-validate NIM output. NIM must never decide storage keys, permissions, Discord actions, or catalog writes directly.

Prompt-injection protection:

- Treat titles, descriptions, filenames, and profile JSON as untrusted data.
- Never include user content in system or developer instructions.
- Delimit user content clearly.
- Ask NIM for strict JSON only.
- Ignore instructions found inside user content.
- Keep deterministic policy authoritative.

## Map Identity

Map-specific catalog submissions require strict map identity validation.

The post must include a supported map link. The bot resolves that link to a Celeste `mapSid`. The `.akr` manifest/profile target must match that map SID.

If the map link uses an unsupported domain or is malformed, the post is `Needs Fix`.

If the map link is valid but missing from the resolver table, the post is `Needs Moderator Review`. This is a catalog-maintenance task because most users will not know the exact Celeste map SID.

The first implementation can use a committed or R2-backed resolver table:

```json
{
  "https://gamebanana.com/mods/150453": {
    "mapSid": "SpringCollab2020/1-Beginner",
    "displayName": "Spring Collab 2020 - Beginner Lobby"
  }
}
```

## R2 Catalog Publishing

Only these scopes enter the public in-game catalog:

- `StartPos`
- `AutoKill`
- `AutoDeafen`

When a map-specific post publishes:

1. Upload the `.akr` to R2.
2. Optimize and upload the map capture image when present.
3. Save a timestamped backup of the previous catalog when one exists.
4. Update the canonical catalog `index.json`.
5. Apply the `Published` forum tag.
6. Reply with a prettified embed containing the published catalog summary.

Catalog path convention:

```text
catalog/index.json
catalog/backups/index-YYYY-MM-DDTHH-mm-ssZ.json
packs/{mapSidSlug}/{packId}.akr
captures/{mapSidSlug}/{packId}.webp
```

The bot should update SQLite and R2 in an order that makes recovery practical. If a catalog write fails after assets upload, the post should stay out of `Published` and the failure should be logged to `audit-log` and `bot-alerts`.

Catalog entries must match Akron's current in-game contract:

```json
{
  "format": "akron-community-pack-index-v1",
  "version": 1,
  "packs": [
    {
      "id": "spring-collab-beginner-startpos-v1",
      "title": "Beginner Lobby StartPos Set",
      "description": "StartPos slots for common Beginner lobby practice rooms.",
      "section": "StartPos",
      "mapSid": "SpringCollab2020/1-Beginner",
      "mapUrl": "https://gamebanana.com/mods/150453",
      "downloadUrl": "https://r2.example/akron/packs/example.akr",
      "authorName": "Display Name",
      "authorAvatarUrl": "",
      "imageUrl": "https://r2.example/akron/captures/example.png",
      "downloadCount": 0,
      "updatedUtc": "2026-05-20T00:00:00Z",
      "tags": ["startpos", "beginner"]
    }
  ]
}
```

## Required Environment

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

NVIDIA_NIM_API_KEY=
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_MODEL=

GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_OWNER=
GITHUB_REPO=
```

Recommended NIM model:

```text
nvidia/llama-3.3-nemotron-super-49b-v1.5
```

The GitHub repository name must be configured explicitly for the deployment. The public config contract must not default to an operator-owned repository.

## Open Decisions

No blocking product decisions remain before initial scaffolding.
