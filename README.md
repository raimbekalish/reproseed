# ReproSeed

ReproSeed reproduces one difficult bug in a local test application, removes steps that are not required for that failure, and writes a Playwright regression test.

It is a local command for authorized loopback applications. The application must identify itself and accept a reset credential supplied in the environment. ReproSeed does not target production websites, and it does not crawl or sign in to arbitrary sites. The npm package is private (`0.1.0`) and is not published.

Two checked-in examples are supported:

- **Duplicate submit.** A second click while a delayed POST is still in flight creates two records. The intended result is one record.
- **Stale search.** A delayed response for an older query overwrites the text of the current query. The intended text is the current query.

Later design constraints are in [docs/future-phase-corrections.md](docs/future-phase-corrections.md).

## Continuous integration

[![CI](https://github.com/raimbekalish/reproseed/actions/workflows/ci.yml/badge.svg)](https://github.com/raimbekalish/reproseed/actions/workflows/ci.yml)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests targeting `main`, on pushes to `main`, and when started manually with `workflow_dispatch`. It uses GitHub-hosted `ubuntu-latest` runners and Node.js 22 from [`.node-version`](.node-version). The workflow token can only read repository contents. Jobs do not receive repository secrets, do not publish to npm, and do not create a GitHub Release.

The badge shows the latest run on `main`.

Three jobs run in parallel. A new push to the same pull request cancels the previous run.

| Job | What it checks |
| --- | --- |
| Quality and build | `npm ci`, typecheck, build, unit tests, and CLI tests that do not launch a browser |
| Chromium integration | The Playwright Chromium build pinned in `package-lock.json`, then the browser suites one after another |
| Package smoke verification | `npm pack` and `reproseed --help` / `reproseed --version` from a clean install of that tarball |

Browser suites stay in one job because overlapping Chromium processes have closed a browser during a replay. The workflow does not upload test artifacts.

## Requirements

- Node.js 22 or newer. Tests are TypeScript files executed by Node's type stripping.
- npm, installing from `package-lock.json` with `npm ci`.
- Playwright's downloaded Chromium for the `playwright` version in the lockfile. That is not system Chrome and not `chrome-headless-shell`.

```bash
npm ci
npx playwright install --with-deps --no-shell chromium
```

`--no-shell` skips `chrome-headless-shell`. ReproSeed launches the downloaded Chromium revision with `channel: "chromium"`. On macOS 26 the headless shell can abort with `SIGTRAP` during replays, so a failed launch does not switch to that binary or to a browser installed elsewhere. `--with-deps` installs the Linux libraries Chromium needs. On macOS it does not change the system.

`npm run test:browsers` and the Chromium CI job use that browser. Do not point `PLAYWRIGHT_BROWSERS_PATH` at a directory that lacks this revision unless the same revision is already in Playwright's default cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux).

## Tests

No browser:

```bash
npm run typecheck
npm run build
npm test
npm run test:cli
```

Browser suites. Run them one at a time:

```bash
npm run test:demo
npm run test:search
npm run test:runner
npm run test:export
npm run test:cli:e2e
```

`npm run test:browsers` runs those five commands in that order. `npm run test:runner` also passes `--test-concurrency=1`. Tests inside each file stay serial.

`npm run test:export` is the RED/GREEN check. It writes a spec under `artifacts/` and runs it against the buggy page and the fixed page. The duplicate-submit spec fails while the count is 2 and passes after the in-flight submit fix. The stale-search spec fails while the results still show the outdated alpha text and passes on the generation guard. `artifacts/` is gitignored. Do not commit a spec or a reset token.

`npm run test:cli:e2e` builds nothing by itself. Run `npm run build` first. The Chromium CI job does that before the end-to-end command.

Full local check, in order:

```bash
npm ci
npx playwright install --with-deps --no-shell chromium
npm run typecheck
npm run build
npm test
npm run test:cli
npm run test:browsers
npm run test:package
```

Every suite above starts its own loopback server on an ephemeral port and generates the reset credential in the test process. No production credential is required.

## Package verification

Keep `private: true`. Do not publish this package.

```bash
npm run test:package
```

That command builds, runs `npm pack`, and installs the tarball in a temporary directory outside this checkout. From that install, `reproseed --help` and `reproseed --version` must succeed. `--version` prints the version in `package.json` (currently `0.1.0`). The installed tree has no `src/` directory. The version is read from the installed `package.json`.

The tarball contains `dist/` (including the embedded `dist/export/runtime-config.ts`, `delay-match.ts`, and `dom-text.ts` assets), `README.md`, and the two example scenario files. It does not contain credentials, `.env` files, `artifacts/`, test results, `node_modules`, or the TypeScript source tree. `dist/cli.js` is executable and starts with a Node shebang.

`npm run build` compiles `src/` to `dist/` and copies those three assets next to the compiled exporter. A generated spec embeds them, so the built command does not need this checkout.

## Supported checks

A scenario can use one of these oracles. The minimizer compares failure signatures. It has no example-specific code. Runner timeouts and errors are not the target failure. The scenario file cannot supply a script or a shell command.

| Oracle | Failure code | What it compares |
| --- | --- | --- |
| Record count | `DUPLICATE` or `COUNT_MISMATCH` | A same-origin JSON record list. Duplicate-submit expects 1 record and the bug produces 2. |
| DOM text | `DOM_MISMATCH` | `textContent` of exactly one element, after whitespace is normalized. The actual string is part of the failure identity. |

A missing element, several matches, or an invalid selector is a runner error, not `DOM_MISMATCH`. A search that never requests the current query is a different failure from the stale overwrite.

Clean state is optional `reset.verify`. The only rule is a same-origin `GET` that must return a JSON array of length 0. The stale-search scenario checks `GET /api/search-history`. When `verify` is omitted, the check stays `GET /api/records`, which is what duplicate-submit uses. Redirects and non-loopback paths are refused.

A delay step can name `GET` or `POST`. The runner calls `route.fetch()`, waits, then `route.fulfill()`. The needle is matched against the path and query, not the origin. POST uses a substring, so `/api/records` delays that POST. GET must end on `&`, `#`, or the end of the path and query, so `/api/search?q=alpha` does not delay `/api/search?q=alphabet`. `/__reproseed/identity` and `/__reproseed/reset` are never delayed.

## verified-one-minimal

`verified-one-minimal` means the kept steps are 1-minimal under single deletion: removing any one remaining step no longer reproduces the same failure, dependencies are still satisfied, and five separate final verification replays reproduced that failure. Those five runs do not use the candidate cache. The result is not a proof of the globally shortest reproduction.

A regression test is written only from that verified report. The spec asserts the scenario's intended result (`expect(actual).toBe(1)` for duplicate-submit, `Results for beta` for stale search). It does not expect the buggy result, and it does not call `minimize()`.

## Minimize from the terminal

Build once, then start the demo with a credential that exists only in that process:

```bash
npm run build
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
npm run demo
```

In a second terminal, with the same app id and credential:

```bash
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="<the demo process value>"
export REPROSEED_ORIGIN=http://127.0.0.1:4010
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts
```

`REPROSEED_ORIGIN` and `REPROSEED_APP_ID` must name the process you just started. If the scenario file also sets `target.origin` or `target.appId`, those values have to match. The credential is read from the environment only. It is not accepted as a flag, and `${...}` or `$(...)` text in the scenario is not expanded.

On a verified run the command exits 0. It prints the original, kept, and removed step ids, the failure signature, the replay and cache counts, the elapsed time, and the two output paths.

The same command minimizes the search scenario. Point the origin and app id at the search process (`http://127.0.0.1:4020` and `stale-search` unless `PORT` is set).

The command does not run the generated test. While the demo is still buggy, that test fails. A Playwright failure on the buggy page is not a minimization failure.

Output paths must stay inside the current directory and must not traverse a symlink. An existing report or spec is left unchanged unless `--force` is passed. A run that does not verify writes the report only. It does not write a regression test, and with `--force` it still does not replace an existing spec.

| Code | Meaning |
| --- | --- |
| 0 | Verified minimization. The report and regression test were written. |
| 1 | Invalid usage, scenario, environment, target, or output path. |
| 2 | No reproducible failure, flaky baseline, or unstable result. |
| 3 | Replay or wall-clock budget exhausted. |
| 4 | Runner or output failure. |

### `--tune-delays`

`--tune-delays` is optional and off by default. After a verified step minimization it replays shorter network delays in Chromium. It does not change which steps were kept, and it does not treat the race as monotonic.

The default grid is 250ms, with at most 36 timing replays and 180000ms of timing-stage wall clock. Those limits are separate from the scenario budget. Override them with `--timing-resolution`, `--timing-max-replays`, and `--timing-max-ms`. The search measures at most 4 coarse durations and 4 finer ones. It reports the smallest confirmed duration among the durations it actually replayed. It does not claim anything about a duration it did not run.

One kept delay can be tuned. Several kept delays are skipped. A shorter delay is exported only after a new minimization and five fresh verification replays reproduce the original failure. Otherwise the original verified scenario is exported unchanged.

`reproseed --help` and `reproseed minimize --help` print the same contract.

## Authorized loopback targets

Reset is allowed only when all of these are true:

- The origin is `http` on `127.0.0.1`, `localhost`, or `::1`, with no userinfo, path, query, or fragment.
- `REPROSEED_APP_ID` matches the value the app returns from `GET /__reproseed/identity`.
- `REPROSEED_RESET_AUTHORIZATION` is sent to `POST /__reproseed/reset` and the app accepts it.

Loopback alone is not authorization. The demos bind to `127.0.0.1` and leave reset disabled until both environment values are present. Do not commit those values. The generated spec refuses a non-loopback origin before it sends the credential. Retries are off.

The spec imports `@playwright/test` and Node built-ins. It does not import ReproSeed. Running it in another repository still requires Node.js 22, `@playwright/test` and Chromium at the same Playwright version as this repo, the three environment variables, and a loopback app that serves the UI, identity, authorized reset, and the clean-state `GET`. That is the local-target contract. The file is not a test for an arbitrary site.

To run a generated spec, start the demo with the same app id and authorization, then:

```bash
REPROSEED_ORIGIN=http://127.0.0.1:4010 \
REPROSEED_APP_ID=duplicate-submit \
REPROSEED_RESET_AUTHORIZATION="<the demo process value>" \
npx playwright test --config test/export/playwright.config.ts
```

`npx playwright test` without that config does not collect the generated spec or the `node:test` suites.

## Demo servers

```bash
REPROSEED_APP_ID=duplicate-submit REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo
```

The duplicate-submit server listens on `127.0.0.1:4010` unless `PORT` is set. The default page is the buggy client. `startDemoServer({ page: "fixed-pending" })` is a test-only variant that ignores a second submit while the first request is still in flight.

```bash
REPROSEED_APP_ID=stale-search REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo:search
```

The search server listens on `127.0.0.1:4020` unless `PORT` is set. The page shows whatever search response arrived last. Searching for `alpha`, then `beta`, is correct when beta's response is delivered last. If the alpha response arrives after beta, the buggy page replaces the beta text with `Results for alpha (outdated)`. A search that never requests beta stays `Results for alpha`, so the minimizer treats it as a different failure. `startSearchServer({ page: "fixed-generation" })` ignores an older response. The default page does not.

The DOM-text oracle is:

```json
{ "id": "dom-text", "selector": "#results", "expect": "Results for beta" }
```

The checked-in search budget allows 80 replays and three minutes. A measured run on the development machine used 52 replays, 14 cache hits, and about 30 seconds. CI on a GitHub-hosted runner is slower. The budget is the limit; that measurement is not a guarantee.
