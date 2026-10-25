import { assertCleanStateVerify } from "./clean-state.ts";
import { ScenarioError, type Oracle, type Scenario, type Step } from "./types.ts";

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type MissingDependency = {
  stepId: string;
  dependsOn: string;
};

function assertNonEmpty(label: string, value: string): void {
  if (value.trim() === "") {
    throw new ScenarioError(`${label} is required`);
  }
}

function assertStepShape(step: Step): void {
  if (!STEP_ID.test(step.id)) {
    throw new ScenarioError(`step id must match ${STEP_ID.source}: ${step.id}`);
  }
  if (step.dependsOn.includes(step.id)) {
    throw new ScenarioError(`step ${step.id} depends on itself`);
  }
  const seen = new Set<string>();
  for (const dep of step.dependsOn) {
    if (seen.has(dep)) {
      throw new ScenarioError(`step ${step.id} lists dependency ${dep} more than once`);
    }
    seen.add(dep);
  }
  switch (step.kind) {
    case "goto":
      assertNonEmpty(`${step.id} path`, step.path);
      break;
    case "fill":
      assertNonEmpty(`${step.id} selector`, step.selector);
      break;
    case "click":
      assertNonEmpty(`${step.id} selector`, step.selector);
      break;
    case "wait":
      if (!Number.isFinite(step.ms) || step.ms < 0) {
        throw new ScenarioError(`step ${step.id} wait must be a non-negative number`);
      }
      break;
    case "delay":
      assertNonEmpty(`${step.id} urlIncludes`, step.urlIncludes);
      if (step.method !== "GET" && step.method !== "POST") {
        throw new ScenarioError(`step ${step.id} delay method must be GET or POST`);
      }
      if (!Number.isFinite(step.ms) || step.ms <= 0) {
        throw new ScenarioError(`step ${step.id} delay must be a positive number`);
      }
      break;
    default: {
      const unreachable: never = step;
      throw new ScenarioError(`unknown step kind ${(unreachable as Step).kind}`);
    }
  }
}

function assertNoCycles(steps: readonly Step[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, stack: string[]): void => {
    const mark = state.get(id);
    if (mark === "done") {
      return;
    }
    if (mark === "visiting") {
      throw new ScenarioError(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    }
    const step = byId.get(id);
    if (step === undefined) {
      throw new ScenarioError(`unknown dependency ${id}`);
    }
    state.set(id, "visiting");
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        throw new ScenarioError(`step ${id} depends on unknown step ${dep}`);
      }
      visit(dep, [...stack, id]);
    }
    state.set(id, "done");
  };

  for (const step of steps) {
    visit(step.id, []);
  }
}

function assertOracle(oracle: Oracle): void {
  if (oracle.id === "record-count") {
    if (oracle.request.method !== "GET") {
      throw new ScenarioError("oracle must be a GET record-count check");
    }
    assertNonEmpty("oracle path", oracle.request.path);
    if (oracle.match.field !== "email") {
      throw new ScenarioError("oracle match field must be email");
    }
    assertNonEmpty("oracle email", oracle.match.value);
    if (!Number.isSafeInteger(oracle.expect) || oracle.expect < 0) {
      throw new ScenarioError("oracle.expect must be a non-negative integer");
    }
    return;
  }
  if (oracle.id === "dom-text") {
    assertDomSelector(oracle.selector);
    if (oracle.expect.length > 2_000) {
      throw new ScenarioError("oracle.expect is too long");
    }
    if (oracle.expect.includes("\0")) {
      throw new ScenarioError("oracle.expect must not contain a null character");
    }
    return;
  }
  const unreachable: never = oracle;
  throw new ScenarioError(`unknown oracle ${(unreachable as { id?: string }).id ?? ""}`);
}

function assertDomSelector(selector: string): void {
  if (selector.trim() === "") {
    throw new ScenarioError("oracle selector is required");
  }
  if (selector !== selector.trim()) {
    throw new ScenarioError("oracle selector must not have leading or trailing whitespace");
  }
  if (selector.length > 300) {
    throw new ScenarioError("oracle selector is too long");
  }
  if (/[\u0000-\u001f\u007f]/.test(selector)) {
    throw new ScenarioError("oracle selector must not contain control characters");
  }
  if (/javascript\s*:/i.test(selector)) {
    throw new ScenarioError("oracle selector must not be a javascript URL");
  }
}

/** Validates scenario structure. Budget limits are checked separately. */
export function assertScenario(scenario: Scenario): void {
  assertNonEmpty("scenario id", scenario.id);
  let origin: URL;
  try {
    origin = new URL(scenario.target.origin);
  } catch {
    throw new ScenarioError("target.origin must be an absolute URL");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new ScenarioError("target.origin must use http or https");
  }
  assertNonEmpty("target.appId", scenario.target.appId);
  assertNonEmpty("target.resetAuthorization", scenario.target.resetAuthorization);
  if (scenario.reset.method !== "POST" || scenario.reset.path !== "/__reproseed/reset") {
    throw new ScenarioError("reset must be POST /__reproseed/reset");
  }
  assertCleanStateVerify(scenario.reset);
  assertOracle(scenario.oracle);
  if (scenario.steps.length === 0) {
    throw new ScenarioError("scenario has no steps");
  }
  const seen = new Set<string>();
  for (const step of scenario.steps) {
    assertStepShape(step);
    if (seen.has(step.id)) {
      throw new ScenarioError(`duplicate step id ${step.id}`);
    }
    seen.add(step.id);
  }
  assertNoCycles(scenario.steps);
}

/** Returns subset ids in scenario order. Rejects unknown and duplicate ids. */
export function orderIds(steps: readonly Step[], ids: readonly string[]): string[] {
  const wanted = new Set<string>();
  for (const id of ids) {
    if (wanted.has(id)) {
      throw new ScenarioError(`duplicate step in subset: ${id}`);
    }
    wanted.add(id);
  }
  const ordered: string[] = [];
  for (const step of steps) {
    if (wanted.has(step.id)) {
      ordered.push(step.id);
      wanted.delete(step.id);
    }
  }
  if (wanted.size > 0) {
    throw new ScenarioError(`unknown step in subset: ${[...wanted].join(", ")}`);
  }
  return ordered;
}

export function findMissingDependencies(steps: readonly Step[], orderedIds: readonly string[]): MissingDependency[] {
  const present = new Set(orderedIds);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const missing: MissingDependency[] = [];
  for (const id of orderedIds) {
    const step = byId.get(id);
    if (step === undefined) {
      continue;
    }
    for (const dep of step.dependsOn) {
      if (!present.has(dep)) {
        missing.push({ stepId: id, dependsOn: dep });
      }
    }
  }
  return missing;
}
