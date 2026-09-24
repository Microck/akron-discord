# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Accept an optional player-written diagnostic description and queue the full private report for Discord delivery with leased retries and recovery after uncertain sends.
- Run Oxlint with the local anti-slop rules in CI.

### Fixed

- reconcile published Discord pack threads on startup so replaced capture and download links do not remain broken
- Limit repeated runtime alerts from a failing background poll to one message per error per hour.
