# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Accept an optional player-written diagnostic description and queue the full private report for Discord delivery with leased retries and recovery after uncertain sends.
- Write a daily SQLite snapshot to `data/backups`, keep the newest 14 days, and report failed backups to `#bot-alerts`.
- Deploy the bot and upload Worker automatically after CI passes on `main`: the bot image goes to GHCR and the host pulls it with database snapshot and automatic rollback; the Worker applies D1 migrations and deploys with matching Sentry source maps. Host failures post to `#bot-alerts`.

### Removed

- Remove the `/set-map-mapping` command and its `map_mappings` table. Nothing read the stored mappings. Re-register slash commands after deploying so Discord drops the command.
- Remove the unused bot-side forum catalog publisher, its `catalog_entries` cache table, and the upload Worker's `POST /bot/catalog/entries` route. Existing `catalog_entries` and `map_mappings` tables in a bot database stay until an operator drops them.

### Fixed

- reconcile published Discord pack threads on startup so replaced capture and download links do not remain broken
- update undici, zod, vite, and Sentry to clear current `npm audit` advisories, and keep the diagnostic description limit counted in UTF-16 units after Zod changed `max()` to count code points
