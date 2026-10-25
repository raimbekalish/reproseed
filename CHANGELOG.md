# Changelog

This project has not been released. Version `0.1.0` in `package.json` is the current unpublished development version. `private` is `true`. There is no npm publication, no git tag, and no GitHub Release. This file does not invent earlier versions or release dates.

## [Unreleased]

The notes below describe the development tree. They are not a published release.

### Added

- A local `reproseed minimize` command that replays a scenario in Chromium, removes steps that are not required for the same failure, and writes a Playwright regression test after `verified-one-minimal`.
- Record-count and DOM-text oracles, with the duplicate-submit and stale-search loopback examples.
- Five independent final verification replays before a regression spec is written.
- Optional `--tune-delays`, which searches shorter network delays only after step minimization has verified. A shorter delay is exported only when a new minimization and five fresh replays still reproduce the original failure.
- Authorized loopback reset: `http` on `127.0.0.1`, `localhost`, or `::1`, an app id from `GET /__reproseed/identity`, and a reset credential from the environment.
- GitHub Actions on Ubuntu with Node.js 22: quality and build, Chromium integration, and a private-package smoke test. The workflow does not publish or create a release.
- Contributor docs, issue and pull-request templates, and a release checklist.
- The MIT license for ReproSeed source code, copyright (c) 2026 Raimbek Alish. The npm package stays private. Third-party dependencies keep their own licenses.
- GitHub private vulnerability reporting. See [SECURITY.md](SECURITY.md).
