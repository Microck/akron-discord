# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Accept an optional player-written diagnostic description and queue the full private report for Discord delivery with leased retries and recovery after uncertain sends.
- Write a daily SQLite snapshot to `data/backups`, keep the newest 14 days, and report failed backups to `#bot-alerts`.
- Deploy the bot and upload Worker automatically after CI passes on `main`: the bot image goes to GHCR and the host pulls it with database snapshot and automatic rollback; the Worker applies D1 migrations and deploys with matching Sentry source maps. Host failures post to `#bot-alerts`.

### Fixed

- reconcile published Discord pack threads on startup so replaced capture and download links do not remain broken
- update undici, zod, vite, and Sentry to clear current `npm audit` advisories, and keep the diagnostic description limit counted in UTF-16 units after Zod changed `max()` to count code points
