# Changelog

0.1.0 is the first published release. This file does not invent earlier versions. The 0.2.0 section below is the unpublished candidate. It has no publication date.

## [Unreleased]

Nothing is queued past the 0.2.0 candidate.

## [0.2.0] - pending publication

Pending publication. The date is filled in when the owner publishes. This section is not a claim that `0.2.0` is on npm. Published `0.1.0` does not include `init`, `doctor`, `--trace`, or the two guides. The notes are [docs/v0.2.0-release-notes.md](docs/v0.2.0-release-notes.md).

### Added

- `reproseed init` writes a starter scenario for the record-count or DOM-text oracle. It does not embed a reset credential or a production URL.
- `reproseed doctor` checks a scenario, the loopback target, Chromium, and the clean-state GET without sending `POST /__reproseed/reset` or launching a browser.
- `reproseed minimize --trace <file.zip>` records one Playwright trace after a verified minimization. The extra replay is separate from the five verification replays and is omitted from replay counts. A zip is verified evidence only when that replay reproduces the verified failure. Tracing stays off during minimization, and a trace failure does not change the minimization exit code or replace the report and spec. See [docs/trace-evidence.md](docs/trace-evidence.md).
- [docs/integrate-your-app.md](docs/integrate-your-app.md) and [docs/trace-evidence.md](docs/trace-evidence.md) are included in the candidate tarball. The CLI dependency is Playwright `1.64.1`. Installing ReproSeed does not install `@playwright/test`, which a generated spec imports.
- `examples/opt-in-ticket`, a loopback application that opts in to identity, authorized reset, and a read-only clean-state list. The server is in this repository. It is not in the npm package.
- A fresh install of the packed tarball, outside this repository, runs `init`, `doctor`, and `minimize`, confirms five verification replays, fails the generated spec on the buggy opt-in page, passes that same spec on the test-only fixed page, and opens the trace zip in Trace Viewer.

### Changed

- `package.json` version is `0.2.0`. `npm install reproseed` from the registry still installs published `0.1.0` until the owner publishes this version. A checkout of this candidate and a tarball packed from it print `0.2.0`.
- A failed `reproseed minimize --trace` leaves an existing zip unchanged and says that file may be stale. It is not presented as evidence for the current run. A trace save that passes the 5 second cleanup budget is still waited on, and the temporary zip is removed after that save settles.
- `reproseed doctor` checks `reset.verify.path` only as a JSON array. For a record-count scenario, `oracle-endpoint` checks `oracle.request.path` for string `id`, `email`, and `note`, and numeric `createdAt`. The paths can differ. An empty oracle array still passes. A DOM-text scenario does not request a record list. The diagnostic names the item and the field and does not print record values.
- `reproseed doctor` treats each scenario `goto` response as ready only when the status is successful. A connection failure, a redirect, a missing route, and a server error stay distinct. `GET /` is requested only when the scenario has no `goto` step.
- The opt-in ticket integration test runs one generated spec against the default buggy page, where the count is 2, and against a test-only fixed page, where the count is 1. The fixed page is not the default server and is not in the npm package.
- Browser tests stop a child this process spawned by calling that `ChildProcess` handle's `kill`. They signal a Chromium descendant only after a fresh parent-chain and browser-command check. A process whose ownership cannot be proven is reported and left running.

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
