import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { startDemoServer } from "../examples/duplicate-submit/server.ts";
import type { MinimizeReport, Scenario } from "../src/core/types.ts";
import { ExportError, exportPlaywrightTest, writePlaywrightTest } from "../src/export/playwright.ts";
import { authorizedUrl, assertLoopbackHttpOrigin, readRuntimeConfig } from "../src/export/runtime-config.ts";
import { sanitizeArtifact } from "../src/runner/report.ts";
import { CORE_IDS, duplicateSubmitScenario } from "./fixture.ts";
import { verifiedMinimizeReport } from "./export/verified-report.ts";

const SECRET = "reset-secret-do-not-embed-9f3a";
const PRIVATE_PATH = "/Users/raimbekalish/private/reset-token";
const ORIGIN = "http://127.0.0.1:4010";

describe("playwright regression export", () => {
  it("emits the kept steps in scenario order and asserts the intended count", () => {
    const scenario = secretScenario();
    const report = verifiedMinimizeReport(scenario, CORE_IDS);
    report.claim = `${SECRET} leaked via ${PRIVATE_PATH}`;
    const source = exportPlaywrightTest(scenario, report);
    const again = exportPlaywrightTest(scenario, report);
    assert.equal(source, again);

    const embedded = readEmbedded(source);
    assert.deepEqual(
      embedded.steps.map((step) => step.id),
      [...CORE_IDS],
    );
    assert.deepEqual(embedded.oracle, { path: "/api/records", email: "a@example.com", expect: 1 });
    const delay = embedded.steps.find((step) => step.id === "slow");
    assert.equal(delay?.kind, "delay");
    assert.equal(delay?.ms, 2000);
    assert.equal(delay?.method, "POST");
    assert.equal(delay?.urlIncludes, "/api/records");
    const gap = embedded.steps.find((step) => step.id === "gap");
    assert.equal(gap?.kind, "wait");
    assert.equal(gap?.ms, 800);
    const email = embedded.steps.find((step) => step.id === "email");
    assert.equal(email?.kind, "fill");
    assert.equal(email?.selector, "#email");
    assert.equal(email?.value, "a@example.com");

    const ids = new Set(embedded.steps.map((step) => step.id));
    for (const removed of ["note", "preview", "decoy-wait"]) {
      assert.equal(ids.has(removed), false, removed);
    }
    assert.equal(source.includes("#note"), false);
    assert.equal(source.includes("#preview"), false);
    assert.equal(source.includes("hello"), false);
    assert.equal(source.match(/expect\(actual\)\.toBe\(1\)/g)?.length, 1);
    assert.equal(source.includes("expect(actual).toBe(2)"), false);
    assert.equal(source.includes("expect(actual).toBe(0)"), false);
    assert.match(source, /from "@playwright\/test"/);
    assert.equal(source.includes("minimize("), false);
    assert.equal(source.includes('from "../src'), false);
    assert.equal(source.includes(SECRET), false);
    assert.equal(source.includes(PRIVATE_PATH), false);
    assert.equal(source.includes(ORIGIN), false);
    assert.match(source, /retries:\s*0/);
    assert.equal(source.includes("retries: 1"), false);
    assert.equal(source.includes("retries: 2"), false);
    assert.match(source, /noWaitAfter:\s*true/);
    assert.match(source, /REPROSEED_ORIGIN/);
    assert.match(source, /REPROSEED_APP_ID/);
    assert.match(source, /REPROSEED_RESET_AUTHORIZATION/);
    assert.match(source, /x-reproseed-reset-authorization/);
    assert.match(source, /x-reproseed-app-id/);

    const delayStart = source.indexOf("async function installResponseDelay");
    const fetchAt = source.indexOf("await route.fetch(", delayStart);
    const pauseAt = source.indexOf("await pause(step.ms)", delayStart);
    const fulfillAt = source.indexOf("await fulfillFetched(route, response)", delayStart);
    assert.ok(delayStart !== -1 && fetchAt !== -1 && pauseAt !== -1 && fulfillAt !== -1);
    assert.ok(fetchAt < pauseAt && pauseAt < fulfillAt);
    const configured = source.indexOf("readRuntimeConfig(process.env)");
    const firstFetch = source.indexOf("await fetch(");
    const identity = source.indexOf('"/__reproseed/identity"');
    const resetHeader = source.indexOf('"x-reproseed-reset-authorization"');
    assert.ok(configured !== -1 && firstFetch !== -1 && configured < firstFetch);
    assert.ok(identity !== -1 && resetHeader !== -1 && identity < resetHeader);

    const artifact = sanitizeArtifact(scenario, report);
    assert.deepEqual(
      artifact.scenario.steps.find((step) => step.id === "slow"),
      { id: "slow", kind: "delay" },
    );
    assert.equal("ms" in (artifact.scenario.steps.find((step) => step.id === "slow") ?? {}), false);
  });

  it("keeps every selected step when the verified report did not delete any", () => {
    const scenario = secretScenario();
    const ids = scenario.steps.map((step) => step.id);
    const embedded = readEmbedded(exportPlaywrightTest(scenario, verifiedMinimizeReport(scenario, ids)));
    assert.deepEqual(
      embedded.steps.map((step) => step.id),
      ids,
    );
    assert.equal(embedded.steps.some((step) => step.id === "note" && step.value === "hello"), true);
  });

  it("asserts the intended count when verification observed fewer records than expected", () => {
    const scenario = secretScenario();
    const source = exportPlaywrightTest(scenario, verifiedMinimizeReport(scenario, CORE_IDS, 0));
    assert.match(source, /expect\(actual\)\.toBe\(1\)/);
    assert.equal(source.includes("expect(actual).toBe(0)"), false);
    assert.equal(readEmbedded(source).oracle.expect, 1);
  });

  it("serializes hostile scenario strings as data", () => {
    const scenario = secretScenario();
    const nasty = '");\nthrow new Error("pwnd");// </script> `${process.env.REPROSEED_RESET_AUTHORIZATION}` \u2028';
    const email = scenario.steps.find((step) => step.id === "email");
    assert.ok(email && email.kind === "fill");
    email.value = nasty;
    const source = exportPlaywrightTest(scenario, verifiedMinimizeReport(scenario, CORE_IDS));
    assert.equal(source.includes('throw new Error("pwnd")'), false);
    assert.equal(source.includes(SECRET), false);
    const embedded = readEmbedded(source);
    assert.equal(embedded.steps.find((step) => step.id === "email")?.value, nasty);
    assertGeneratedSpecTypechecks(source);
  });

  it("typechecks the duplicate-submit spec", () => {
    const source = exportPlaywrightTest(secretScenario(), verifiedMinimizeReport(secretScenario(), CORE_IDS));
    assertGeneratedSpecTypechecks(source);
  });

  it("writes the same spec the exporter returned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-export-"));
    try {
      const scenario = secretScenario();
      const report = verifiedMinimizeReport(scenario, CORE_IDS);
      const path = join(directory, "nested", "minimized.spec.ts");
      await writePlaywrightTest(path, scenario, report);
      assert.equal(await readFile(path, "utf8"), exportPlaywrightTest(scenario, report));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unverified, incomplete, and unsupported reports", () => {
    const cases: Array<{ name: string; pattern: RegExp; mutate: (input: Fixture) => void }> = [
      { name: "unstable", pattern: /unstable/, mutate: ({ report }) => void (report.status = "unstable") },
      { name: "budget", pattern: /budget-exhausted/, mutate: ({ report }) => void (report.status = "budget-exhausted") },
      { name: "flaky", pattern: /flaky-baseline/, mutate: ({ report }) => void (report.status = "flaky-baseline") },
      {
        name: "no failure",
        pattern: /no-reproducible-failure/,
        mutate: ({ report }) => void (report.status = "no-reproducible-failure"),
      },
      {
        name: "exhausted flag",
        pattern: /exhausted budget/,
        mutate: ({ report }) => {
          report.budget.exhausted = true;
          report.budget.exhaustedReason = "wall-clock";
        },
      },
      {
        name: "missing baseline",
        pattern: /baseline failure is not known/,
        mutate: ({ report }) => void delete report.baselineSignature,
      },
      {
        name: "baseline agrees with the bug",
        pattern: /does not differ/,
        mutate: ({ report }) => {
          report.baselineSignature = {
            oracleId: "record-count",
            code: "DUPLICATE",
            facts: { email: "a@example.com", actual: 1, expect: 1 },
          };
        },
      },
      {
        name: "wrong failure code",
        pattern: /code does not match/,
        mutate: ({ report }) => {
          const signature = report.baselineSignature;
          assert.ok(signature);
          signature.code = "COUNT_MISMATCH";
          signature.facts.actual = 3;
          for (const replay of report.replays) {
            if (replay.outcome.status === "fail") {
              replay.outcome = { status: "fail", durationMs: 5, signature };
            }
          }
        },
      },
      {
        name: "four verifications",
        pattern: /five independent/,
        mutate: ({ report }) => {
          const index = report.replays.findIndex((replay) => replay.phase === "verify");
          report.replays.splice(index, 1);
          report.counts.verifyReplays = 4;
        },
      },
      {
        name: "verification passed",
        pattern: /did not reproduce/,
        mutate: ({ report }) => {
          const replay = report.replays.find((candidate) => candidate.phase === "verify");
          assert.ok(replay);
          replay.outcome = { status: "pass", durationMs: 1 };
        },
      },
      {
        name: "verification count changed",
        pattern: /did not reproduce/,
        mutate: ({ report }) => {
          const replay = report.replays.find((candidate) => candidate.phase === "verify");
          assert.ok(replay);
          replay.outcome = {
            status: "fail",
            durationMs: 5,
            signature: {
              oracleId: "record-count",
              code: "DUPLICATE",
              facts: { email: "a@example.com", actual: 3, expect: 1 },
            },
          };
        },
      },
      {
        name: "verification steps differ",
        pattern: /did not execute the kept steps/,
        mutate: ({ report }) => {
          const replay = report.replays.find((candidate) => candidate.phase === "verify");
          assert.ok(replay);
          replay.stepIds = replay.stepIds.filter((id) => id !== "gap");
        },
      },
      {
        name: "kept order",
        pattern: /not in scenario order/,
        mutate: ({ report }) => {
          const swapped = [...CORE_IDS];
          const open = swapped.indexOf("open");
          const email = swapped.indexOf("email");
          const first = swapped[open];
          const second = swapped[email];
          assert.ok(first && second);
          swapped[open] = second;
          swapped[email] = first;
          report.keptStepIds = swapped;
          for (const replay of report.replays) {
            if (replay.phase === "verify") {
              replay.stepIds = [...swapped];
            }
          }
        },
      },
      {
        name: "missing dependency",
        pattern: /missing dependencies/,
        mutate: ({ report }) => {
          const kept = CORE_IDS.filter((id) => id !== "open");
          report.keptStepIds = [...kept];
          for (const replay of report.replays) {
            if (replay.phase === "verify") {
              replay.stepIds = [...kept];
            }
          }
        },
      },
      {
        name: "unknown step",
        pattern: /unknown step/,
        mutate: ({ report }) => {
          report.keptStepIds = [...CORE_IDS, "nope"];
        },
      },
      {
        name: "duplicate step",
        pattern: /duplicate step/,
        mutate: ({ report }) => {
          report.keptStepIds = ["open", "open"];
        },
      },
      {
        name: "shared replay id",
        pattern: /not independent/,
        mutate: ({ report }) => {
          const verify = report.replays.filter((replay) => replay.phase === "verify");
          const first = verify[0];
          const second = verify[1];
          assert.ok(first && second);
          second.id = first.id;
        },
      },
      {
        name: "input steps",
        pattern: /do not match the scenario/,
        mutate: ({ report }) => {
          report.inputStepIds = ["open"];
        },
      },
      {
        name: "off-origin path",
        pattern: /authorized origin/,
        mutate: ({ scenario }) => {
          const open = scenario.steps.find((step) => step.id === "open");
          assert.ok(open && open.kind === "goto");
          open.path = "https://evil.example/phish";
        },
      },
      {
        name: "protocol-relative path",
        pattern: /authorized origin/,
        mutate: ({ scenario }) => {
          const open = scenario.steps.find((step) => step.id === "open");
          assert.ok(open && open.kind === "goto");
          open.path = "//evil.example/phish";
        },
      },
      {
        name: "non-loopback origin",
        pattern: /loopback/,
        mutate: ({ scenario }) => {
          scenario.target = { ...scenario.target, origin: "http://example.com" };
        },
      },
      {
        name: "https origin",
        pattern: /http URL/,
        mutate: ({ scenario }) => {
          scenario.target = { ...scenario.target, origin: "https://127.0.0.1:4010" };
        },
      },
      {
        name: "unsupported kind",
        pattern: /unknown step kind|unsupported step/,
        mutate: ({ scenario }) => {
          scenario.steps = scenario.steps.map((step) =>
            step.id === "preview" ? ({ ...step, kind: "drag" } as unknown as Scenario["steps"][number]) : step,
          );
        },
      },
    ];

    for (const testCase of cases) {
      const input = freshFixture();
      testCase.mutate(input);
      assert.throws(
        () => exportPlaywrightTest(input.scenario, input.report),
        (error: unknown) => {
          assert.ok(error instanceof ExportError, testCase.name);
          assert.match(error.message, testCase.pattern, `${testCase.name}: ${error.message}`);
          return true;
        },
      );
    }
  });

  it("reads runtime configuration only from the environment and only for loopback http", () => {
    assert.throws(() => readRuntimeConfig({}), /REPROSEED_ORIGIN is required/);
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: "http://example.com",
          REPROSEED_APP_ID: "duplicate-submit",
          REPROSEED_RESET_AUTHORIZATION: SECRET,
        }),
      /loopback/,
    );
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: "https://127.0.0.1:4010",
          REPROSEED_APP_ID: "duplicate-submit",
          REPROSEED_RESET_AUTHORIZATION: SECRET,
        }),
      /http URL/,
    );
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: "http://user:pass@127.0.0.1:4010",
          REPROSEED_APP_ID: "duplicate-submit",
          REPROSEED_RESET_AUTHORIZATION: SECRET,
        }),
      /credentials/,
    );
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: "http://127.0.0.1:4010/app",
          REPROSEED_APP_ID: "duplicate-submit",
          REPROSEED_RESET_AUTHORIZATION: SECRET,
        }),
      /path/,
    );
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: ORIGIN,
          REPROSEED_APP_ID: " ",
          REPROSEED_RESET_AUTHORIZATION: SECRET,
        }),
      /REPROSEED_APP_ID is required/,
    );
    assert.throws(
      () =>
        readRuntimeConfig({
          REPROSEED_ORIGIN: ORIGIN,
          REPROSEED_APP_ID: "duplicate-submit",
          REPROSEED_RESET_AUTHORIZATION: " ",
        }),
      /REPROSEED_RESET_AUTHORIZATION is required/,
    );
    const config = readRuntimeConfig({
      REPROSEED_ORIGIN: "http://localhost:4010",
      REPROSEED_APP_ID: "duplicate-submit",
      REPROSEED_RESET_AUTHORIZATION: SECRET,
    });
    assert.equal(config.origin, "http://localhost:4010");
    assert.equal(config.appId, "duplicate-submit");
    assert.equal(config.resetAuthorization, SECRET);
    assert.equal(assertLoopbackHttpOrigin("http://127.0.0.1:4010"), ORIGIN);
    assert.equal(assertLoopbackHttpOrigin("http://[::1]:4010"), "http://[::1]:4010");
    assert.equal(authorizedUrl(ORIGIN, "/api/records"), `${ORIGIN}/api/records`);
    assert.throws(() => authorizedUrl(ORIGIN, "//evil"), /authorized origin/);
    assert.throws(() => authorizedUrl("http://example.com", "/api/records"), /loopback/);
  });

  it("serves the in-flight submit guard only for the fixed-pending page", async () => {
    const buggy = await startDemoServer({ port: 0, appId: "duplicate-submit", resetAuthorization: SECRET });
    const fixed = await startDemoServer({
      port: 0,
      appId: "duplicate-submit",
      resetAuthorization: SECRET,
      page: "fixed-pending",
    });
    try {
      const buggyHtml = await (await fetch(buggy.origin)).text();
      const fixedHtml = await (await fetch(fixed.origin)).text();
      assert.equal(buggyHtml.includes("let pending"), false);
      assert.match(fixedHtml, /if \(locked \|\| pending\)/);
      assert.match(fixedHtml, /pending = true/);
      assert.match(fixedHtml, /submitButton\.disabled = false/);
      assert.equal(fixedHtml.includes("submitButton.disabled = true"), false);
      assert.equal(buggy.postCount(), 0);
      assert.equal(fixed.postCount(), 0);
    } finally {
      await buggy.close();
      await fixed.close();
    }
  });

  it("matches the installed Playwright runtime", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const playwright = JSON.parse(readFileSync(join(root, "node_modules/playwright/package.json"), "utf8")) as {
      version: string;
    };
    const runner = JSON.parse(readFileSync(join(root, "node_modules/@playwright/test/package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(runner.version, playwright.version);
  });
});

type Fixture = { scenario: Scenario; report: MinimizeReport };
type EmbeddedStep = {
  id: string;
  kind: string;
  path?: string;
  selector?: string;
  value?: string;
  ms?: number;
  method?: string;
  urlIncludes?: string;
};

function freshFixture(): Fixture {
  const scenario = secretScenario();
  return { scenario, report: verifiedMinimizeReport(scenario, CORE_IDS) };
}

function secretScenario(): Scenario {
  const scenario = duplicateSubmitScenario();
  scenario.target = { ...scenario.target, origin: ORIGIN, resetAuthorization: SECRET };
  return scenario;
}

function readEmbedded(source: string): { oracle: { path: string; email: string; expect: number }; steps: EmbeddedStep[] } {
  const marker = "const scenario = ";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const expressionStart = start + marker.length;
  const suffix = " as ExportedScenario;";
  const end = source.indexOf(suffix, expressionStart);
  assert.notEqual(end, -1);
  const expression = source.slice(expressionStart, end);
  return vm.runInNewContext(expression, { JSON }) as {
    oracle: { path: string; email: string; expect: number };
    steps: EmbeddedStep[];
  };
}

function assertGeneratedSpecTypechecks(source: string): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const directory = join(root, "artifacts");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `typecheck-${randomBytes(4).toString("hex")}.spec.ts`);
  writeFileSync(file, source);
  try {
    const tsc = fileURLToPath(new URL("../node_modules/typescript/lib/tsc.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--noUncheckedIndexedAccess",
        "--noUnusedLocals",
        "--noUnusedParameters",
        "--noImplicitOverride",
        "--noFallthroughCasesInSwitch",
        "--forceConsistentCasingInFileNames",
        "--verbatimModuleSyntax",
        "--erasableSyntaxOnly",
        "--isolatedModules",
        "--target",
        "ES2023",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--lib",
        "ES2023",
        "--types",
        "node",
        "--skipLibCheck",
        "--pretty",
        "false",
        file,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(file, { force: true });
  }
}
