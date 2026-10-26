# Release checklist

Use this list for the 0.1.0 release dated October 25, 2026. The publication-day documentation uses that date. The annotated tag and `npm publish` stay separate owner steps in [publish-runbook.md](publish-runbook.md). The notes are [v0.1.0-release-notes.md](v0.1.0-release-notes.md).

Complete every item on the commit you intend to release. Record the commit SHA next to the checks you ran.

## CI

- [ ] The release commit is on `main`.
- [ ] The push to `main` for that commit has a green GitHub Actions run.
- [ ] Quality and build, Chromium integration, and Package smoke verification all succeeded on that SHA.
- [ ] No required check is failing or skipped.

## Build and tests

- [ ] `npm ci` used `package-lock.json`.
- [ ] `npm run typecheck` passed.
- [ ] `npm run build` passed.
- [ ] `npm test` and `npm run test:cli` passed.
- [ ] `npm run test:browsers` passed on the platform you claim, or you documented that only the Ubuntu CI run was executed.
- [ ] `npm run test:package` passed. `reproseed --version` from the installed tarball printed the release version.

## Package contents

- [ ] `npm pack --dry-run` lists only the intended files: `package.json`, `LICENSE`, `README.md`, `dist/`, and the two example scenario files, plus the compiled JavaScript under `dist/`.
- [ ] The tarball contains `LICENSE` with `Copyright (c) 2026 Raimbek Alish`, and `dist/export/runtime-config.ts`, `delay-match.ts`, and `dom-text.ts`.
- [ ] The tarball does not contain `src/`, `artifacts/`, test results, `.env`, credentials, or a reset token.
- [ ] The packed manifest has no `private` property. The package smoke test checks that, and it still checks `LICENSE`, the executable, credential exclusion, and a clean install. `package-lock.json` matches `package.json`. The changelog heading is `0.1.0` dated 2026-10-25. The push-triggered CI run on that commit must be green before a tag or publish.

## Platforms

- [ ] The release notes name only platforms that were actually tested.
- [ ] Today that evidence is macOS for development and GitHub-hosted Ubuntu with Node.js 22 for CI. Do not claim Windows or another Node version without a run on that target.
- [ ] The notes name the Playwright version from `package-lock.json` and say the browser is Playwright's downloaded Chromium (`channel: "chromium"`), not system Chrome and not `chrome-headless-shell`.

## Documentation

- [ ] README quick start, both examples, step minimization, `--tune-delays`, report inspection, and the exported-test command match the release.
- [ ] Supported oracles and the loopback restrictions match the code.
- [ ] README does not claim production websites, AI, a hosted service, or a license that has not been committed.
- [ ] [CHANGELOG.md](../CHANGELOG.md) has a `0.1.0` entry dated 2026-10-25 and does not invent earlier releases.

## License

MIT is already the license for ReproSeed source. [../LICENSE](../LICENSE) contains `Copyright (c) 2026 Raimbek Alish`. `package.json` sets `"license": "MIT"`. Dependencies keep their own licenses. On the release commit, confirm:

- [ ] `LICENSE` is still the MIT text and the copyright line is unchanged, or an intentional change is explained.
- [ ] `package.json` `license` is still `MIT` and matches `LICENSE`.
- [ ] README says MIT covers this source tree and that third-party packages keep their own licenses.
- [ ] `npm pack` includes `LICENSE`.

## Security reporting

- [ ] [SECURITY.md](../SECURITY.md) still tells people to use GitHub private vulnerability reporting (Security → Advisories) and does not ask them to post exploits in public issues.
- [ ] A GET of `repos/raimbekalish/reproseed/private-vulnerability-reporting` still returns `"enabled": true`, or SECURITY.md has been updated to match the real setting.
- [ ] Supported versions in SECURITY.md match versions that were actually published. None have been published yet.

## Version and tag

- [ ] `package.json` `version` is the version you are releasing. Do not reuse `0.1.0` for a published release unless that is an intentional first publication of this tree.
- [ ] The changelog heading matches that version.
- [ ] The annotated tag will be `v` plus that version, pointing at the release commit. Create the tag only after the checks above pass. This checklist does not create it.
- [ ] The tag is not moved and is not force-pushed.

## npm

- [ ] `npm view reproseed` was run again on the publication day. A 404 means the name is not currently visible. It does not reserve `reproseed` and it does not prove the signed-in account may create it. If the name is taken, choose another name before publishing.
- [ ] `npm publish` is a separate, explicit step. CI must not publish. `npm stage publish` is also a publication for a new name, because it creates a public `0.0.0-stage` placeholder. Do not stage unless [publish-runbook.md](publish-runbook.md) is followed on npm CLI 11.15.0 or later.
- [ ] The published tarball was inspected with `npm pack` first.
- [ ] The publishing account has two-factor authentication for writes (`tfa.mode` `auth-and-writes`), and the publish is an interactive `npm publish` that prompts for the second factor. Reconfirm this on the publication day. Do not print the account name into the checklist.

## After publication

- [ ] `npm view reproseed version` shows the version you published.
- [ ] A clean install from the registry runs `reproseed --help` and `reproseed --version`.
- [ ] The GitHub Release, if the owner creates one, points at the same tag and does not include secrets or `artifacts/`.
- [ ] README installation instructions match how people actually install the published package.
