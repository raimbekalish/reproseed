# Release checklist

Use this list before the first real release. Nothing here has been done as a release. Version `0.1.0` stays unpublished, `private: true` stays set, and this checklist does not create a tag, a GitHub Release, or an npm publication.

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

- [ ] `npm pack --dry-run` lists only the intended files: `package.json`, `README.md`, `dist/`, and the two example scenario files, plus the compiled JavaScript under `dist/`.
- [ ] The tarball contains `dist/export/runtime-config.ts`, `delay-match.ts`, and `dom-text.ts`.
- [ ] The tarball does not contain `src/`, `artifacts/`, test results, `.env`, credentials, or a reset token.
- [ ] `private` is still `true` until the owner deliberately publishes. Publishing requires removing `private` or using a one-off publish path the owner has written down. Do not publish as part of a documentation change.

## Platforms

- [ ] The release notes name only platforms that were actually tested.
- [ ] Today that evidence is macOS for development and GitHub-hosted Ubuntu with Node.js 22 for CI. Do not claim Windows or another Node version without a run on that target.
- [ ] The notes name the Playwright version from `package-lock.json` and say the browser is Playwright's downloaded Chromium (`channel: "chromium"`), not system Chrome and not `chrome-headless-shell`.

## Documentation

- [ ] README quick start, both examples, step minimization, `--tune-delays`, report inspection, and the exported-test command match the release.
- [ ] Supported oracles and the loopback restrictions match the code.
- [ ] README does not claim production websites, AI, a hosted service, or a license that has not been committed.
- [ ] [CHANGELOG.md](../CHANGELOG.md) has an entry for this version and no invented dates for versions that were never released.

## License

- [ ] The owner has chosen MIT or Apache-2.0. See [licensing-proposal.md](licensing-proposal.md).
- [ ] A `LICENSE` file is committed with the owner's copyright line.
- [ ] README describes that license and no longer says a license is pending.
- [ ] `package.json` `license` matches the chosen file. Set that field only when the license file lands.

## Security reporting

- [ ] [SECURITY.md](../SECURITY.md) names a real private channel, or states that private reporting is still not configured.
- [ ] If GitHub private vulnerability reporting is turned on, SECURITY.md tells people to use the Security tab and does not ask them to paste exploits into public issues.
- [ ] Supported versions in SECURITY.md match versions that were actually published.

## Version and tag

- [ ] `package.json` `version` is the version you are releasing. Do not reuse `0.1.0` for a published release unless that is an intentional first publication of this tree.
- [ ] The changelog heading matches that version.
- [ ] The annotated tag will be `v` plus that version, pointing at the release commit. Create the tag only after the checks above pass. This checklist does not create it.
- [ ] The tag is not moved and is not force-pushed.

## npm

- [ ] The package name `reproseed` is available, or the owner has chosen another name.
- [ ] `npm publish` is a separate, explicit step. CI must not publish.
- [ ] The published tarball was inspected with `npm pack` first.
- [ ] Two-factor authentication for publish is required on the npm account the owner uses.

## After publication

- [ ] `npm view reproseed version` shows the version you published.
- [ ] A clean install from the registry runs `reproseed --help` and `reproseed --version`.
- [ ] The GitHub Release, if the owner creates one, points at the same tag and does not include secrets or `artifacts/`.
- [ ] README installation instructions match how people actually install the published package.
