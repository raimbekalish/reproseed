# Changelog

0.1.0 is the first release. This file does not invent earlier versions.

## [Unreleased]

Work toward 0.2.0. This section is not a release. The package version stays 0.1.0 until that release is published.

### Added

- `reproseed minimize --trace <file.zip>` records one Playwright trace after a verified minimization. The extra replay is separate from the five verification replays and is omitted from replay counts. A zip is verified evidence only when that replay reproduces the verified failure. Tracing stays off during minimization, and a trace failure does not change the minimization exit code or replace the report and spec. See [docs/trace-evidence.md](docs/trace-evidence.md).
- `reproseed doctor` checks a scenario, the loopback target, Chromium, and the clean-state GET without sending `POST /__reproseed/reset` or launching a browser.
- `reproseed init` writes a starter scenario for the record-count or DOM-text oracle. It does not embed a reset credential or a production URL.
- `examples/opt-in-ticket`, a loopback application that opts in to identity, authorized reset, and a read-only clean-state list. It does not use the other demo servers.
- [docs/integrate-your-app.md](docs/integrate-your-app.md) and [docs/trace-evidence.md](docs/trace-evidence.md) are included in the npm package. `npm install reproseed` installs Playwright `1.64.1` for the CLI. It does not install `@playwright/test`, which a generated spec imports.

### Changed

- A failed `reproseed minimize --trace` leaves an existing zip unchanged and says that file may be stale. It is not presented as evidence for the current run. A trace save that passes the 5 second cleanup budget is still waited on, and the temporary zip is removed after that save settles.
- `reproseed doctor` checks `reset.verify.path` only as a JSON array. For a record-count scenario, `oracle-endpoint` checks `oracle.request.path` for string `id`, `email`, and `note`, and numeric `createdAt`. The paths can differ. An empty oracle array still passes. A DOM-text scenario does not request a record list. The diagnostic names the item and the field and does not print record values.
- `reproseed doctor` treats each scenario `goto` response as ready only when the status is successful. A connection failure, a redirect, a missing route, and a server error stay distinct. `GET /` is requested only when the scenario has no `goto` step.
- The opt-in ticket integration test runs one generated spec against the default buggy page, where the count is 2, and against a test-only fixed page, where the count is 1. The fixed page is not the default server and is not in the npm package.

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
