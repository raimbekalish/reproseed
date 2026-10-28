import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadScenarioFile } from "../src/cli/scenario-file.ts";
import { STARTER_APP_ID, STARTER_ORIGIN, STARTER_SCENARIO_ID, starterNotes, starterScenario } from "../src/cli/starter.ts";
import { cleanStateVerify } from "../src/core/clean-state.ts";

describe("starter scenarios", () => {
  for (const oracle of ["record-count", "dom-text"] as const) {
    it(`matches the schema for ${oracle} and stays on loopback`, async () => {
      const body = starterScenario(oracle);
      const text = JSON.stringify(body);
      assert.equal(text.includes("resetAuthorization"), false);
      assert.equal(text.includes("REPROSEED_RESET_AUTHORIZATION"), false);
      const urls = text.match(/https?:\/\/[^"\\\s]+/g) ?? [];
      assert.ok(urls.length > 0);
      for (const url of urls) {
        const parsed = new URL(url);
        assert.equal(parsed.protocol, "http:");
        assert.equal(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]", true, url);
      }
      const directory = await mkdtemp(join(tmpdir(), "reproseed-starter-"));
      try {
        const path = join(directory, "scenario.json");
        await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
        const scenario = await loadScenarioFile(path, directory, {
          REPROSEED_ORIGIN: STARTER_ORIGIN,
          REPROSEED_APP_ID: STARTER_APP_ID,
          REPROSEED_RESET_AUTHORIZATION: "starter-test-token-value",
        });
        assert.equal(scenario.id, STARTER_SCENARIO_ID);
        assert.equal(scenario.target.origin, STARTER_ORIGIN);
        assert.equal(scenario.oracle.id, oracle);
        assert.equal(scenario.budget.verifyRuns, 5);
        assert.equal(cleanStateVerify(scenario.reset).method, "GET");
        assert.equal(scenario.steps.some((step) => step.id === "decoy-note"), true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      const notes = starterNotes(oracle, "scenario.json");
      assert.match(notes, /replace-with-your-app-id/);
      assert.match(notes, /does not contain a reset credential/);
      assert.match(notes, /opt in/);
      assert.match(notes, /reproseed doctor scenario.json/);
    });
  }
});
