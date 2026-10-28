# Security policy

ReproSeed resets and drives a local test application. The rules below are the product's safety boundary. Version 0.1.0, released October 25, 2026, is the supported release.

## Authorized targets

A reset is allowed only when every check below succeeds. Loopback by itself is not authorization.

- The origin is `http` on `127.0.0.1`, `localhost`, or `::1`. Userinfo, a path, a query, and a fragment are refused.
- `REPROSEED_APP_ID` matches the value returned by `GET /__reproseed/identity` on that origin.
- `REPROSEED_RESET_AUTHORIZATION` is sent to `POST /__reproseed/reset`, and the application accepts it.

The demos bind to `127.0.0.1` and leave reset disabled until both environment variables are present. Scenario paths have to stay on that origin. A path that is protocol-relative, contains a scheme, or uses a backslash is refused.

## Credentials

The reset credential is read from `REPROSEED_RESET_AUTHORIZATION` only. It is not accepted as a command-line flag. A scenario file must not contain `resetAuthorization`. `${...}` and `$(...)` text in scenario JSON is not expanded or executed.

`reproseed doctor` does not send `POST /__reproseed/reset` and does not launch a browser. It sends GET requests only after the origin is authorized loopback HTTP, and it does not follow redirects. It does not print the credential. Exit 0 does not mean the application accepted the credential or that the clean-state list is empty after a reset. `reproseed init` writes a scenario file and does not embed the credential.

Reports and command output replace a copy of that credential, when it is at least 8 characters, with `[redacted]`. The sanitized report omits the credential field. Treat a report as sensitive anyway: it can still contain scenario data such as form values. `artifacts/` is gitignored. Do not commit a report, a generated spec, or an environment file. Before you share a report, read it and remove anything you would not post publicly.

## Redirects

Identity, reset, and clean-state requests are made with redirect following disabled. A redirect response fails the check. Browser navigation that would leave the authorized origin is refused, including a redirect during the initial page load. The generated Playwright spec uses the same restrictions and refuses a non-loopback origin before it sends the credential.

## Untrusted applications and production

Run ReproSeed only against a loopback application you started and are willing to wipe. Reset is a state-changing request. An untrusted program listening on loopback can still behave maliciously. The loopback and redirect checks are not a sandbox for that program.

Production targets are unsupported. The tool has no model for production accounts, TLS origins, or hosts outside loopback. Those targets are refused before a reset request. Do not point `REPROSEED_ORIGIN` at a real service.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.0, released October 25, 2026 | Yes |
| Older commits | No |

0.1.0 is the first release. There is no earlier supported version. Security fixes apply to that release. The release procedure is [docs/release-checklist.md](docs/release-checklist.md) and [docs/publish-runbook.md](docs/publish-runbook.md).

## Reporting a vulnerability

Private vulnerability reporting is enabled. Report a vulnerability through GitHub, not in a public issue:

1. Open [Security → Advisories](https://github.com/raimbekalish/reproseed/security/advisories).
2. Choose **Report a vulnerability**. The form is [this repository's private advisory form](https://github.com/raimbekalish/reproseed/security/advisories/new).

GitHub keeps that report visible to the repository maintainers. It is not a public issue.

Do not open a public issue, pull request, or discussion that includes an exploitable vulnerability, a proof of concept, or step-by-step exploit details. A public bug report is only for defects that are safe to describe in the open, with credentials removed. Use the bug-report template for those.

There is no security email address. This policy does not promise a response time.
