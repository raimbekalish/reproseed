# Publish runbook for v0.1.0

This runbook prepares the first npm publication of ReproSeed. It does not authorize that publication, and following the preparation section does not publish the package.

Two kinds of steps are separated below. Preparation is safe to repeat. Publication changes the public registry or creates a permanent git tag. Do those only after the owner explicitly approves the release commit.

The publishable candidate removes `private` and keeps version `0.1.0`. That candidate is not a publication. CI must not publish. Do not add a publish workflow.

## Preparation record

These facts were checked while writing this runbook. Recheck them on the day of publication. They are not a release date.

- `main` was `152c934a3b2bc5e0e9f7c42300660196f75d2d57`, with a green push CI run: https://github.com/raimbekalish/reproseed/actions/runs/40242922534
- `LICENSE` is MIT, copyright (c) 2026 Raimbek Alish. `package.json` `license` is `MIT`.
- GitHub private vulnerability reporting returned `{"enabled": true}`.
- npm CLI on the preparation machine was 11.6.1. The registry was `https://registry.npmjs.org/`.
- An npm account was already authenticated. `npm profile get` reported `tfa.mode` of `auth-and-writes`, which requires two-factor authentication for login and for writes such as publish. This document does not record the account name.
- `npm view reproseed` returned `E404`. That means the registry had no visible package by that name. It does not reserve `reproseed`, and it does not prove the signed-in account may create it.
- No `NPM_TOKEN` or `NODE_AUTH_TOKEN` was set. Do not create a token for this release.

If `npm whoami` later fails, the owner logs in manually with `npm login` on the account that should own the package, completes that account's two-factor prompt, and confirms `tfa.mode` is still `auth-and-writes`. Do not register the package, create a token, or change two-factor settings as part of preparation.

## npm requirements that apply

Sources, as of 25 October 2026:

- [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [Requiring 2FA for package publishing and settings modification](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)
- [package.json name rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [Staged publishing](https://docs.npmjs.com/staged-publishing/)
- [Dual-Use Content Policy](https://docs.npmjs.com/policies/dual-use/), last updated by npm on 28 July 2026

Unscoped packages are always public. The name must be at most 214 characters, URL-safe, and free of uppercase letters. `reproseed` matches that shape. It is not a Node.js core module name. The name and version are required to publish.

Direct `npm publish` requires account two-factor authentication, or a granular access token with bypass 2FA. The signed-in account already uses `auth-and-writes`, so an interactive `npm publish` will prompt for a second factor. That is the method this runbook uses. Do not create a bypass token.

Staged publishing (`npm stage publish`, then `npm stage approve` with 2FA) needs npm CLI 11.15.0 or later and Node.js 22.14.0 or later. The preparation machine's npm 11.6.1 cannot stage. Staging a package name that does not exist also publishes a public placeholder version `0.0.0-stage`. That placeholder is a publication. Do not stage this package unless the owner chooses that method on a new CLI and accepts the placeholder.

New publishes can be scanned before they are installable. npm describes a delay of about five minutes, sometimes 15 or longer. That delay is not a service guarantee. After `npm publish`, wait until `npm view reproseed version` shows `0.1.0` before declaring the registry install verified.

## Dual-use assessment

npm's Dual-Use Content Policy covers security-relevant packages whose capabilities can resemble malicious software to automated scanning. The policy's examples are penetration-testing tools, security research utilities, code-obfuscation tools, and similar software. The examples are illustrative, not exhaustive. Declaration is required for packages in that category. It is done with this metadata:

```json
"contentPolicy": {
  "class": "dual-use"
}
```

and a text-only `DISCLOSURE` file at the root of the published tarball. Once published, that declaration cannot be removed without npm Trust & Safety review. A declared package may be published directly only from an interactive two-factor session. Other methods, including trusted publishing and bypass-2FA tokens, must stage first and enforce 2FA when the stage is promoted.

This repository's assessment is that the current package does not fall under that category. That is a reasoned reading of the policy against ReproSeed's behavior. It is not a binding decision by npm Trust & Safety.

The basis for that reading: ReproSeed minimizes a failing UI scenario and writes a regression test. The fault it injects is a network delay inside an authorized loopback test, plus a reset that is refused unless the origin is loopback, the app id matches, and the reset credential is accepted. It does not scan hosts, exploit vulnerabilities, obfuscate code, collect credentials, or ship an attack payload. Driving Chromium through Playwright is ordinary test automation.

This preparation therefore does not add `contentPolicy` or `DISCLOSURE`. Adding them would misstate the package and would permanently restrict later publishes.

If npm Trust & Safety classifies the package differently, stop and reassess before another publish attempt. Do not retry with a bypass token. The owner would then add the metadata and `DISCLOSURE` above, document the legitimate loopback-only use, and publish only through an interactive 2FA session or through staged publishing with 2FA at promotion.

## Preparation, safe to repeat

1. Confirm `npm whoami` succeeds and `tfa.mode` is `auth-and-writes`. If it does not, complete the manual `npm login` step above.
2. Run `npm view reproseed` again. A 404 means the name is not currently visible. It still does not reserve the name. If the name belongs to someone else, stop and choose another name before any publish.
3. On the commit you intend to release, confirm version `0.1.0`, MIT, the copyright line, green CI for all three jobs, and a packed tarball that contains `LICENSE`, `dist/cli.js`, the three exporter assets, `README.md`, and the two scenario files, and contains no `.env`, credentials, reports, or `src/`.
4. The publication-day notes use the heading `0.1.0` dated October 25, 2026. Do not tag or publish until the push-triggered CI run on that merged commit is green and the owner approves those two steps.

The drafted notes are [v0.1.0-release-notes.md](v0.1.0-release-notes.md). The checks to tick are [release-checklist.md](release-checklist.md).

## Publication, only with explicit owner approval

Do not perform this list as part of documentation or CI.

1. The publishable candidate removes `"private": true`, updates `test/package/smoke.test.ts` so the packed manifest has no `private` property, and checks `package-lock.json`. It keeps version `0.1.0`, the MIT license, and the changelog heading `Unreleased`. Merging that candidate still does not publish.
2. The publication-day commit, dated October 25, 2026, moves the changelog heading to `0.1.0` and documents `npm install reproseed`. It does not change the version. It does not tag or publish.
3. Run `npm pack --dry-run` on that commit. Confirm `private` is absent, `license` is `MIT`, and the file list is still the intended one.
4. After that commit is merged, run the whole CI workflow from the push to `main`. Quality and build, Chromium integration, and Package smoke verification must be green on that exact SHA. The pull-request run is not a substitute. Do not tag or run `npm publish` until the owner approves those steps.
5. Create the annotated tag only after those checks pass:

   ```bash
   git tag -a v0.1.0 <release-sha> -m "ReproSeed 0.1.0"
   git push origin v0.1.0
   ```

   Do not move the tag and do not force-push it.
6. From a checkout of that SHA, with the authenticated account, run `npm publish`. Complete the two-factor prompt. Do not run it from GitHub Actions. Do not use `npm stage publish` unless the owner has switched to npm CLI 11.15.0 or later and has accepted the public `0.0.0-stage` placeholder.
7. Wait for the registry scan, then run `npm view reproseed version` and confirm `0.1.0`. In a clean directory, `npm install reproseed` and run `reproseed --help` and `reproseed --version`.
8. Optionally create a GitHub Release from the tag `v0.1.0`. Use the drafted notes. Do not attach secrets or `artifacts/`.

## Commands that stay unauthorized

The candidate may remove `private`. Until the owner explicitly approves publication:

- `npm publish`
- `npm stage publish`, `npm stage approve`, or any other command that creates a registry package or a `0.0.0-stage` placeholder
- Changing `0.1.0`
- `git tag`, including `v0.1.0`
- Creating a GitHub Release
- Adding a publish workflow, a token, or a dual-use declaration
