# Security policy

ReproSeed resets and drives a local test application. The rules below are the product's safety boundary. Version 0.1.0, released October 25, 2026, is the supported registry release until `npm view reproseed version` reports a later version. Version 0.2.0 is dated October 31, 2026. It is the supported registry release when `npm view reproseed@0.2.0 version` reports `0.2.0`.

## Authorized targets

A reset is allowed only when every check below succeeds. Loopback by itself is not authorization.

- The origin is `http` on `127.0.0.1`, `localhost`, or `::1`. Userinfo, a path, a query, and a fragment are refused.
- `REPROSEED_APP_ID` matches the value returned by `GET /__reproseed/identity` on that origin.
- `REPROSEED_RESET_AUTHORIZATION` is sent to `POST /__reproseed/reset`, and the application accepts it.

The demos bind to `127.0.0.1` and leave reset disabled until both environment variables are present. Scenario paths have to stay on that origin. A path that is protocol-relative, contains a scheme, or uses a backslash is refused.

## Credentials

The reset credential is read from `REPROSEED_RESET_AUTHORIZATION` only. It is not accepted as a command-line flag. A scenario file must not contain `resetAuthorization`. `${...}` and `$(...)` text in scenario JSON is not expanded or executed.

`reproseed doctor` does not send `POST /__reproseed/reset` and does not launch a browser. It sends GET requests only after the origin is authorized loopback HTTP, and it does not follow redirects. It does not print the credential. For a record-count scenario, a non-empty oracle list is checked for the same record fields the minimizer reads. The reset verification list is only required to be a JSON array. Doctor names the item and the field that failed and does not print the field values. Exit 0 does not mean the application accepted the credential or that the clean-state list is empty after a reset. `reproseed init` writes a scenario file and does not embed the credential.

Reports and command output replace a copy of that credential, when it is at least 8 characters, with `[redacted]`. The sanitized report omits the credential field. Treat a report as sensitive anyway: it can still contain scenario data such as form values. `artifacts/` is gitignored. Do not commit a report, a generated spec, or an environment file. Before you share a report, read it and remove anything you would not post publicly.

## Traces

`reproseed minimize --trace` is off unless you pass a `.zip` path. The reset request is made with Node before the browser context starts, and the trace title is the fixed text `ReproSeed evidence`. ReproSeed does not put the reset credential in that title or in the trace command's log lines.

A Playwright trace can still contain DOM text, typed input, screenshots, and network requests and responses from the page. If the application shows or echoes the credential, that value can appear in the zip. Traces are not redacted. `*.zip` and `artifacts/` are gitignored. Do not commit a trace, upload it, attach it to GitHub Actions, or send it to an external service until you have reviewed it. The package does not include trace files.

A failed capture does not replace an existing zip. The command says that older file may be stale and does not treat it as evidence for the current run. A trace save that misses the cleanup budget is still waited on, and the temporary zip is deleted after that Playwright call settles. Killing the process during the save can leave Playwright's own temporary trace files outside `artifacts/`.

## Redirects

Identity, reset, and clean-state requests are made with redirect following disabled. A redirect response fails the check. Browser navigation that would leave the authorized origin is refused, including a redirect during the initial page load. The generated Playwright spec uses the same restrictions and refuses a non-loopback origin before it sends the credential.

## Untrusted applications and production

Run ReproSeed only against a loopback application you started and are willing to wipe. Reset is a state-changing request. An untrusted program listening on loopback can still behave maliciously. The loopback and redirect checks are not a sandbox for that program.

Production targets are unsupported. The tool has no model for production accounts, TLS origins, or hosts outside loopback. Those targets are refused before a reset request. Do not point `REPROSEED_ORIGIN` at a real service.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.0, released October 25, 2026 | Yes, while `npm view reproseed version` reports `0.1.0`. |
| 0.2.0, dated October 31, 2026 | Yes, when `npm view reproseed@0.2.0 version` reports `0.2.0`. Before that, it is the source version and not the registry release. |
| Older commits | No |

0.1.0 is the first published release. There is no earlier supported version. Security fixes for a registry install apply to the version `npm view reproseed version` reports. The `0.1.0` procedure is [docs/release-checklist.md](docs/release-checklist.md) and [docs/publish-runbook.md](docs/publish-runbook.md). That runbook's tag-then-publish order is historical. The `0.2.0` order, which publishes before tagging, is [docs/v0.2.0-release-checklist.md](docs/v0.2.0-release-checklist.md).

## Reporting a vulnerability

Private vulnerability reporting is enabled. Report a vulnerability through GitHub, not in a public issue:

1. Open [Security → Advisories](https://github.com/raimbekalish/reproseed/security/advisories).
2. Choose **Report a vulnerability**. The form is [this repository's private advisory form](https://github.com/raimbekalish/reproseed/security/advisories/new).

GitHub keeps that report visible to the repository maintainers. It is not a public issue.

Do not open a public issue, pull request, or discussion that includes an exploitable vulnerability, a proof of concept, or step-by-step exploit details. A public bug report is only for defects that are safe to describe in the open, with credentials removed. Use the bug-report template for those.

There is no security email address. This policy does not promise a response time.
