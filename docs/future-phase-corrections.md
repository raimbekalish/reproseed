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

Phase 2 adds the Playwright replay runner under `src/runner`. One probe call is one isolated replay: authorized reset, a fresh browser context, the selected steps, then the record-count oracle. `attemptTimeoutMs` bounds that replay. The runner does not call `minimize()`. Connecting them is later work.
