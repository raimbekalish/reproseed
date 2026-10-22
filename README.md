# ReproSeed

Reproduce difficult bugs, minimize failing scenarios, and generate reliable regression tests.

Phase 0 shortens an ordered scenario while preserving one confirmed failure. It does not launch a browser.

Phase 1 is a loopback duplicate-submit demo.

Phase 2 replays a scenario from a clean authorized state in a fresh browser context. It returns an `ExecutionOutcome`.

Phase 3 passes that probe to the minimizer. A verified run of the 9-step duplicate-submit scenario writes `artifacts/report.json` with the reset credential removed.

Phase 4 turns that verified result into a Playwright regression test. The spec asserts the scenario's intended record count. For duplicate-submit that is one record, so the spec fails while the demo is buggy and passes after the in-flight submit fix. It does not run the minimizer again.

Phase 5 is the local `reproseed` command. It loads a scenario file, runs that same browser minimization, and writes a regression test only when the result is verified. It targets authorized loopback test applications only. It does not support arbitrary production websites.

Later phases must follow [docs/future-phase-corrections.md](docs/future-phase-corrections.md).

## Requirements

Node.js 22 or newer.

## Commands

```bash
npm install
npx playwright install chromium
npm run typecheck
npm run build
npm test
npm run test:demo
npm run test:runner
npm run test:export
npm run test:cli
npm run test:cli:e2e
```

## Demo server

The server listens on `127.0.0.1` only. Reset stays disabled until `REPROSEED_APP_ID` and `REPROSEED_RESET_AUTHORIZATION` are both present in the process environment. Do not commit those values.

```bash
REPROSEED_APP_ID=duplicate-submit REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo
```

The default page is the buggy client. `startDemoServer({ page: "fixed-pending" })` is a test-only variant that ignores a second submit while the first request is still in flight and leaves the button enabled. Existing demo and runner tests keep using the default page.

## Regression test export

`exportPlaywrightTest(scenario, report)` writes a `@playwright/test` spec only when all of these are true:

- The report status is `verified-one-minimal`.
- A baseline record-count failure is known and differs from the oracle's intended count.
- The kept steps exist on the original scenario, stay in scenario order, and include their dependencies.
- Five separate final verification runs reproduced that same failure on those steps.

The sanitized report stores step ids and kinds only. The exporter reads selectors, values, paths, and the response delay from the original scenario. The generated assertion is `expect(actual).toBe(1)` for this demo, which is the intended count, not the two records the bug creates.

`npm run test:export` writes `artifacts/minimized.spec.ts`, runs it against the buggy demo, and runs that same file against the fixed page. The command passes only when the buggy run fails because the count is 2 instead of 1, and the fixed run passes with one POST. `artifacts/` is gitignored. Do not commit the spec or a reset token.

## Minimize from the terminal

Build once, then start the demo and minimize the checked-in scenario. The scenario file has the nine duplicate-submit steps, including the removable note, preview, and decoy wait. It does not contain a reset credential. `npm run cli -- --version` prints the package version. The package is `private` and is not published to npm.

```bash
npm run build
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
npm run demo
```

In a second terminal, with the same app id and reset credential:

```bash
export REPROSEED_APP_ID=duplicate-submit
export REPROSEED_RESET_AUTHORIZATION="<the demo process value>"
export REPROSEED_ORIGIN=http://127.0.0.1:4010
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts
```

`REPROSEED_ORIGIN` and `REPROSEED_APP_ID` must name the process you just started. If the scenario file also sets `target.origin` or `target.appId`, those values have to match. The credential is read from the environment only. It is not accepted as a flag, and `${...}` or `$(...)` text in the scenario is not expanded.

On a verified run the command exits 0. It prints the original, kept, and removed step ids, the failure signature, the actual replay and cache counts, the elapsed time, and the two output paths. `verified-one-minimal` means 1-minimal under single deletion. It is not a proof of the globally shortest reproduction.

The command does not run the generated test. While the demo is still buggy, that test fails because the record count is 2 instead of the intended 1. That Playwright failure is not a minimization failure.

Output paths must stay inside the current directory and must not traverse a symlink. An existing report or spec is left unchanged unless `--force` is passed. A run that does not verify writes the report only. It does not write a regression test, and with `--force` it still does not replace an existing spec.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Verified minimization. The report and regression test were written. |
| 1 | Invalid usage, scenario, environment, target, or output path. |
| 2 | No reproducible failure, flaky baseline, or unstable result. |
| 3 | Replay or wall-clock budget exhausted. |
| 4 | Runner or output failure. |

`reproseed --help` and `reproseed minimize --help` print the same contract. `npm run build` compiles `src/` to `dist/` and copies `src/export/runtime-config.ts` next to the compiled exporter. The generated spec embeds that file, so the built command does not need a TypeScript checkout.

The spec reads these environment variables at runtime:

- `REPROSEED_ORIGIN` — loopback `http` origin of the app under test
- `REPROSEED_APP_ID` — value the app returns from `GET /__reproseed/identity`
- `REPROSEED_RESET_AUTHORIZATION` — credential for `POST /__reproseed/reset`

It refuses a non-loopback origin before it sends the credential. Retries are off.

To run the spec yourself, start the demo with the same app id and authorization, then point the origin at that process:

```bash
REPROSEED_ORIGIN=http://127.0.0.1:4010 \
REPROSEED_APP_ID=duplicate-submit \
REPROSEED_RESET_AUTHORIZATION="<the demo process value>" \
npx playwright test --config test/export/playwright.config.ts
```

`npx playwright test` without that config does not collect the generated spec or the `node:test` suites.

The spec imports only `@playwright/test` and Node built-ins. It does not import ReproSeed or call `minimize()`. Running it in another repository still requires:

- Node.js 22 or newer
- `@playwright/test` and Chromium at the same Playwright version as the `playwright` package in this repo (`npm test` checks that those two installed versions match)
- The three environment variables above, supplied by the runner and not committed
- A loopback app that serves the UI the steps drive, `GET /__reproseed/identity`, an authorized `POST /__reproseed/reset`, and the oracle's JSON record list

That is the ReproSeed local-target contract. The file is not a drop-in test for an arbitrary site.
