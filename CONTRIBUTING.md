# Contributing

ReproSeed is a local CLI. Changes should stay understandable to someone who has not seen the project before. [README.md](README.md) explains what the tool does. This file explains how to work on it.

ReproSeed source code is under the MIT license in [LICENSE](LICENSE), copyright (c) 2026 Raimbek Alish. Dependencies keep their own licenses. Playwright is Apache-2.0. Do not remove `LICENSE` from the tree or from the npm package.

The repository owner reviews pull requests. This document does not promise a response time.

## Prerequisites

- Node.js 22 or newer. [`.node-version`](.node-version) pins the CI line at 22.
- npm.
- Playwright's downloaded Chromium for the `playwright` version in `package-lock.json`. CI uses GitHub-hosted Ubuntu. Local development so far has been on macOS. Windows is not a tested target.

## Fork and branch workflow

1. Fork [raimbekalish/reproseed](https://github.com/raimbekalish/reproseed) and clone your fork.
2. Start from current `main`.
3. Create a branch named for the change, for example `feat/short-description` or `fix/short-description`.
4. Open a pull request against `main`.

CI runs on that pull request. A newer push to the same pull request cancels the older run. Do not merge the pull request yourself unless the owner has asked you to.

## Local installation

```bash
npm ci
npx playwright install --with-deps --no-shell chromium
npm run build
```

`--no-shell` skips `chrome-headless-shell`. ReproSeed launches the downloaded Chromium revision with `channel: "chromium"`. CI uses `node scripts/install-playwright-chromium.mjs`, which installs that same browser and then checks that the process it launched has exited. That script signals only the process group it started.

Generate reset credentials in the shell when you need a demo. Do not commit them. `artifacts/` is gitignored. Do not commit reports, generated specs, or `.env` files.

## Directories

| Path | Role |
| --- | --- |
| `src/cli` | Arguments, help text, exit codes, `init`, `doctor`, and writing the sanitized report |
| `src/core` | Scenario types, minimizer, signatures, and budgets. This directory stays free of Playwright |
| `src/runner` | Chromium replay, reset, delay matching, and oracles |
| `src/export` | Playwright regression spec |
| `examples/duplicate-submit` | Record-count demo and scenario |
| `examples/stale-search` | DOM-text demo and scenario |
| `examples/opt-in-ticket` | Independent opt-in application used by the integration guide |
| `test` | Unit tests and browser integration |
| `scripts` | Export-asset copy and the CI Chromium installer |
| `docs` | Design notes, the integration guide, the release checklist, the 0.1.0 release notes, the publish runbook, and the record of the MIT license decision |
| `.github` | CI workflow and issue/pull-request templates |

## Fast checks

These do not launch Chromium:

```bash
npm run typecheck
npm run build
npm test
npm run test:cli
npm run test:package
```

`npm run test:package` builds, packs, and installs the tarball outside the checkout. It does not publish.

## Browser integration tests

Chromium tests are slower than the unit tests. They still have to perform the real checks. Do not skip them, mock Chromium, or weaken a RED/GREEN assertion to make a run pass. Do not raise a timeout to hide a deadlock.

Run the suites one after another. Overlapping Chromium sessions can close a browser another run still needs.

```bash
npm run build
npm run test:demo
npm run test:search
npm run test:runner
npm run test:export
npm run test:cli:e2e
```

`npm run test:browsers` runs those five commands in that order. `npm run test:runner` also sets `--test-concurrency=1`. `npm run test:cli:e2e` needs the build from the first command. It runs the existing CLI end-to-end tests and then minimizes `examples/opt-in-ticket` through the built CLI. Those browser tests run one at a time.

Each suite starts its own loopback server on an ephemeral port and generates its reset credential in the test process. No private production credential is required.

## Regression tests

A meaningful browser regression shows the bug and the fix.

- The buggy page fails the oracle.
- The fixed page passes the same oracle.
- `npm run test:export` is the existing RED/GREEN check for both examples. The fixed pages are test-only. `npm run demo` and `npm run demo:search` serve the buggy page.

A new scenario is JSON data with one supported oracle: record count or DOM text. The app under test has to serve `GET /__reproseed/identity` and accept an authorized `POST /__reproseed/reset` on loopback HTTP. The minimizer should keep a step only when deleting it stops the same failure. A verified result uses five independent final replays (`verifyRuns` in the scenario budget). Those replays do not use the candidate cache. Do not lower that confirmation to make a test faster.

The generated spec asserts the scenario's intended result. It does not assert the buggy result, and it does not call `minimize()`.

## Pull requests

Use the pull-request template. In the description, say what behavior changed and which commands you ran.

- Keep the change focused. A documentation change should not also change minimization.
- Preserve failure signatures, the five final verification replays, loopback reset rules, and the current CLI contract unless the pull request is explicitly about one of those and says so.
- CI on the pull-request head has to pass before the change is ready. The three jobs are Quality and build, Chromium integration, and Package smoke verification.
- Do not publish to npm, create a GitHub Release, or push a git tag from a contribution.
- Leave version `0.1.0` unchanged. Do not publish, tag, or create a GitHub Release from a contribution. Publication remains the owner's step in [docs/publish-runbook.md](docs/publish-runbook.md).

## Coding and testing

- TypeScript, ECMAScript modules, and Node's built-in test runner (`node --test`).
- Match the surrounding style. Prefer a small, direct change over a new abstraction.
- Keep Playwright out of `src/core`.
- Scenario text is data. Do not expand `${...}` or `$(...)`.
- Read the reset credential from `REPROSEED_RESET_AUTHORIZATION` only. Do not add a flag for it.
- Add or update a test for the behavior you change. A comment that names a limitation is not a substitute for a failing assertion.
- Browser tests that share Chromium stay serial.

## Security-sensitive changes

Look especially carefully at changes to any of these:

- Loopback checks, app identity, or reset authorization
- Redirect handling
- Credential redaction in reports and command output
- Browser process cleanup
- GitHub Actions permissions, triggers, or third-party actions
- The files included by `npm pack`

Say in the pull request that the change touches one of those areas. [SECURITY.md](SECURITY.md) describes the target rules. Do not put an exploitable vulnerability in the pull request.

## Reproducibility

A result another person can rerun uses an ephemeral loopback port and a credential created for that run. `verified-one-minimal` means the kept steps survived single deletion and five fresh verification replays reproduced the original failure. It does not mean every shorter scenario was tried.

`--tune-delays` is separate from step minimization. A shorter delay is exported only after a new minimization and five fresh replays. If that check fails, the original verified scenario stays. Races are not monotonic. A duration the search did not run is not a result.
