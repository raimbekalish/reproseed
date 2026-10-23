import { assertBudget } from "../core/budget.ts";
import { cleanStateVerify } from "../core/clean-state.ts";
import { assertScenario, findMissingDependencies, orderIds } from "../core/dependencies.ts";
import { ScenarioError, type Scenario, type Step } from "../core/types.ts";
import { assertLocalAuthorizedTarget, canonicalOrigin, resolveAuthorizedUrl } from "./safety.ts";

export type PreparedReplay = {
  scenario: Scenario;
  origin: string;
  steps: Step[];
};

/**
 * Validates a scenario and a step subset.
 * Throws before any reset or browser work when the subset or the target is unsafe.
 */
export function prepareReplay(scenario: Scenario, stepIds: readonly string[]): PreparedReplay {
  assertScenario(scenario);
  assertBudget(scenario.budget);
  assertLocalAuthorizedTarget(scenario.target.origin, scenario.target.appId, scenario.target.resetAuthorization);
  const origin = canonicalOrigin(scenario.target.origin);
  if (scenario.oracle.id === "record-count") {
    resolveAuthorizedUrl(origin, scenario.oracle.request.path);
  }
  resolveAuthorizedUrl(origin, scenario.reset.path);
  resolveAuthorizedUrl(origin, cleanStateVerify(scenario.reset).path);
  const ordered = orderIds(scenario.steps, stepIds);
  const missing = findMissingDependencies(scenario.steps, ordered);
  if (missing.length > 0) {
    const detail = missing.map((item) => `${item.stepId} needs ${item.dependsOn}`).join(", ");
    throw new Error(`missing dependencies: ${detail}`);
  }
  const steps = ordered.map((id) => {
    const step = scenario.steps.find((candidate) => candidate.id === id);
    if (step === undefined) {
      throw new ScenarioError(`unknown step in subset: ${id}`);
    }
    if (step.kind === "goto") {
      resolveAuthorizedUrl(origin, step.path);
    }
    return step;
  });
  return { scenario, origin, steps };
}
