import {
  DEFAULT_TIMING_MAX_COARSE,
  DEFAULT_TIMING_MAX_FINE,
  DEFAULT_TIMING_MAX_REPLAYS,
  DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
  DEFAULT_TIMING_RESOLUTION_MS,
} from "../core/duration.ts";
import { EXIT } from "./errors.ts";
import { STARTER_ORIGIN } from "./starter.ts";

export const ROOT_HELP = `ReproSeed checks a local scenario and, when you ask, minimizes a failing one.

It resets only an explicitly authorized loopback test application, and only during minimize.
doctor does not reset. It does not target production websites.

Usage:
  reproseed --help
  reproseed --version
  reproseed init [scenario.json] [--oracle record-count|dom-text] [--force]
  reproseed doctor <scenario.json>
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--trace <file.zip>] [--force] [--tune-delays]

Commands:
  init        Write a starter scenario for a loopback application
  doctor      Check a scenario without resetting the target
  minimize    Run Chromium minimization against a local scenario file

Run \`reproseed <command> --help\` for that command.
`;

export const INIT_HELP = `Usage:
  reproseed init [scenario.json] [--oracle record-count|dom-text] [--force]

Arguments:
  scenario.json       File to create (default: scenario.json)

Options:
  --oracle <kind>     record-count (default) or dom-text
  --force             Replace an existing scenario file
  --help              Show this help

The file matches the scenario schema. It uses ${STARTER_ORIGIN} as a sample origin.
It does not contain a reset credential, and it does not use a production URL.
Replace the printed placeholders, including target.appId, selectors, and reset.verify.path.

The application has to opt in by serving GET /__reproseed/identity and POST /__reproseed/reset.
This command does not start an application and does not add those endpoints.

Output paths stay inside the current directory. Symlinked output paths are refused.
Existing files are left unchanged unless --force is set.

Exit codes:
  ${EXIT.verified}  The starter scenario was written.
  ${EXIT.usage}  Invalid usage or output path, including a refusal to overwrite.
  ${EXIT.internal}  The file could not be written.
`;

export const DOCTOR_HELP = `Usage:
  reproseed doctor <scenario.json>

Arguments:
  scenario.json       Scenario file. It must not contain resetAuthorization.

Doctor does not send POST /__reproseed/reset and does not launch a browser.
It does not follow redirects. It does not contact an origin that is not authorized loopback http.

Checks:
  scenario-file       The file is readable JSON
  scenario-schema     The scenario matches the supported schema
  environment         REPROSEED_ORIGIN, REPROSEED_APP_ID, and REPROSEED_RESET_AUTHORIZATION
  loopback-origin     The origin is http on 127.0.0.1, localhost, or ::1
  target-available    Each scenario goto path returns a successful GET.
                      A connection failure, redirect, missing route, or server
                      error is not success. When the scenario has no goto step,
                      the request is GET /.
  target-identity     GET /__reproseed/identity returns the configured app id
  chromium            Playwright's downloaded Chromium revision is installed
  clean-state-endpoint
                      reset.verify.path returns a JSON array. Item shape is not
                      checked. This is the current response, not proof that reset
                      leaves it empty.
  oracle-endpoint     For record-count, oracle.request.path returns records with
                      string id, email, and note, and numeric createdAt. An empty
                      array passes. Doctor does not print record values. The two
                      paths can differ. A dom-text oracle does not use a record list.
  reset-accepted      Not verified. Doctor does not ask the application to accept the credential.
  clean-state-after-reset
                      Not verified. Emptiness after reset requires a real reset.

The reset credential is not printed. A passing run can still be followed by a failed
minimize when the application rejects the credential or the list is not empty after reset.

Exit codes:
  ${EXIT.verified}  Every required check passed. Reset acceptance was not verified.
  ${EXIT.usage}  Invalid usage, or a required check failed or was skipped.
  ${EXIT.internal}  The diagnostic command failed unexpectedly.

${EXIT.unstable} and ${EXIT.budget} are minimize results. doctor does not use them.
`;

export const MINIMIZE_HELP = `Usage:
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--trace <file.zip>] [--force] [--tune-delays]

Arguments:
  scenario.json       Scenario file. It must not contain resetAuthorization.

Options:
  --report <file>     Sanitized JSON report (default: artifacts/report.json)
  --spec <file>       Playwright test written only after verification
                      (default: artifacts/minimized.spec.ts)
  --trace <file.zip>  After a verified minimization, replay the exported
                      scenario once with Playwright tracing and write that zip.
                      Off by default. This replay is separate from the five
                      verification replays and is omitted from replay counts.
                      Tracing stays off during minimization.
  --force             Replace an existing report, spec, or trace file
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

This command resets the target before minimization. Use \`reproseed doctor\` to inspect a scenario without resetting it.

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
--trace is refused when it collides with the scenario, report, or spec path.
Tracing during minimization is off. The extra replay can miss a race because
tracing changes timing, so a saved zip is verified evidence only when that
replay reproduces the verified failure. The zip can contain page text, input
values, screenshots, and network bodies. It is not redacted.
verified-one-minimal is 1-minimal under single deletion. It is not a global proof.
A trace is not a proof that capture always succeeds.

Exit codes:
  ${EXIT.verified}  Verified minimization. The report and regression test were written.
  ${EXIT.usage}  Invalid usage, scenario, environment, target, or output path.
  ${EXIT.unstable}  No reproducible failure, flaky baseline, or unstable result.
  ${EXIT.budget}  The replay or wall-clock budget was exhausted.
  ${EXIT.internal}  The runner or an output write failed.

A trace request does not change these codes. When the extra replay misses the
failure, or the zip cannot be saved, the command keeps the minimization exit
code and writes a warning. The report and spec from that run stay in place.
If capture fails and a zip is already at the trace path, that file is left
unchanged. The warning says it is from an earlier run and may be stale. It is
not evidence for this run, and the command does not tell you to open it.

The regression test asserts the scenario's intended result.
A record-count oracle asserts the intended record count.
A dom-text oracle asserts the intended element text.
This command does not run the test.
A failing test on the still-buggy application is not a minimization failure.
`;
