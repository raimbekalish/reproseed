# Trace evidence

`--trace` records one Playwright trace of the minimized scenario. It is off unless you pass a `.zip` path.

```bash
reproseed minimize scenario.json --trace artifacts/repro.zip
```

From this repository, the same flag is:

```bash
npm run cli -- minimize examples/duplicate-submit/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/minimized.spec.ts \
  --trace artifacts/repro.zip
```

The path has to end in `.zip`, stay inside the current directory, and not be a symlink. An existing file is left unchanged unless you also pass `--force`. The trace path cannot be the scenario file, the report, or the spec.

## What gets recorded

Minimization runs first, with tracing off. ReproSeed still requires `verified-one-minimal` and five fresh verification replays before it writes the regression spec.

After that report and spec are written, ReproSeed replays the exported scenario once in a new browser context. That is the scenario selected for the regression test, including a shorter delay when timing verification kept one. The replay uses the kept steps. It uses the same loopback origin check, target identity check, reset credential check, redirect refusal, and browser cleanup as any other replay.

Playwright tracing starts after that context is created and before the first page action. The options are screenshots, DOM snapshots, and no local source files. The trace title is `ReproSeed evidence`. The reset request is a Node fetch made before the browser context exists, so the credential is not placed in the trace title or in ReproSeed's log lines.

The extra replay is not one of the five verification replays. It is not added to `replayExecutions` or to the scenario's replay budget.

## Verified evidence

A successful minimization does not mean the traced replay will hit the same race. Tracing adds timing overhead.

ReproSeed compares the extra replay with the verified failure signature:

| Status | Meaning |
| --- | --- |
| `verified` | The extra replay failed with the same target signature, and the zip was saved. |
| `not-reproduced` | The extra replay finished with a pass or a different failure. The zip is saved and is not verified evidence. |
| `failed` | The replay or the trace save failed. The requested zip is not written. |

Only `verified` is a matching reproduction of the minimized bug. The command keeps the minimization exit code either way. When the trace is missing or is not a match, it writes a warning. It does not rewrite the report or the spec that the verified run already published.

`verified-one-minimal` is still 1-minimal under single deletion. A trace does not prove a globally shortest reproduction, and it does not promise that capture will succeed on every run.

## Open the trace

```bash
npx playwright show-trace artifacts/repro.zip
```

The Trace Viewer shows the actions, DOM snapshots, screenshots, and network events from that one replay. Select an action to see its snapshot and the network calls around it.

This zip comes from Playwright's library tracing API. That API records browser operations and network activity. It does not record Playwright Test assertions such as `expect`. To see those assertions, run the exported spec with Playwright Test tracing configured separately. ReproSeed does not turn that on for you.

## Privacy

A trace can contain DOM text, input values, screenshots, and network requests and responses, including application data. It is not redacted. If the page displays the reset credential, that value can appear in the zip.

`artifacts/` and `*.zip` are gitignored. Review a trace before you share it. ReproSeed does not upload traces, attach them to GitHub Actions, put them in the npm package, or send them to an external service.
