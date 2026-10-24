import { EXIT } from "./errors.ts";
import {
  DEFAULT_TIMING_MAX_COARSE,
  DEFAULT_TIMING_MAX_FINE,
  DEFAULT_TIMING_MAX_REPLAYS,
  DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
  DEFAULT_TIMING_RESOLUTION_MS,
} from "../core/duration.ts";

export const ROOT_HELP = `ReproSeed minimizes a failing scenario and writes a Playwright regression test.

It resets only an explicitly authorized loopback test application.
It does not target production websites.

Usage:
  reproseed --help
  reproseed --version
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--force] [--tune-delays]

Commands:
  minimize    Run Chromium minimization against a local scenario file

Run \`reproseed minimize --help\` for environment variables, outputs, and exit codes.
`;

export const MINIMIZE_HELP = `Usage:
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--force] [--tune-delays]

Arguments:
  scenario.json       Scenario file. It must not contain resetAuthorization.

Options:
  --report <file>     Sanitized JSON report (default: artifacts/report.json)
  --spec <file>       Playwright test written only after verification
                      (default: artifacts/minimized.spec.ts)
  --force             Replace an existing report or spec file
  --tune-delays       After a verified step minimization, search for a shorter
                      network response delay. Off by default.
  --timing-resolution <ms>
                      Positive millisecond grid for that search (default: ${DEFAULT_TIMING_RESOLUTION_MS}).
                      Requires --tune-delays.
  --timing-max-replays <n>
                      Maximum timing-stage browser replays (default: ${DEFAULT_TIMING_MAX_REPLAYS}).
                      Requires --tune-delays. This budget is separate from the
                      scenario's maxReplayExecutions.
  --timing-max-ms <ms>
                      Timing-stage wall-clock budget in milliseconds
                      (default: ${DEFAULT_TIMING_MAX_WALL_CLOCK_MS}). Requires --tune-delays.
                      This budget is separate from the scenario's maxWallClockMs.
  --help              Show this help

--tune-delays measures at most ${DEFAULT_TIMING_MAX_COARSE} coarse durations and ${DEFAULT_TIMING_MAX_FINE} finer durations below the original delay. It never raises a delay. Races are not treated as monotonic. The reported duration is the smallest confirmed candidate among the durations actually replayed, not a proof about untested values. Each candidate is confirmed with the scenario's reductionConfirmRuns, and those runs are fresh replays. One kept delay step can be tuned. Several kept delay steps are skipped. A shorter delay is kept only after a new minimization and five fresh verification replays reproduce the original failure. Otherwise the verified step minimization is exported unchanged.

Environment (not read from the scenario file, and not passed as arguments):
  REPROSEED_ORIGIN                  Loopback http origin, such as http://127.0.0.1:4010
  REPROSEED_APP_ID                  Value returned by GET /__reproseed/identity
  REPROSEED_RESET_AUTHORIZATION     Credential for POST /__reproseed/reset

Scenario JSON is parsed as data. \${VAR} and $(command) text is not expanded or executed.
When the file sets target.origin or target.appId, it must match the environment.
The reset credential is read only from REPROSEED_RESET_AUTHORIZATION.

Optional reset.verify selects the clean-state check. The supported rule is a same-origin
GET whose JSON body is an empty array:
  {"kind":"json-array-empty","method":"GET","path":"/api/search-history"}
When verify is omitted, the check stays GET /api/records. The path cannot leave the
loopback origin, and the file cannot supply a script or a shell command.

Outputs stay inside the current directory. Symlinked output paths are refused.
Existing files are left unchanged unless --force is set.
A run that does not verify writes the report and does not write or replace the spec.
verified-one-minimal is 1-minimal under single deletion. It is not a global proof.

Exit codes:
  ${EXIT.verified}  Verified minimization. The report and regression test were written.
  ${EXIT.usage}  Invalid usage, scenario, environment, target, or output path.
  ${EXIT.unstable}  No reproducible failure, flaky baseline, or unstable result.
  ${EXIT.budget}  The replay or wall-clock budget was exhausted.
  ${EXIT.internal}  The runner or an output write failed.

The regression test asserts the scenario's intended result.
A record-count oracle asserts the intended record count.
A dom-text oracle asserts the intended element text.
This command does not run the test.
A failing test on the still-buggy application is not a minimization failure.
`;
