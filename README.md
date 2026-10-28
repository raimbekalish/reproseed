# ReproSeed

ReproSeed is a local command-line tool. You give it a failing scenario for an authorized loopback test application. It deletes steps that are not required for that failure, then writes a Playwright regression test for the steps that remain.

The published release is `0.1.0`, released October 25, 2026. This repository is preparing `0.2.0`. `package.json` stays at `0.1.0`, and `reproseed --version` prints `0.1.0`, until that release is published. ReproSeed source code is [MIT licensed](LICENSE), copyright (c) 2026 Raimbek Alish. Third-party dependencies keep their own licenses. Playwright, which the CLI uses to drive Chromium, is Apache-2.0.

## Install

Node.js 22 or newer. The tested environments are macOS for development and GitHub-hosted Ubuntu with Node.js 22. Windows is not tested.

```bash
npm install reproseed
npx playwright install --with-deps --no-shell chromium
npx reproseed --help
npx reproseed --version
```

`npm install reproseed` from the registry today installs published `0.1.0`. That release minimizes a scenario and writes a regression test. It does not include `doctor`, `init`, or `--trace`.

A tarball packed from this repository includes those commands. It also includes [docs/integrate-your-app.md](docs/integrate-your-app.md) and [docs/trace-evidence.md](docs/trace-evidence.md). After you install that tarball, the same files are at `node_modules/reproseed/docs/`. The copies on [GitHub](https://github.com/raimbekalish/reproseed/blob/main/docs/integrate-your-app.md) follow `main` and can move ahead of a published version. The copy inside the package matches the version you installed.

The install provides the `reproseed` command and Playwright `1.64.1`. The browser is that release's downloaded Chromium, selected with `channel: "chromium"`. It is not system Chrome and not `chrome-headless-shell`.

A generated spec imports `@playwright/test`. That package is not a dependency of `reproseed`, and this install does not add it. Install it yourself before you run the spec:

```bash
npm install --save-dev @playwright/test@1.64.1
```

Running the spec also needs the Chromium above, `REPROSEED_ORIGIN`, `REPROSEED_APP_ID`, `REPROSEED_RESET_AUTHORIZATION`, and a loopback application you started. The demo servers are in this git repository. They are not in the npm package. The quick start below is for a checkout of this repository. The integration guide is the path that does not use those demos.

## What it currently supports

Two browser bugs, each with its own checked-in example:

| Example | Bug | Oracle | Failure code |
| --- | --- | --- | --- |
| [Duplicate submit](examples/duplicate-submit/scenario.json) | A second click while a delayed POST is still in flight creates two records. The intended result is one record. | Record count from a same-origin JSON list | `DUPLICATE` or `COUNT_MISMATCH` |
| [Stale search](examples/stale-search/scenario.json) | A delayed response for an older query overwrites the text of the current query. The intended text is the current query. | `textContent` of one element, after whitespace is normalized | `DOM_MISMATCH` |

The minimizer compares failure signatures. It has no example-specific code. A scenario file is data. It cannot supply a script or a shell command.

Design notes that are not a user guide live in [docs/future-phase-corrections.md](docs/future-phase-corrections.md).

## What it does not support

- Production websites, signed-in applications, or any target that is not `http` on `127.0.0.1`, `localhost`, or `::1`.
- Arbitrary applications. The target must expose `GET /__reproseed/identity` and an authorized `POST /__reproseed/reset`. `init` and `doctor` do not add those endpoints.
- A proof of the globally shortest reproduction. `verified-one-minimal` means 1-minimal under single deletion, confirmed by five fresh replays.
- AI assistance, a hosted service, a dashboard, or a database.
- Windows, or any operating system other than the ones exercised so far: development on macOS, and CI on GitHub-hosted Ubuntu with Node.js 22.
- System Chrome or `chrome-headless-shell`. Launches use Playwright's downloaded Chromium revision with `channel: "chromium"`.

## Integrate an application

[docs/integrate-your-app.md](docs/integrate-your-app.md) is the path to a scenario on your own loopback app. From an install of this tree, the same guide is `node_modules/reproseed/docs/integrate-your-app.md`. `reproseed init` writes a starter scenario. `reproseed doctor` checks it without sending `POST /__reproseed/reset`. For a record-count scenario it checks `oracle.request.path` for the record shape the minimizer reads. `reset.verify.path` only has to return a JSON array, and the two paths can differ. It treats a connection failure, a redirect, a missing page, and a server error as different results. `examples/opt-in-ticket` is one application that opts in. Its default page is buggy. A test-only fixed page is used to show the same generated spec passing, and that page is not what `npm run demo:ticket` serves. The example server is not one of the two demos below, and it is not in the npm package. Published `0.1.0` does not include `doctor`, `init`, or `--trace`. Those commands are in this repository for the `0.2.0` candidate.

## Quick start

Requirements: Node.js 22 or newer, npm, and Playwright's Chromium for the `playwright` version locked in `package-lock.json` (currently 1.64.1).

```bash
npm ci
npx playwright install --with-deps --no-shell chromium
npm run build
```

`--no-shell` skips `chrome-headless-shell`. `--with-deps` installs Linux libraries Chromium needs. On macOS it does not change the system. CI runs the same browser through `node scripts/install-playwright-chromium.mjs`, which also checks that the launched process exits.

Generate a reset credential in the demo terminal and paste that printed value into the second terminal. Do not commit it, and do not reuse a value from another project.

```bash
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
printf '%s\n' "$REPROSEED_RESET_AUTHORIZATION"
npm run demo
```

Leave that process running. In a second terminal:

```bash
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="<paste the value printed by the demo terminal>"
export REPROSEED_ORIGIN=http://127.0.0.1:4010
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts
```

A verified run exits 0 and prints `Status: verified-one-minimal`. The next sections explain the two examples, the two different minimization stages, and how to read the files it wrote.

## Installation requirements

- Node.js 22 or newer. [`.node-version`](.node-version) contains `22`. Tests are TypeScript files run by Node's type stripping.
- npm, installing from `package-lock.json` with `npm ci`.
- Playwright's downloaded Chromium. That cache is `~/Library/Caches/ms-playwright` on macOS and `~/.cache/ms-playwright` on Linux. Do not point `PLAYWRIGHT_BROWSERS_PATH` at a directory that lacks this revision unless the same revision is already in the default cache.

`npm run build` compiles `src/` to `dist/` and copies `runtime-config.ts`, `delay-match.ts`, and `dom-text.ts` next to the compiled exporter. A generated spec embeds those files, so running the spec does not need this checkout's `src/`.

## Example: duplicate submit

The demo listens on `http://127.0.0.1:4010` unless `PORT` is set. Reset stays disabled until both `REPROSEED_APP_ID` and `REPROSEED_RESET_AUTHORIZATION` are set. The default page is the buggy client: a second submit during a delayed POST creates a second record.

Start it with the quick-start commands above. The scenario opens the page, fills email and an unnecessary note, delays `POST /api/records` by 2000ms, clicks submit, waits 800ms, and clicks submit again. The oracle expects one record whose email is `a@example.com`. The bug produces two.

On a verified run the kept steps are the ones still required for `DUPLICATE`. The note and other decoys are removed. The written spec asserts the intended count of 1. It does not assert the buggy count, and it does not call `minimize()`.

## Example: stale search

Stop the other demo if you want a quiet machine, or leave it on port 4010. This demo uses port 4020.

```bash
export REPROSEED_APP_ID=stale-search
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
printf '%s\n' "$REPROSEED_RESET_AUTHORIZATION"
npm run demo:search
```

In the second terminal, paste the value that command printed:

```bash
export REPROSEED_APP_ID=stale-search
export REPROSEED_RESET_AUTHORIZATION="<paste the value printed by the demo terminal>"
export REPROSEED_ORIGIN=http://127.0.0.1:4020
npm run cli -- minimize examples/stale-search/scenario.json \
  --report artifacts/stale-report.json \
  --spec artifacts/stale.spec.ts
```

The page shows whichever search response arrived last. Searching for `alpha`, then `beta`, is correct when beta arrives last. If the delayed alpha response arrives after beta, the buggy page replaces the text with `Results for alpha (outdated)`. The oracle expects `Results for beta` in `#results`. A search that never requests beta stays `Results for alpha`, and the minimizer treats that as a different failure.

Run one minimization at a time. Overlapping Chromium sessions on one machine can close a browser that another run still needs.

## Step minimization

Step minimization decides which scenario steps to keep. It is the default behavior of `reproseed minimize`. `--tune-delays` is a later, optional stage and is off unless you pass it.

The command replays the scenario in Chromium, drops one step at a time, and keeps a step when dropping it stops the same failure from coming back. Dependencies still have to be satisfied. Five separate final replays then have to reproduce that failure. Those five runs do not use the candidate cache.

That result is `verified-one-minimal`. Removing any one remaining step no longer reproduces the same failure. It is not a claim that some other, untested subset would be shorter.

A regression test is written only from that verified report. A run that does not verify writes the report and does not write a spec. `--force` replaces an existing report, and it still does not replace an existing spec unless the new run verified.

Output paths must stay inside the current directory and must not traverse a symlink.

| Exit | Meaning |
| --- | --- |
| 0 | Verified minimization. The report and regression test were written. |
| 1 | Invalid usage, scenario, environment, target, or output path. |
| 2 | No reproducible failure, flaky baseline, or unstable result. |
| 3 | Replay or wall-clock budget exhausted. |
| 4 | Runner or output failure. |

`reproseed --help` and `reproseed minimize --help` print the same contract.

## Network delay optimization

`--tune-delays` does not choose which steps to keep. After a verified step minimization, it replays shorter network delays for one kept delay step. Several kept delay steps are skipped. The race is not treated as monotonic: a shorter delay that fails to reproduce the bug does not prove that every longer delay would reproduce it.

```bash
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts \
  --force \
  --tune-delays
```

The default grid is 250ms, with at most 36 timing replays and 180000ms of timing-stage wall clock. Those limits are separate from the scenario budget. Override them with `--timing-resolution`, `--timing-max-replays`, and `--timing-max-ms`. The search measures at most 4 coarse durations and 4 finer ones. It reports the smallest confirmed duration among the durations it actually replayed.

Two agreeing samples are not enough to export that duration. A shorter delay is exported only after a new minimization and five fresh verification replays reproduce the original failure. Otherwise the original verified scenario is exported unchanged. A very short delay can pass the two samples and then miss the later check when the machine spends longer than the delay between the two requests. The stale-search live test uses a 400ms grid for that reason. The duplicate-submit live test keeps the default 250ms grid. The product default remains 250ms.

## Reports

The command prints a summary: status, kept and removed step ids, failure signature, replay and cache counts, elapsed time, and the two output paths. `artifacts/` is gitignored.

`artifacts/report.json` is the sanitized report. The reset credential is omitted. Any copy of that credential at least 8 characters long is replaced with `[redacted]`. `scenario.steps` in the file lists step id and kind only. Selectors and typed values remain in the scenario you passed in and, after verification, in the generated spec.

```bash
node --input-type=module -e '
import { readFile } from "node:fs/promises";
const artifact = JSON.parse(await readFile("artifacts/report.json", "utf8"));
const report = artifact.report;
console.log(report.status);
console.log(report.keptStepIds.join(", "));
console.log(report.counts);
'
```

On a verified duplicate-submit run, `report.status` is `verified-one-minimal` and `report.counts.verifyReplays` is 5. `report.singleDeletion` records what happened when each remaining step was removed. `report.baselineSignature` is the failure the minimizer reproduced, including the oracle id and the actual value.

Do not commit the report. It can still contain scenario data such as the example email address. See [SECURITY.md](SECURITY.md) before you share one.

## Optional trace

`--trace` is off by default. After `verified-one-minimal`, ReproSeed can replay the exported scenario once more with Playwright tracing:

```bash
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts \
  --trace artifacts/repro.zip
```

That replay is not one of the five verification replays and is not added to the replay counts. Tracing stays off while steps are being removed. The zip is verified evidence only when the extra replay reproduces the same failure. Open it with `npx playwright show-trace artifacts/repro.zip`. The trace can contain page data. [docs/trace-evidence.md](docs/trace-evidence.md) explains what the file does and does not prove.

## Exported Playwright test

`reproseed minimize` does not run the generated test. While the demo is still the buggy page, that test fails. A Playwright failure on the buggy page means the regression caught the bug. It does not mean minimization failed.

With the duplicate-submit demo still running, paste the same printed credential:

```bash
REPROSEED_ORIGIN=http://127.0.0.1:4010 \
REPROSEED_APP_ID=duplicate-submit \
REPROSEED_RESET_AUTHORIZATION="<paste the value printed by the demo terminal>" \
npx playwright test --config test/export/playwright.config.ts
```

That config runs `artifacts/minimized.spec.ts` only. `npx playwright test` without it does not collect the generated spec or the `node:test` suites. Retries are off.

The spec imports `@playwright/test` and Node built-ins. It does not import ReproSeed. Running it elsewhere still requires Node.js 22, `@playwright/test` and Chromium at this repo's Playwright version, the three environment variables, and a loopback app that serves the UI, identity, authorized reset, and the clean-state `GET`.

`npm run test:export` is the repository's RED/GREEN check. It writes a spec under `artifacts/` and runs it against the buggy page and a fixed page. The fixed pages are test-only (`fixed-pending` for duplicate submit, `fixed-generation` for stale search). The `npm run demo` and `npm run demo:search` commands serve the buggy page.

## Security restrictions

Reset is allowed only when all of these are true:

- The origin is `http` on `127.0.0.1`, `localhost`, or `::1`, with no userinfo, path, query, or fragment.
- `REPROSEED_APP_ID` matches the value the app returns from `GET /__reproseed/identity`.
- `REPROSEED_RESET_AUTHORIZATION` is sent to `POST /__reproseed/reset` and the app accepts it.

Loopback alone is not authorization. The credential is read from the environment only. It is not a flag, and `${...}` or `$(...)` text in the scenario is not expanded. Identity, reset, and clean-state requests refuse redirects. Navigation that would leave the authorized origin is refused.

The full rules for targets, reports, and vulnerability reports are in [SECURITY.md](SECURITY.md).

## Development and tests

Contributor setup, directory map, and pull-request expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

No browser:

```bash
npm run typecheck
npm run build
npm test
npm run test:cli
```

Browser suites, one after another:

```bash
npm run test:demo
npm run test:search
npm run test:runner
npm run test:export
npm run test:cli:e2e
```

`npm run test:browsers` runs those five commands in that order. `npm run test:cli:e2e` needs a prior `npm run build`. Every suite starts its own loopback server on an ephemeral port and generates the reset credential in the test process.

Package check, without publishing:

```bash
npm run test:package
```

That builds, runs `npm pack`, and installs the tarball outside this checkout. `reproseed --help`, `reproseed --version`, `reproseed init`, and `reproseed doctor` must run from that install. `--version` prints `0.1.0`. The tarball contains `LICENSE`, `dist/` (including the embedded `dist/export/runtime-config.ts`, `delay-match.ts`, and `dom-text.ts` assets), this README, and the two original example scenario files. It does not contain credentials, `.env` files, `artifacts/`, test results, `node_modules`, the TypeScript source tree, or `examples/opt-in-ticket`.

## Continuous integration

[![CI](https://github.com/raimbekalish/reproseed/actions/workflows/ci.yml/badge.svg)](https://github.com/raimbekalish/reproseed/actions/workflows/ci.yml)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests to `main`, on pushes to `main`, and from `workflow_dispatch`. It uses GitHub-hosted `ubuntu-latest` and Node.js 22. The workflow token can only read repository contents. Jobs do not receive repository secrets, do not publish to npm, and do not create a GitHub Release.

| Job | What it checks |
| --- | --- |
| Quality and build | `npm ci`, typecheck, build, unit tests, and CLI tests that do not launch a browser |
| Chromium integration | The locked Playwright Chromium build, then the browser suites one after another |
| Package smoke verification | `npm pack`, then `reproseed --help`, `--version`, `init`, and `doctor` from a clean install of that tarball |

A new push to the same pull request cancels the previous run. The badge shows the latest run on `main`.

## Release status

`0.1.0` (October 25, 2026) is the first release. `package.json` sets `license` to `MIT` and does not set `private`. [LICENSE](LICENSE) is the MIT license for this source tree, with the copyright line `Copyright (c) 2026 Raimbek Alish`. Dependencies installed from npm keep their own licenses. [docs/licensing-proposal.md](docs/licensing-proposal.md) records that choice. [CHANGELOG.md](CHANGELOG.md) and [docs/v0.1.0-release-notes.md](docs/v0.1.0-release-notes.md) describe this version. There are no earlier releases. Do not publish or tag from a pull request.
