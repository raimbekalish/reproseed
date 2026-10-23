import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { assertBudget } from "../core/budget.ts";
import { assertScenario } from "../core/dependencies.ts";
import type { Budget, DelayedMethod, Oracle, ResetSpec, Scenario, Step } from "../core/types.ts";
import { assertLocalAuthorizedTarget, canonicalOrigin } from "../runner/safety.ts";
import { CliError, EXIT } from "./errors.ts";

const SCENARIO_BYTES = 1_000_000;
const TOP_LEVEL = ["id", "target", "reset", "steps", "oracle", "budget"] as const;
const TARGET_FIELDS = ["origin", "appId"] as const;
const RESET_FIELDS = ["method", "path"] as const;
const RECORD_ORACLE_FIELDS = ["id", "request", "match", "expect"] as const;
const DOM_ORACLE_FIELDS = ["id", "selector", "expect"] as const;
const BUDGET_FIELDS = [
  "maxReplayExecutions",
  "maxWallClockMs",
  "attemptTimeoutMs",
  "baselineRuns",
  "reductionConfirmRuns",
  "verifyRuns",
] as const;

/**
 * Loads a scenario file and applies the three permitted environment values.
 * JSON text is data. Nothing in the file is interpolated or sent to a shell.
 * `resetAuthorization` is accepted only from `REPROSEED_RESET_AUTHORIZATION`.
 */
export async function loadScenarioFile(path: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Scenario> {
  const absolute = await readableScenario(path, cwd);
  const text = await readFile(absolute, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("scenario file is not valid JSON", EXIT.usage);
  }
  rejectSecretKeys(parsed);
  const record = objectRecord(parsed, "scenario");
  rejectUnknown(record, TOP_LEVEL, "scenario");
  const target = objectRecord(record.target, "target");
  rejectUnknown(target, TARGET_FIELDS, "target");

  const resetAuthorization = requiredEnv(env, "REPROSEED_RESET_AUTHORIZATION");
  const appId = requiredAppId(target, env);
  const origin = requiredOrigin(target, env);
  rejectEmbeddedSecret(parsed, resetAuthorization);

  const scenario: Scenario = {
    id: requiredString(record, "id", "scenario id"),
    target: { origin, appId, resetAuthorization },
    reset: parseReset(record.reset),
    steps: parseSteps(record.steps),
    oracle: parseOracle(record.oracle),
    budget: parseBudget(record.budget),
  };

  try {
    assertScenario(scenario);
    assertBudget(scenario.budget);
    assertLocalAuthorizedTarget(scenario.target.origin, scenario.target.appId, scenario.target.resetAuthorization);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "scenario is invalid", EXIT.usage);
  }
  return scenario;
}

async function readableScenario(path: string, cwd: string): Promise<string> {
  if (path.includes("\0")) {
    throw new CliError("scenario path contains a null byte", EXIT.usage);
  }
  if (path.trim() === "") {
    throw new CliError("scenario file is required", EXIT.usage);
  }
  const absolute = resolve(cwd, path);
  if (!absolute.endsWith(".json")) {
    throw new CliError("scenario file must end in .json", EXIT.usage);
  }
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("scenario file was not found", EXIT.usage);
    }
    throw new CliError("scenario file could not be read", EXIT.usage);
  }
  if (!info.isFile()) {
    throw new CliError("scenario path is not a file", EXIT.usage);
  }
  if (info.size > SCENARIO_BYTES) {
    throw new CliError("scenario file is too large", EXIT.usage);
  }
  return absolute;
}

function requiredOrigin(target: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const configured = requiredEnv(env, "REPROSEED_ORIGIN");
  let origin: string;
  try {
    origin = canonicalOrigin(configured);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "REPROSEED_ORIGIN is invalid", EXIT.usage);
  }
  if (!Object.hasOwn(target, "origin")) {
    return origin;
  }
  const listed = requiredString(target, "origin", "target.origin");
  let listedOrigin: string;
  try {
    listedOrigin = canonicalOrigin(listed);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "target.origin is invalid", EXIT.usage);
  }
  if (listedOrigin !== origin) {
    throw new CliError("REPROSEED_ORIGIN does not match target.origin in the scenario file", EXIT.usage);
  }
  return origin;
}

function requiredAppId(target: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const configured = requiredEnv(env, "REPROSEED_APP_ID");
  if (!Object.hasOwn(target, "appId")) {
    return configured;
  }
  const listed = requiredString(target, "appId", "target.appId");
  if (listed !== configured) {
    throw new CliError("REPROSEED_APP_ID does not match target.appId in the scenario file", EXIT.usage);
  }
  return configured;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`${name} is required`, EXIT.usage);
  }
  return value;
}

function parseReset(value: unknown): ResetSpec {
  const record = objectRecord(value, "reset");
  rejectUnknown(record, RESET_FIELDS, "reset");
  const method = requiredString(record, "method", "reset.method");
  const path = requiredString(record, "path", "reset.path");
  if (method !== "POST" || path !== "/__reproseed/reset") {
    throw new CliError("reset must be POST /__reproseed/reset", EXIT.usage);
  }
  return { method: "POST", path: "/__reproseed/reset" };
}

function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) {
    throw new CliError("steps must be an array", EXIT.usage);
  }
  return value.map((step, index) => parseStep(step, index));
}

function parseStep(value: unknown, index: number): Step {
  const record = objectRecord(value, `steps[${index}]`);
  const kind = requiredString(record, "kind", `steps[${index}].kind`);
  const base = {
    id: requiredString(record, "id", `steps[${index}].id`),
    dependsOn: parseDependsOn(record.dependsOn, index),
  };
  switch (kind) {
    case "goto":
      rejectUnknown(record, ["id", "kind", "dependsOn", "path"], `steps[${index}]`);
      return { ...base, kind, path: requiredString(record, "path", `steps[${index}].path`) };
    case "fill":
      rejectUnknown(record, ["id", "kind", "dependsOn", "selector", "value"], `steps[${index}]`);
      return {
        ...base,
        kind,
        selector: requiredString(record, "selector", `steps[${index}].selector`),
        value: requiredPresentString(record, "value", `steps[${index}].value`),
      };
    case "click":
      rejectUnknown(record, ["id", "kind", "dependsOn", "selector"], `steps[${index}]`);
      return { ...base, kind, selector: requiredString(record, "selector", `steps[${index}].selector`) };
    case "wait":
      rejectUnknown(record, ["id", "kind", "dependsOn", "ms"], `steps[${index}]`);
      return { ...base, kind, ms: requiredNumber(record, "ms", `steps[${index}].ms`) };
    case "delay":
      rejectUnknown(record, ["id", "kind", "dependsOn", "urlIncludes", "method", "ms"], `steps[${index}]`);
      return {
        ...base,
        kind,
        urlIncludes: requiredString(record, "urlIncludes", `steps[${index}].urlIncludes`),
        method: parseDelayMethod(record.method, index),
        ms: requiredNumber(record, "ms", `steps[${index}].ms`),
      };
    default:
      throw new CliError(`unknown step kind ${kind}`, EXIT.usage);
  }
}

function parseDelayMethod(value: unknown, index: number): DelayedMethod {
  if (value !== "GET" && value !== "POST") {
    throw new CliError(`steps[${index}].method must be GET or POST`, EXIT.usage);
  }
  return value;
}

function parseDependsOn(value: unknown, index: number): string[] {
  if (!Array.isArray(value)) {
    throw new CliError(`steps[${index}].dependsOn must be an array`, EXIT.usage);
  }
  return value.map((item, itemIndex) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new CliError(`steps[${index}].dependsOn[${itemIndex}] must be a step id`, EXIT.usage);
    }
    return item;
  });
}

function parseOracle(value: unknown): Oracle {
  const record = objectRecord(value, "oracle");
  const id = requiredString(record, "id", "oracle.id");
  if (id === "dom-text") {
    rejectUnknown(record, DOM_ORACLE_FIELDS, "oracle");
    return {
      id: "dom-text",
      selector: requiredString(record, "selector", "oracle.selector"),
      expect: requiredPresentString(record, "expect", "oracle.expect"),
    };
  }
  if (id !== "record-count") {
    throw new CliError("oracle must be record-count or dom-text", EXIT.usage);
  }
  rejectUnknown(record, RECORD_ORACLE_FIELDS, "oracle");
  const request = objectRecord(record.request, "oracle.request");
  rejectUnknown(request, ["method", "path"], "oracle.request");
  const match = objectRecord(record.match, "oracle.match");
  rejectUnknown(match, ["field", "value"], "oracle.match");
  const method = requiredString(request, "method", "oracle.request.method");
  if (method !== "GET") {
    throw new CliError("oracle must be a GET record-count check", EXIT.usage);
  }
  const field = requiredString(match, "field", "oracle.match.field");
  if (field !== "email") {
    throw new CliError("oracle match field must be email", EXIT.usage);
  }
  const expect = requiredNumber(record, "expect", "oracle.expect");
  return {
    id: "record-count",
    request: { method: "GET", path: requiredString(request, "path", "oracle.request.path") },
    match: { field: "email", value: requiredString(match, "value", "oracle.match.value") },
    expect,
  };
}

function parseBudget(value: unknown): Budget {
  const record = objectRecord(value, "budget");
  rejectUnknown(record, BUDGET_FIELDS, "budget");
  return {
    maxReplayExecutions: requiredInteger(record, "maxReplayExecutions", "budget.maxReplayExecutions"),
    maxWallClockMs: requiredInteger(record, "maxWallClockMs", "budget.maxWallClockMs"),
    attemptTimeoutMs: requiredInteger(record, "attemptTimeoutMs", "budget.attemptTimeoutMs"),
    baselineRuns: requiredInteger(record, "baselineRuns", "budget.baselineRuns"),
    reductionConfirmRuns: requiredInteger(record, "reductionConfirmRuns", "budget.reductionConfirmRuns"),
    verifyRuns: requiredInteger(record, "verifyRuns", "budget.verifyRuns"),
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(`${label} must be a JSON object`, EXIT.usage);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new CliError(`${label} contains an unsupported field`, EXIT.usage);
    }
    if (!allowed.includes(key)) {
      throw new CliError(`${label} contains unsupported field ${key}`, EXIT.usage);
    }
  }
}

function rejectSecretKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectSecretKeys(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "resetauthorization") {
      throw new CliError(
        "scenario file must not contain resetAuthorization; set REPROSEED_RESET_AUTHORIZATION in the environment",
        EXIT.usage,
      );
    }
    rejectSecretKeys(item);
  }
}

function rejectEmbeddedSecret(value: unknown, secret: string): void {
  if (secret.length < 8) {
    return;
  }
  if (containsString(value, secret)) {
    throw new CliError("scenario file contains the reset authorization", EXIT.usage);
  }
}

function containsString(value: unknown, secret: string): boolean {
  if (typeof value === "string") {
    return value.includes(secret);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsString(item, secret));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsString(item, secret));
  }
  return false;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  if (!Object.hasOwn(record, key)) {
    throw new CliError(`${label} is required`, EXIT.usage);
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`${label} must be a non-empty string`, EXIT.usage);
  }
  return value;
}

function requiredPresentString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (!Object.hasOwn(record, key) || typeof value !== "string") {
    throw new CliError(`${label} must be a string`, EXIT.usage);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, label: string): number {
  if (!Object.hasOwn(record, key)) {
    throw new CliError(`${label} is required`, EXIT.usage);
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError(`${label} must be a finite number`, EXIT.usage);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = requiredNumber(record, key, label);
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`${label} must be an integer`, EXIT.usage);
  }
  return value;
}
