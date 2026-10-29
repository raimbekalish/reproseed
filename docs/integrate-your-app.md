# Integrate your application

This is the path to a minimized scenario on an application you run locally. ReproSeed does not install reset hooks into an existing app. The application has to opt in.

Requirements: Node.js 22 or newer, and npm. Tested on macOS and on GitHub-hosted Ubuntu with Node.js 22. Windows is not tested.

Example servers, including `examples/opt-in-ticket`, are in this git repository. They are not in the npm package. Commands for an installed package use `npx reproseed`. `node dist/cli.js` appears only in the source-checkout section and in the checkout worked example.

`--no-shell` skips `chrome-headless-shell`. The browser ReproSeed launches is Playwright `1.64.1`'s downloaded Chromium, `channel: "chromium"`, not system Chrome.

```bash
npx playwright install --with-deps --no-shell chromium
```

None of the installs below add `@playwright/test`. A generated spec imports it. Install that package yourself when you want to run the spec:

```bash
npm install --save-dev @playwright/test@1.64.1
```

## Published 0.1.0

```bash
npm install reproseed@0.1.0
npx reproseed --help
npx reproseed --version
npx reproseed minimize --help
```

`0.1.0` can `minimize` a scenario and write a regression test. `doctor`, `init`, and `--trace` are not in that package. `npx reproseed doctor --help` fails on `0.1.0` because there is no `doctor` command. This guide and [trace-evidence.md](trace-evidence.md) are not files in that package.

`npm install reproseed` with no version installs the latest published release. Until `0.2.0` is published, that is `0.1.0`.

## Unpublished 0.2.0 candidate

Pack this repository. Install that tarball in a different directory. `npm install reproseed` does not install this candidate. While `package.json` is `0.2.0`, `npm pack` names the file `reproseed-0.2.0.tgz`.

```bash
npm pack
mkdir ../reproseed-consumer
cd ../reproseed-consumer
npm init -y
npm install /absolute/path/reproseed-0.2.0.tgz
npx reproseed --version
npx reproseed --help
npx reproseed init --help
npx reproseed doctor --help
npx reproseed minimize --help
```

`--version` prints `0.2.0`. `init`, `doctor`, and `--trace` are present. This guide is `node_modules/reproseed/docs/integrate-your-app.md`. [trace-evidence.md](trace-evidence.md) is beside it. The example servers are not in the tarball. Printing `0.2.0` here does not mean the registry serves `0.2.0`.

## Published 0.2.0, after release

`0.2.0` is not on npm yet. After the owner publishes it:

```bash
npm install reproseed@0.2.0
npx reproseed --version
npx reproseed init --help
npx reproseed doctor --help
npx reproseed minimize --help
```

`--version` prints `0.2.0`. The commands and the two guides match the candidate. Example servers are still not in the package. From then on, `npm install reproseed` with no version installs `0.2.0`.

The rest of this guide uses `npx reproseed` for those two packages. Skip `init`, `doctor`, and `--trace` when the installed package is `0.1.0`.

## Install from a checkout

Use this when you are changing ReproSeed, or when you want the example servers. `node dist/cli.js` is the CLI built in this checkout.

```bash
git clone https://github.com/raimbekalish/reproseed.git
cd reproseed
npm ci
npx playwright install --with-deps --no-shell chromium
npm run build
node dist/cli.js --help
```

A checkout already has `@playwright/test` as a dev dependency at `1.64.1`. The built CLI includes `init`, `doctor`, and `--trace`. On this candidate, `--version` prints `0.2.0`. The registry's unversioned install is still published `0.1.0`.

## Create a scenario

`init` writes one JSON file. It does not start your application and it does not put a reset credential in the file.

```bash
npx reproseed init scenario.json --oracle record-count
```

Published `0.1.0` does not provide `init`. The command above is the candidate tarball and, after publication, `reproseed@0.2.0`. In a source checkout the same command is `node dist/cli.js init scenario.json --oracle record-count`.

`--oracle dom-text` writes the other supported failure type. The default path is `scenario.json`. An existing file is left unchanged unless you pass `--force`. The path has to stay inside the current directory, end in `.json`, and must not be a symlink.

The command prints the placeholders you have to replace:

- `id`
- `target.appId`
- `target.origin` (the sample is `http://127.0.0.1:3000`; change the port, not the host)
- selectors, typed values, the delay needle, and `reset.verify.path`
- `oracle.expect`, which is the intended result, not the buggy result

`record-count` compares a same-origin JSON list. The match field is `email`. Each object in that list needs string `id`, `email`, and `note`, and a numeric `createdAt`, because that is the list the runner reads. `dom-text` compares one element's normalized `textContent` with `oracle.expect`.

Both templates include a `decoy-note` step. Minimization can remove a step the failure does not need. Delete it if you do not want that sample.

The sample origin is loopback HTTP. `init` does not write a production URL.

## Opt the application in

Reset is a state-changing request. ReproSeed will not add it for you. On the loopback process you are willing to wipe, serve all of the following.

`GET /__reproseed/identity` returns JSON `{"appId":"<your app id>"}`. Use 404 when you have not opted in.

`POST /__reproseed/reset` accepts the reset only when both headers match the values you chose:

- `x-reproseed-app-id`
- `x-reproseed-reset-authorization`

Return 204 and clear the state you want the next replay to start from. Return 403 when the headers do not match. Return 404 when reset is disabled. Compare the credential with a constant-time check. Do not log it.

After reset, one same-origin `GET` must return a JSON array of length 0. Put that path in `reset.verify`:

```json
"verify": { "kind": "json-array-empty", "method": "GET", "path": "/api/tickets" }
```

If you omit `verify`, the check is `GET /api/records`. The path cannot leave the loopback origin. The scenario cannot supply a script or a shell command.

Set the same values in the environment of the ReproSeed process. They are not flags.

```bash
export REPROSEED_APP_ID="your-app-id"
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
export REPROSEED_ORIGIN="http://127.0.0.1:3000"
```

Generate a new credential for each local session. Do not commit it, do not reuse one from another project, and do not paste it into the scenario file.

Start the application with the same app id and credential. Loopback by itself is not authorization. If either value is unset, leave identity and reset disabled.

## Worked example

This example runs from a source checkout. `examples/opt-in-ticket` is a small Node server with no extra dependencies. It does not import the duplicate-submit or stale-search demos. It is in this git repository. It is not in the npm package. The checked-in demo servers are also not in the npm package.

The page files a ticket on `#file`. A second click while the first `POST /api/tickets` is still in flight files another ticket. A 400ms guard ignores only an immediate double-click. The scenario waits 800ms and delays that POST by 2000ms, so both clicks are accepted. The intended count is 1. The note field is a decoy.

Reset stays off until both environment variables are set. The server does not print the credential.

```bash
export REPROSEED_APP_ID=opt-in-ticket
export REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)"
printf '%s\n' "$REPROSEED_RESET_AUTHORIZATION"
npm run demo:ticket
```

The default port is 4030. In another terminal, paste the credential that command printed:

```bash
export REPROSEED_APP_ID=opt-in-ticket
export REPROSEED_RESET_AUTHORIZATION="<paste the value printed by the application terminal>"
export REPROSEED_ORIGIN=http://127.0.0.1:4030
```

## Check without resetting

`doctor` is in the candidate tarball and in published `0.2.0`. It is not in published `0.1.0`.

For your own scenario file, from the directory where you installed the package:

```bash
npx reproseed doctor scenario.json
```

The next command is a source checkout. `examples/opt-in-ticket` is in the repository and is not in the npm package.

`doctor` reads the scenario and, when the origin is authorized loopback, sends GET requests only. It does not send `POST /__reproseed/reset`. It does not launch a browser. It does not follow redirects. It does not print the credential or record values.

```bash
node dist/cli.js doctor examples/opt-in-ticket/scenario.json
```

A line starts with `pass`, `fail`, `skipped`, or `not-verified`. These two are not failures, and they are not proof:

- `reset-accepted` — the credential is set, and the application has not been asked to accept it
- `clean-state-after-reset` — the current JSON array was not produced by a reset

`target-available` requests each distinct `goto` path. A response from 200 through 299 passes. A connection failure, a redirect, a missing route, and a server error are separate failures. A 500 is a reachable server, not a ready page. Doctor does not require `GET /` when the scenario navigates somewhere else. When the scenario has no `goto` step, the request is `GET /`.

`clean-state-endpoint` reads `reset.verify.path`. It passes when that GET returns a JSON array. The items can be audit events or any other JSON values. An empty array passes. A non-empty array can still pass. `minimize` resets first and then requires that array to be empty. Doctor does not check item shape here.

`oracle-endpoint` is a separate check. For `record-count`, it reads `oracle.request.path`. A non-empty array must contain records with string `id`, `email`, and `note`, and numeric `createdAt`, which is the shape `minimize` counts. An empty array passes. A missing field and a wrong type are reported by item index and field name. The values are not printed. The two paths can differ. When they are the same path, doctor sends that GET once. A `dom-text` scenario does not have a record-list oracle, so that check does not request one.

Exit 0 means every required check passed. Exit 1 means usage was invalid or a required check failed or was skipped. Exit 4 is an unexpected failure. `doctor` does not use the minimize exit codes 2 and 3.

A passing doctor run can still be followed by a failed minimize when the application rejects the credential.

## Minimize

`minimize` does reset the application. Run one minimization at a time. This command exists in published `0.1.0`, in the candidate tarball, and in published `0.2.0`. `--trace` exists only in the candidate and in `0.2.0`.

From the directory where you installed the package:

```bash
npx reproseed minimize scenario.json \
  --report artifacts/report.json \
  --spec artifacts/ticket.spec.ts
```

This checkout command uses the example server, which is not in the npm package:

```bash
node dist/cli.js minimize examples/opt-in-ticket/scenario.json \
  --report artifacts/report.json \
  --spec artifacts/ticket.spec.ts
```

Exit 0 prints `Status: verified-one-minimal` and writes both files. Any other result writes the report only. The spec asserts the intended count of 1. It does not assert the buggy count, and it does not call `minimize()`.

`artifacts/` is gitignored. Do not commit the report or the spec. They can contain scenario data such as the sample email. The credential is omitted, and a copy of it at least 8 characters long is replaced with `[redacted]`.

## What verified-one-minimal means

The minimizer drops one remaining step at a time. It keeps a step when dropping it stops the same failure from coming back. Five fresh replays then have to reproduce that failure. Those five do not use the candidate cache.

`verified-one-minimal` means the kept steps are 1-minimal under that single-deletion check. It is not a proof that some untested subset would be shorter. The summary says so.

On the opt-in ticket scenario, a verified run keeps `open`, `email`, `slow-file`, `file-1`, `gap`, and `file-2`. It removes `decoy-note`. The failure code is `DUPLICATE`: two tickets for `person@example.com` against an intended count of 1. Removing the delay, the gap, or either click no longer produces that same failure.

## Run the exported test

`minimize` does not run the spec. While the application is still buggy, the spec should fail. That failure means the regression caught the bug. It does not mean minimization failed.

`test/export/playwright.config.ts` runs `artifacts/minimized.spec.ts` for the duplicate-submit demo. For the ticket spec, use a Playwright config whose `testMatch` is `ticket.spec.ts`, with retries off, one worker, and `use.channel` set to `"chromium"`. With the opt-in server still running:

```bash
REPROSEED_ORIGIN=http://127.0.0.1:4030 \
REPROSEED_APP_ID=opt-in-ticket \
REPROSEED_RESET_AUTHORIZATION="<paste the value printed by the application terminal>" \
npx playwright test --config playwright.ticket.config.ts
```

Expect Playwright exit 1, `Expected: 1`, and `Received: 2` while the default page is running. That page keeps the bug: a second click during the delayed save files another ticket.

`test/cli/opt-in-minimize.test.ts` then starts a second server on another ephemeral port and serves `examples/opt-in-ticket/public/fixed.html`. That page ignores a click while a save is already in flight. The test runs the same generated spec against it, without editing the spec, and expects Playwright exit 0 and one ticket. `npm run demo:ticket` does not serve the fixed page. The page is not in the npm package. The default application remains the buggy one.

## Credentials

- Read the credential from `REPROSEED_RESET_AUTHORIZATION` only.
- Do not pass it as an argument. `doctor` and `init` do not have a flag for it.
- Do not write `resetAuthorization` into scenario JSON. `${...}` and `$(...)` in the file are not expanded or executed.
- Do not commit `.env` files, reports, or generated specs.
- Prefer `openssl rand -hex 16` for a session value, and do not reuse it.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `doctor` says the Chromium executable is missing, or the spec says the executable does not exist | Run `npx playwright install --with-deps --no-shell chromium`. If `PLAYWRIGHT_BROWSERS_PATH` points at a directory that does not contain that revision, unset it. Doctor does not launch the browser; `minimize` and the spec do. |
| `GET /__reproseed/identity returned 404` | The application has not opted in. Start it with both `REPROSEED_APP_ID` and `REPROSEED_RESET_AUTHORIZATION`. |
| Identity returned a different app id | Set `REPROSEED_APP_ID` to the value the application returns, and put that same value in `target.appId` when the file has one. |
| `REPROSEED_ORIGIN does not match target.origin` | The file and the environment disagree. Doctor does not contact either host until they match, and the origin still has to be loopback. |
| `non-loopback` | Use `http://127.0.0.1`, `http://localhost`, or `http://[::1]`. HTTPS and other hosts are refused before any request. |
| Could not connect | Start the application and set `REPROSEED_ORIGIN` to the URL it printed, including the port. This is a network failure. A 404 or a 500 means the server did respond. |
| `navigation path is missing` or `server failure` | The scenario `goto` path did not return a successful status. Doctor does not call that page ready. Fix the route the scenario opens. A server error is not proof that the process is up and healthy. |
| `record-count oracle cannot read` | `oracle.request.path` needs string `id`, `email`, and `note`, and numeric `createdAt` on each item. The message names the item index and the field. It does not print the values. This is not the reset verification list. A `dom-text` scenario does not use this shape. |
| Clean-state GET is not a JSON array | `reset.verify.path` has to be a same-origin GET that returns an array. The items do not have to be records. |
| `reset-accepted` is `not-verified` | That is expected. Only `minimize` sends the reset. If minimize then says reset failed, the header or the credential does not match. |
| `refusing to overwrite` | Pass `--force` to replace a report, spec, or `init` file. `--force` still does not replace a spec when minimization did not verify. |
| `no-reproducible-failure` | The full scenario did not reproduce one target failure. For this example, the second click has to land during the delayed response: keep the 2000ms delay and the 800ms gap, and do not raise the page's 400ms guard above that gap. |
| Playwright spec fails with expected 1 and received 2 | The bug is still present. That is the regression test working. |
| Overlapping browser errors | Run one minimization at a time. A second Chromium session can close a browser the first one still needs. |
