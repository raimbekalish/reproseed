import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScenario, findMissingDependencies, orderIds } from "../src/core/dependencies.ts";
import { ScenarioError, type Step } from "../src/core/types.ts";
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
});
