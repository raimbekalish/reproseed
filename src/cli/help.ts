import { EXIT } from "./errors.ts";

export const ROOT_HELP = `ReproSeed minimizes a failing scenario and writes a Playwright regression test.

It resets only an explicitly authorized loopback test application.
It does not target production websites.

Usage:
  reproseed --help
  reproseed --version
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--force]

Commands:
  minimize    Run Chromium minimization against a local scenario file

Run \`reproseed minimize --help\` for environment variables, outputs, and exit codes.
`;

export const MINIMIZE_HELP = `Usage:
  reproseed minimize <scenario.json> [--report <file>] [--spec <file>] [--force]

Arguments:
  scenario.json       Scenario file. It must not contain resetAuthorization.

Options:
  --report <file>     Sanitized JSON report (default: artifacts/report.json)
  --spec <file>       Playwright test written only after verification
                      (default: artifacts/minimized.spec.ts)
  --force             Replace an existing report or spec file
  --help              Show this help

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
