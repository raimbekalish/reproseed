# Changelog

0.1.0 is the first release. This file does not invent earlier versions.

## [0.1.0] - 2026-10-25

The notes for this version are also in [docs/v0.1.0-release-notes.md](docs/v0.1.0-release-notes.md).

### Added

- `reproseed minimize` replays a scenario in Chromium, removes steps that are not required for the same failure, and writes a Playwright regression test after `verified-one-minimal`.
- Record-count and DOM-text oracles, with the duplicate-submit and stale-search loopback examples.
- Five independent verification replays before a regression spec is written. Those replays do not use the candidate cache.
- Optional `--tune-delays`. A shorter network delay is exported only when a new minimization and five fresh replays still reproduce the original failure. Otherwise the verified scenario is exported unchanged.
- Authorized loopback reset: `http` on `127.0.0.1`, `localhost`, or `::1`, an app id from `GET /__reproseed/identity`, and a reset credential from the environment.
- GitHub Actions on Ubuntu with Node.js 22: quality and build, Chromium integration, and a package smoke test. The workflow does not publish or create a release.
- The MIT license for ReproSeed source code, copyright (c) 2026 Raimbek Alish. Third-party dependencies keep their own licenses.
- GitHub private vulnerability reporting. See [SECURITY.md](SECURITY.md).

Tested environments are macOS for development and GitHub-hosted Ubuntu with Node.js 22. Windows is not tested. `verified-one-minimal` is 1-minimal under single deletion, not a proof of the globally shortest reproduction.
