## Summary

<!-- What changed, and why. -->

## How you tested

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:cli`
- [ ] Browser suites, if replay, export, examples, or Chromium setup changed
- [ ] `npm run test:package`, if packaging or the README install story changed

## Safety

- [ ] No reset credentials, tokens, or unsanitized reports are in the diff.
- [ ] Step minimization, failure signatures, the five final verification replays, and the loopback reset rules are unchanged, or this pull request explains that change.
- [ ] This does not publish to npm or create a release.

## Security-sensitive areas

<!-- Delete the line that does not apply. -->

This change does not touch reset, redirects, credential handling, browser cleanup, CI permissions, or package contents.

This change does touch one of those areas. The review should cover it.
