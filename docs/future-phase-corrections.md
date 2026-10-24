# Corrections for later phases

These corrections override the original architecture notes. Phase 0 records them and does not implement the runner, the demo, or reset.

## 1. Response delay holds the response, not the request

Inject latency with `route.fetch()`, wait, then `route.fulfill({ response })`.

Waiting before `route.continue()` holds the outgoing request inside Playwright. The server does not see it until the wait ends. That is delayed dispatch, not delayed response delivery. The duplicate-submit bug depends on the server accepting the POST while the browser is still waiting on the response.

## 2. The Submit button stays clickable

After a successful save, the demo button remains enabled. A client-side `locked` flag ignores later clicks.

Disabling the button makes Playwright's actionability checks wait in the no-delay control. The second click would time out instead of being ignored, and the control scenario would fail for the wrong reason.

## 3. Note is optional

The Note field is not required to submit. Submit steps must not list filling Note in `dependsOn`. The minimizer is expected to delete the Note step.

Email stays required. Submit steps depend on opening the form and filling Email.

## 4. Reset requires target identity and authorization

A loopback origin is not enough to reset state.

Before any reset request, the runner must:

- Confirm the process is an explicit local target (`target.appId` matches a value the app exposes for this purpose).
- Send `target.resetAuthorization` and require the app to accept it.
- Refuse the reset when either check fails.

`target.origin` still has to be loopback when the runner exists. Loopback without identity and authorization is not sufficient.

## 5. Replay counts, cache scope, and independent confirmation

Track probe invocations separately from candidate evaluations.

- A replay execution is one probe call.
- A candidate evaluation is one decision about a step subset. It may use several replays, a cache hit, or a dependency rejection with no replay.
- Cache a candidate only after its confirmation replays agree.
- Do not cache mixed results.
- Do not read or write the candidate cache for baseline runs or for the five final verification runs.

`budget.attemptTimeoutMs` is the runner's per-replay limit. The core enforces `maxReplayExecutions` and `maxWallClockMs` only. On timeout, the runner returns a timeout outcome. The minimizer does not treat that outcome as the target failure.

## Phase boundary

Phase 1 should add the buggy demo and a direct script that shows the delay is load-bearing. It should follow corrections 1–4. It should not add the React dashboard, an AI API, or a CLI.

Phase 2 adds the Playwright replay runner under `src/runner`. One probe call is one isolated replay: authorized reset, a fresh browser context, the selected steps, then the record-count oracle. `attemptTimeoutMs` bounds that replay. The runner does not call `minimize()`.

Phase 3 connects `startReplayRuntime().probeFor(scenario)` to `minimize()`. Baseline runs and the five verification runs always execute and do not use the candidate cache. The record-count oracle still runs only after the selected steps and settled responses. `artifacts/report.json` omits `resetAuthorization`. This phase does not add a CLI, a dashboard, an AI API, or a test exporter.

Phase 4 adds `src/export`. It writes a Playwright spec from the original scenario plus a `verified-one-minimal` report whose five final runs reproduced one known record-count failure. The spec asserts the oracle's intended count (`expect(actual).toBe(1)` for duplicate-submit). It must not be changed so that two records are the expected result. The sanitized report is not enough on its own: selectors, values, and delay durations come from the scenario. The spec does not call `minimize()`. Unstable, incomplete, and budget-exhausted reports are refused.

Phase 5 adds the local `reproseed minimize` command. It loads a scenario file, takes the reset credential from `REPROSEED_RESET_AUTHORIZATION`, and runs `minimizeWithBrowser()`. The Playwright spec is exported only from that same verified report. The built CLI embeds `runtime-config.ts` from the package, not from a source checkout. The command still refuses non-loopback targets. It does not add a dashboard, an AI API, a cloud backend, or support for arbitrary production websites.

## Phase 6 — two failure types, one engine

Phase 6 adds a DOM-text oracle and GET response delays. The minimizer in `src/core` still does not import Playwright and does not mention either example. A probe returns an `ExecutionOutcome`. The baseline signature is a `TargetSignature`: record-count (`DUPLICATE` or `COUNT_MISMATCH`) or DOM text (`DOM_MISMATCH`). Runner timeouts and errors are still not the target. Signature equality includes the actual DOM text, so a different rendered string is a different failure. The search page labels an older response that replaces a newer one (`Results for alpha (outdated)`). A probe that only searches for alpha renders `Results for alpha` and does not count as that failure. The minimizer has no search-specific code; it only compares those signatures.

DOM comparison is defined in `src/runner/dom-text.ts`. The runner uses Playwright's locator `textContent` on exactly one element, then normalizes whitespace. The scenario file cannot supply a script. Missing, multiple, and invalid selectors are runner errors.

GET and POST delays share `route.fetch()`, the wait, and `route.fulfill()`. Matching lives in `src/runner/delay-match.ts`. POST substring matching on the path and query is unchanged. GET uses a boundary so one search query does not delay another. Control paths are never delayed.

The exporter writes one spec shape for both oracles. It asserts the intended result. Five fresh verification replays are still required. Phase 6 checked every app with `GET /api/records`. Phase 7A replaces that hardcoded path with `reset.verify`.

## Phase 7A — declarative clean-state verification

`reset.verify` is optional scenario data. The only supported rule is `{"kind":"json-array-empty","method":"GET","path":"/same-origin-path"}`. The runner, the CLI preflight, and the generated Playwright test all GET that path after the authorized reset and require a JSON array of length 0. Redirects and non-loopback paths are refused. The file cannot supply a script or a shell command.

When `verify` is omitted, the check remains `GET /api/records`, so existing duplicate-submit scenarios stay valid. The stale-search scenario sets the path to `/api/search-history`, which is the server's list of accepted queries. That app no longer exposes a record list for the runner. Identity and reset authorization are unchanged.

One measured minimization of `examples/stale-search/scenario.json` used 52 replay executions, 14 cache hits, and about 30 seconds. The scenario budget allows 80 replays and 180 seconds so a slower machine can finish the same search without raising the ceiling to the old 90-replay, six-minute draft.

This phase does not add a dashboard, an AI API, a cloud backend, authentication, a new database, or npm publication.

## Phase 7B — verified fault-duration minimization

`--tune-delays` runs after a verified step minimization. It does not change delta debugging. Each candidate is a new scenario object with one shorter positive integer delay, and its probe closes over that object. The original scenario is not mutated. The search is a bounded coarse-to-fine grid. It is not binary search, and a miss does not decide an unmeasured duration. The reported duration is the smallest confirmed candidate among the durations that were replayed.

Confirmation uses fresh replays, not the step-minimizer cache. A promoted result is minimized again at that delay and then checked with five new verification replays of the original signature. If that second minimization is not verified, the phase 7A result stays the exported scenario. One kept delay step can be tuned. More than one kept delay is skipped and reported. The timing replay cap and wall clock are separate from `maxReplayExecutions` and `maxWallClockMs`.
