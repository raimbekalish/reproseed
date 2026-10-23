# ReproSeed

Reproduce difficult bugs, minimize failing scenarios, and generate reliable regression tests.

Phase 0 shortens an ordered scenario while preserving one confirmed failure. It does not launch a browser.

Phase 1 is a loopback duplicate-submit demo.

Phase 2 replays a scenario from a clean authorized state in a fresh browser context. It returns an `ExecutionOutcome`.

Phase 3 passes that probe to the minimizer. A verified run of the 9-step duplicate-submit scenario writes `artifacts/report.json` with the reset credential removed.

Phase 4 turns that verified result into a Playwright regression test. The spec asserts the scenario's intended record count. For duplicate-submit that is one record, so the spec fails while the demo is buggy and passes after the in-flight submit fix. It does not run the minimizer again.

Phase 5 is the local `reproseed` command. It loads a scenario file, runs that same browser minimization, and writes a regression test only when the result is verified. It targets authorized loopback test applications only. It does not support arbitrary production websites.

Phase 6 uses that same minimizer, runner, exporter, and command for a second bug. The new failure is a stale search result: a delayed GET response for an older query overwrites the text of the current query. The oracle reads one element's `textContent`. It does not run a script from the scenario file.

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
npm run test:search
```

## Demo server

The server listens on `127.0.0.1` only. Reset stays disabled until `REPROSEED_APP_ID` and `REPROSEED_RESET_AUTHORIZATION` are both present in the process environment. Do not commit those values.

```bash
REPROSEED_APP_ID=duplicate-submit REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo
```

The default page is the buggy client. `startDemoServer({ page: "fixed-pending" })` is a test-only variant that ignores a second submit while the first request is still in flight and leaves the button enabled. Existing demo and runner tests keep using the default page.

## Stale search

`examples/stale-search` is a second loopback app. The page shows whatever search response arrived last. Searching for `alpha`, then `beta`, is correct when beta's response is the last one delivered. If the alpha response is held and arrives after beta, the buggy page replaces the beta text. That overwrite reads `Results for alpha (outdated)`. A search that never requests beta stays `Results for alpha`, so the minimizer treats it as a different failure. The intended text is still `Results for beta`.

The fixed page, `startSearchServer({ page: "fixed-generation" })`, keeps a counter for the latest click and ignores an older response. The default page does not.

```bash
REPROSEED_APP_ID=stale-search REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo:search
```

That process listens on `127.0.0.1:4020` unless `PORT` is set. Reset stays disabled until both environment values are present.

The DOM-text oracle is:

```json
{ "id": "dom-text", "selector": "#results", "expect": "Results for beta" }
```

Comparison rule: the runner reads `textContent` from exactly one match. It does not read `innerHTML` and it does not run JavaScript from the scenario. Both sides replace non-breaking spaces, collapse each whitespace run to one space, and trim. The comparison is then exact. The failure signature is `DOM_MISMATCH` and stores the selector, the normalized expected text, and the normalized actual text. A different actual string is a different failure. A missing element, several matches, or an invalid selector is a runner error, not `DOM_MISMATCH`.

A delay step can now name `GET` or `POST`. The runner still calls `route.fetch()`, waits, then `route.fulfill()`. The needle is matched against the path and query, not the origin. POST keeps substring matching, so `/api/records` still delays that POST. GET requires the needle to end on `&`, `#`, or the end of the path and query, so `/api/search?q=alpha` does not delay `/api/search?q=alphabet`, `/api/search?q=beta`, the document, or `GET /api/search-history`. `/__reproseed/identity` and `/__reproseed/reset` are never delayed.

Clean state is a declared `reset.verify` rule. The only rule is a same-origin `GET` that must return a JSON array of length 0. This search scenario checks `GET /api/search-history`, which is the list of queries the server accepted. After an authorized reset that list is empty. The app does not keep a record store for the runner. A scenario that omits `verify` still checks `GET /api/records`, which is what duplicate-submit uses. The DOM oracle does not replace the clean-state check.

The checked-in budget allows 80 replays and three minutes. A measured run on this tree used 52 replays, 14 cache hits, and about 30 seconds, and it removed the note, preview, decoy wait, and the gap while keeping the alpha GET delay and both searches.

## Regression test export

`exportPlaywrightTest(scenario, report)` writes a `@playwright/test` spec only when all of these are true:

- The report status is `verified-one-minimal`.
- A baseline oracle failure is known and differs from the intended result.
- The kept steps exist on the original scenario, stay in scenario order, and include their dependencies.
- Five separate final verification runs reproduced that same failure on those steps.

The sanitized report stores step ids and kinds only. The exporter reads selectors, values, paths, and the response delay from the original scenario. A record-count spec asserts `expect(actual).toBe(1)` for duplicate-submit, which is the intended count, not the two records the bug creates. A DOM-text spec asserts the intended text, `Results for beta`, and fails when the stale overwrite still shows `Results for alpha (outdated)`.

`npm run test:export` writes `artifacts/minimized.spec.ts` and `artifacts/stale-search.spec.ts`, runs each against its buggy app, and runs that same file against the fixed page. The duplicate-submit spec fails while the count is 2 instead of 1, and passes with one POST after the in-flight fix. The stale-search spec fails while the results still show the outdated alpha text, and passes on the generation guard. `artifacts/` is gitignored. Do not commit the spec or a reset token.

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

The same command minimizes the search scenario. Point `REPROSEED_ORIGIN` and `REPROSEED_APP_ID` at the search process:

```bash
export REPROSEED_APP_ID=stale-search
export REPROSEED_RESET_AUTHORIZATION="<the search process value>"
export REPROSEED_ORIGIN=http://127.0.0.1:4020
npm run cli -- minimize examples/stale-search/scenario.json \
  --report artifacts/stale-report.json \
  --spec artifacts/stale-search.spec.ts
```

The command does not run the generated test. While the duplicate-submit demo is still buggy, that test fails because the record count is 2 instead of the intended 1. While the search demo is still buggy, its test fails because the results say alpha instead of beta. That Playwright failure is not a minimization failure.

Output paths must stay inside the current directory and must not traverse a symlink. An existing report or spec is left unchanged unless `--force` is passed. A run that does not verify writes the report only. It does not write a regression test, and with `--force` it still does not replace an existing spec.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Verified minimization. The report and regression test were written. |
| 1 | Invalid usage, scenario, environment, target, or output path. |
| 2 | No reproducible failure, flaky baseline, or unstable result. |
| 3 | Replay or wall-clock budget exhausted. |
| 4 | Runner or output failure. |

`reproseed --help` and `reproseed minimize --help` print the same contract. `npm run build` compiles `src/` to `dist/` and copies `runtime-config.ts`, `delay-match.ts`, and `dom-text.ts` next to the compiled exporter. The generated spec embeds those files, so the built command does not need a TypeScript checkout.

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
- A loopback app that serves the UI the steps drive, `GET /__reproseed/identity`, an authorized `POST /__reproseed/reset`, and the scenario's clean-state `GET`. That GET must return a JSON array of length 0 after reset. When the scenario omits `reset.verify`, the path is `/api/records`. A record-count oracle reads its own record list. A DOM-text oracle reads the selected element's text instead.

That is the ReproSeed local-target contract. The file is not a drop-in test for an arbitrary site.
