# ReproSeed

Reproduce difficult bugs, minimize failing scenarios, and generate reliable regression tests.

Phase 0 shortens an ordered scenario while preserving one confirmed failure. It does not launch a browser.

Phase 1 is a loopback duplicate-submit demo.

Phase 2 replays a scenario from a clean authorized state in a fresh browser context. It returns an `ExecutionOutcome` and does not call the minimizer.

Later phases must follow [docs/future-phase-corrections.md](docs/future-phase-corrections.md).

## Requirements

Node.js 22 or newer.

## Commands

```bash
npm install
npx playwright install chromium
npm run typecheck
npm test
npm run test:demo
npm run test:runner
```

## Demo server

The server listens on `127.0.0.1` only. Reset stays disabled until `REPROSEED_APP_ID` and `REPROSEED_RESET_AUTHORIZATION` are both present in the process environment. Do not commit those values.

```bash
REPROSEED_APP_ID=duplicate-submit REPROSEED_RESET_AUTHORIZATION="$(openssl rand -hex 16)" npm run demo
```
