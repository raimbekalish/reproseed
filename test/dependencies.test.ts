import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScenario, findMissingDependencies, orderIds } from "../src/core/dependencies.ts";
import { ScenarioError, type Scenario, type Step } from "../src/core/types.ts";
import { duplicateSubmitScenario, duplicateSubmitSteps } from "./fixture.ts";

describe("dependencies", () => {
  it("preserves scenario order and reports a missing structural dependency", () => {
    const steps = duplicateSubmitSteps();
    assert.deepEqual(orderIds(steps, ["submit-2", "open", "email"]), ["open", "email", "submit-2"]);
    assert.deepEqual(findMissingDependencies(steps, ["email", "submit-1"]), [
      { stepId: "email", dependsOn: "open" },
      { stepId: "submit-1", dependsOn: "open" },
    ]);
  });

  it("does not make submit depend on the optional Note field", () => {
    const steps = duplicateSubmitSteps();
    for (const id of ["submit-1", "submit-2"]) {
      const step = steps.find((candidate) => candidate.id === id);
      assert.ok(step);
      assert.deepEqual(step.dependsOn, ["open", "email"]);
      assert.equal(step.dependsOn.includes("note"), false);
    }
    assert.equal(steps.find((step) => step.id === "note")?.kind, "fill");
  });

  it("rejects cyclic, duplicate, and unknown dependencies", () => {
    const scenario = duplicateSubmitScenario();
    const cyclic: Step[] = [
      { id: "a", kind: "click", selector: "#a", dependsOn: ["b"] },
      { id: "b", kind: "click", selector: "#b", dependsOn: ["a"] },
    ];
    assert.throws(() => assertScenario({ ...scenario, steps: cyclic }), ScenarioError);

    const duplicated = duplicateSubmitSteps();
    duplicated.push({ id: "open", kind: "wait", ms: 1, dependsOn: [] });
    assert.throws(() => assertScenario({ ...scenario, steps: duplicated }), /duplicate step id open/);

    const unknown: Step[] = [{ id: "a", kind: "click", selector: "#a", dependsOn: ["missing"] }];
    assert.throws(() => assertScenario({ ...scenario, steps: unknown }), /unknown step missing/);

    const self: Step[] = [{ id: "a", kind: "click", selector: "#a", dependsOn: ["a"] }];
    assert.throws(() => assertScenario({ ...scenario, steps: self }), /depends on itself/);
  });

  it("accepts a DOM-text oracle and a GET response delay", () => {
    const scenario = duplicateSubmitScenario();
    const dom: Scenario = {
      ...scenario,
      steps: [
        { id: "open", kind: "goto", path: "/", dependsOn: [] },
        {
          id: "slow-alpha",
          kind: "delay",
          urlIncludes: "/api/search?q=alpha",
          method: "GET",
          ms: 800,
          dependsOn: [],
        },
      ],
      oracle: { id: "dom-text", selector: "#results", expect: "Results for beta" },
    };
    assert.doesNotThrow(() => assertScenario(dom));
    assert.throws(() => assertScenario({ ...dom, oracle: { id: "dom-text", selector: "javascript:alert(1)", expect: "x" } }), /javascript/);
    assert.throws(
      () =>
        assertScenario({
          ...dom,
          steps: [{ id: "slow", kind: "delay", urlIncludes: "/api/search", method: "PUT" as "GET", ms: 10, dependsOn: [] }],
        }),
      /GET or POST/,
    );
  });

  it("accepts an omitted clean-state rule and rejects one that leaves the origin", () => {
    const scenario = duplicateSubmitScenario();
    assert.equal(scenario.reset.verify, undefined);
    assert.doesNotThrow(() => assertScenario(scenario));
    const withHistory: Scenario = {
      ...scenario,
      reset: {
        method: "POST",
        path: "/__reproseed/reset",
        verify: { kind: "json-array-empty", method: "GET", path: "/api/search-history" },
      },
    };
    assert.doesNotThrow(() => assertScenario(withHistory));
    for (const path of ["//evil.example/state", "https://evil.example/state", "/javascript:alert(1)", "/\\evil"]) {
      assert.throws(
        () =>
          assertScenario({
            ...scenario,
            reset: {
              method: "POST",
              path: "/__reproseed/reset",
              verify: { kind: "json-array-empty", method: "GET", path },
            },
          }),
        /authorized origin/,
        path,
      );
    }
    assert.throws(
      () =>
        assertScenario({
          ...scenario,
          reset: {
            method: "POST",
            path: "/__reproseed/reset",
            verify: { kind: "shell" as "json-array-empty", method: "GET", path: "/api/records" },
          },
        }),
      /json-array-empty/,
    );
  });
});
