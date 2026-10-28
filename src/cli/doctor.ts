import { cleanStateVerify } from "../core/clean-state.ts";
import type { Oracle, Step } from "../core/types.ts";
import type { ScenarioDocument } from "./scenario-file.ts";
import {
  assertNoEmbeddedResetAuthorization,
  parseScenarioDocument,
  readScenarioValue,
} from "./scenario-file.ts";
import { EXIT } from "./errors.ts";
import { describeChromiumInstallation, type ChromiumInstallation } from "../runner/session.ts";
import { formatRecordShapeProblems, recordShapeProblems, type FetchLike } from "../runner/reset.ts";
import { canonicalOrigin, resolveAuthorizedUrl } from "../runner/safety.ts";

const PROBE_TIMEOUT_MS = 10_000;

export const DOCTOR_CHECK_IDS = [
  "scenario-file",
  "scenario-schema",
  "environment",
  "loopback-origin",
  "target-available",
  "target-identity",
  "chromium",
  "clean-state-endpoint",
  "oracle-endpoint",
  "reset-accepted",
  "clean-state-after-reset",
] as const;

export const DOCTOR_PASS_REQUIRED = [
  "scenario-file",
  "scenario-schema",
  "environment",
  "loopback-origin",
  "target-available",
  "target-identity",
  "chromium",
  "clean-state-endpoint",
  "oracle-endpoint",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
export type DoctorCheckStatus = "pass" | "fail" | "skipped" | "not-verified";

export type DoctorCheck = {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  detail: string;
};

export type DoctorCommand = {
  scenarioPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  fetchImpl?: FetchLike;
  inspectChromium?: () => ChromiumInstallation;
};

const ENV_NAMES = ["REPROSEED_ORIGIN", "REPROSEED_APP_ID", "REPROSEED_RESET_AUTHORIZATION"] as const;

/**
 * Reads a scenario and probes an authorized loopback target without resetting it.
 * Every report includes the same check ids. Exit 0 means each required check passed.
 * Reset acceptance and post-reset emptiness stay not-verified.
 */
export async function runDoctorCommand(input: DoctorCommand): Promise<number> {
  const checks = await collectDoctorChecks(input);
  input.stdout(formatDoctorReport(checks));
  return doctorExitCode(checks);
}

export async function collectDoctorChecks(input: DoctorCommand): Promise<DoctorCheck[]> {
  const loaded = await loadDocument(input.scenarioPath, input.cwd);
  const environment = inspectEnvironment(loaded.document, loaded.parsed, input.env);
  const loopback = inspectLoopback(loaded.document, input.env);
  const origin = loopback.origin;
  const appId = environment.appId;
  const document = loaded.document;
  const network =
    document !== undefined && environment.status === "pass" && loopback.status === "pass" && origin !== undefined && appId !== undefined
      ? await probeTarget({
          origin,
          appId,
          steps: document.steps,
          oracle: document.oracle,
          verifyPath: cleanStateVerify(document.reset).path,
          verifyIsDefault: document.reset.verify === undefined,
          fetchImpl: guardedFetch(input.fetchImpl ?? fetch),
        })
      : skippedNetwork(skipReason(loaded.file.status === "fail", document, environment, loopback));
  const chromium = inspectChromium(input.inspectChromium);
  const credential = environment.credential;
  return [
    loaded.file,
    loaded.schema,
    environment.check,
    loopback.check,
    network.available,
    network.identity,
    chromium,
    network.cleanState,
    network.oracle,
    credential
      ? check(
          "reset-accepted",
          "not-verified",
          "REPROSEED_RESET_AUTHORIZATION is set. Doctor does not send POST /__reproseed/reset, so the application has not been asked to accept it.",
        )
      : check("reset-accepted", "skipped", "Skipped because REPROSEED_RESET_AUTHORIZATION is not set."),
    loaded.document === undefined
      ? check("clean-state-after-reset", "skipped", "Skipped because the scenario schema is invalid.")
      : check(
          "clean-state-after-reset",
          "not-verified",
          "Doctor does not send POST /__reproseed/reset, so emptiness after an authorized reset was not checked.",
        ),
  ];
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  const byId = new Map(checks.map((item) => [item.id, item]));
  for (const id of DOCTOR_PASS_REQUIRED) {
    if (byId.get(id)?.status !== "pass") {
      return EXIT.usage;
    }
  }
  return EXIT.verified;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const lines = [
    "ReproSeed doctor",
    "Doctor does not send POST /__reproseed/reset.",
    "Doctor does not launch a browser.",
    "",
    ...checks.map(formatCheck),
    "",
    summarizeDoctor(checks),
    doctorExitCode(checks) === EXIT.verified
      ? "No check failed. Reset acceptance and post-reset emptiness were not verified."
      : "Fix the failed checks before running minimize.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function summarizeDoctor(checks: readonly DoctorCheck[]): string {
  const count = (status: DoctorCheckStatus): number => checks.filter((item) => item.status === status).length;
  return `Summary: ${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped, ${count("not-verified")} not verified without a reset.`;
}

function formatCheck(check: DoctorCheck): string {
  return `${check.status.padEnd(12)}  ${check.id.padEnd(24)}  ${check.detail}`;
}

function check(id: DoctorCheckId, status: DoctorCheckStatus, detail: string): DoctorCheck {
  return { id, status, detail: oneLine(detail) };
}

async function loadDocument(
  path: string,
  cwd: string,
): Promise<{ parsed?: unknown; document?: ScenarioDocument; file: DoctorCheck; schema: DoctorCheck }> {
  let parsed: unknown;
  try {
    parsed = await readScenarioValue(path, cwd);
  } catch (error) {
    const detail = cliMessage(error);
    return {
      file: check("scenario-file", "fail", detail),
      schema: check("scenario-schema", "skipped", "Skipped because the scenario file could not be read."),
    };
  }
  try {
    const document = parseScenarioDocument(parsed);
    return {
      parsed,
      document,
      file: check("scenario-file", "pass", "Scenario file is readable JSON."),
      schema: check("scenario-schema", "pass", `Scenario ${document.id} matches the supported schema.`),
    };
  } catch (error) {
    return {
      parsed,
      file: check("scenario-file", "pass", "Scenario file is readable JSON."),
      schema: check("scenario-schema", "fail", cliMessage(error)),
    };
  }
}

type EnvironmentInspection = {
  check: DoctorCheck;
  status: DoctorCheckStatus;
  appId?: string;
  credential: boolean;
};

function inspectEnvironment(
  document: ScenarioDocument | undefined,
  parsed: unknown,
  env: NodeJS.ProcessEnv,
): EnvironmentInspection {
  const missing = ENV_NAMES.filter((name) => !present(env, name));
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`Missing ${missing.join(", ")}.`);
  }
  const configuredAppId = rawEnv(env, "REPROSEED_APP_ID");
  const configuredOrigin = rawEnv(env, "REPROSEED_ORIGIN");
  if (document?.listedAppId !== undefined && configuredAppId !== undefined && document.listedAppId !== configuredAppId) {
    problems.push("REPROSEED_APP_ID does not match target.appId in the scenario file.");
  }
  if (document?.listedOrigin !== undefined && configuredOrigin !== undefined && originsDisagree(document.listedOrigin, configuredOrigin)) {
    problems.push("REPROSEED_ORIGIN does not match target.origin in the scenario file.");
  }
  const credential = present(env, "REPROSEED_RESET_AUTHORIZATION");
  if (credential && parsed !== undefined) {
    try {
      assertNoEmbeddedResetAuthorization(parsed, env.REPROSEED_RESET_AUTHORIZATION ?? "");
    } catch (error) {
      problems.push(cliMessage(error));
    }
  }
  if (problems.length > 0) {
    const failed = check("environment", "fail", problems.join(" "));
    return { check: failed, status: "fail", credential, ...(configuredAppId !== undefined ? { appId: configuredAppId } : {}) };
  }
  const agreed = document?.listedOrigin !== undefined || document?.listedAppId !== undefined;
  const detail = agreed
    ? "REPROSEED_ORIGIN, REPROSEED_APP_ID, and REPROSEED_RESET_AUTHORIZATION are set and agree with the scenario file."
    : "REPROSEED_ORIGIN, REPROSEED_APP_ID, and REPROSEED_RESET_AUTHORIZATION are set.";
  return {
    check: check("environment", "pass", detail),
    status: "pass",
    credential,
    ...(configuredAppId !== undefined ? { appId: configuredAppId } : {}),
  };
}

function inspectLoopback(
  document: ScenarioDocument | undefined,
  env: NodeJS.ProcessEnv,
): { check: DoctorCheck; status: DoctorCheckStatus; origin?: string } {
  const configured = rawEnv(env, "REPROSEED_ORIGIN");
  const listed = document?.listedOrigin;
  if (listed !== undefined && configured !== undefined && originsDisagree(listed, configured)) {
    return {
      check: check(
        "loopback-origin",
        "skipped",
        "Skipped because REPROSEED_ORIGIN does not match target.origin. Doctor did not contact the application.",
      ),
      status: "skipped",
    };
  }
  const candidate = configured ?? listed;
  if (candidate === undefined || candidate === "") {
    return {
      check: check("loopback-origin", "skipped", "Skipped because no origin is set in the environment or the scenario file."),
      status: "skipped",
    };
  }
  try {
    const origin = canonicalOrigin(candidate);
    return {
      check: check("loopback-origin", "pass", `Origin ${origin} is an authorized loopback origin.`),
      status: "pass",
      origin,
    };
  } catch (error) {
    return {
      check: check("loopback-origin", "fail", `${cliMessage(error)} Doctor did not contact the application.`),
      status: "fail",
    };
  }
}

function skipReason(
  fileFailed: boolean,
  document: ScenarioDocument | undefined,
  environment: EnvironmentInspection,
  loopback: { status: DoctorCheckStatus },
): string {
  if (fileFailed) {
    return "Skipped because the scenario file could not be read. Doctor did not contact the application.";
  }
  if (document === undefined) {
    return "Skipped because the scenario schema is invalid. Doctor did not contact the application.";
  }
  if (environment.status !== "pass") {
    return "Skipped because the environment does not match this scenario. Doctor did not contact the application.";
  }
  if (loopback.status !== "pass") {
    return "Skipped because the origin is not an authorized loopback target. Doctor did not contact the application.";
  }
  return "Skipped because the target was not probed.";
}

function inspectChromium(inspect: DoctorCommand["inspectChromium"]): DoctorCheck {
  const result = (inspect ?? describeChromiumInstallation)();
  return check("chromium", result.ready ? "pass" : "fail", result.detail);
}

type NetworkChecks = {
  available: DoctorCheck;
  identity: DoctorCheck;
  cleanState: DoctorCheck;
  oracle: DoctorCheck;
};

function skippedNetwork(reason: string): NetworkChecks {
  return {
    available: check("target-available", "skipped", reason),
    identity: check("target-identity", "skipped", reason),
    cleanState: check("clean-state-endpoint", "skipped", reason),
    oracle: check("oracle-endpoint", "skipped", reason),
  };
}

async function probeTarget(input: {
  origin: string;
  appId: string;
  steps: readonly Step[];
  oracle: Oracle;
  verifyPath: string;
  verifyIsDefault: boolean;
  fetchImpl: FetchLike;
}): Promise<NetworkChecks> {
  const navigation = navigationPaths(input.steps);
  const readiness = await probeNavigation(input.fetchImpl, input.origin, navigation);
  if (readiness.kind === "unreachable") {
    const reason = `Skipped because ${input.origin} did not accept a connection.`;
    return {
      available: check("target-available", "fail", readiness.detail),
      identity: check("target-identity", "skipped", reason),
      cleanState: check("clean-state-endpoint", "skipped", reason),
      oracle: check("oracle-endpoint", "skipped", reason),
    };
  }
  const responses = new Map<string, ProbeGet>();
  const identity = await probeIdentity(input);
  const cleanState = await probeCleanState(input, responses);
  const oracle = await probeOracle(input, responses);
  return { available: readiness.check, identity, cleanState, oracle };
}

function navigationPaths(steps: readonly Step[]): { paths: string[]; fallback: boolean } {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "goto" || seen.has(step.path)) {
      continue;
    }
    seen.add(step.path);
    paths.push(step.path);
  }
  if (paths.length === 0) {
    return { paths: ["/"], fallback: true };
  }
  return { paths, fallback: false };
}

async function probeNavigation(
  fetchImpl: FetchLike,
  origin: string,
  navigation: { paths: string[]; fallback: boolean },
): Promise<{ kind: "unreachable"; detail: string } | { kind: "checked"; check: DoctorCheck }> {
  const lines: string[] = [];
  let reachable = false;
  let failed = false;
  for (const path of navigation.paths) {
    const result = await probeGet(fetchImpl, origin, path);
    if (result.kind === "network") {
      if (!reachable) {
        return { kind: "unreachable", detail: result.detail };
      }
      failed = true;
      lines.push(result.detail);
      continue;
    }
    if (result.kind === "refused") {
      failed = true;
      lines.push(result.detail);
      continue;
    }
    reachable = true;
    if (result.kind === "redirect") {
      failed = true;
      lines.push(`GET ${path} on ${origin} was a redirect. Doctor did not follow it.`);
      continue;
    }
    if (result.status >= 200 && result.status < 300) {
      lines.push(`GET ${path} on ${origin} returned status ${result.status}.`);
      continue;
    }
    failed = true;
    lines.push(navigationFailure(origin, path, result.status));
  }
  const suffix = navigation.fallback ? " The scenario has no goto step, so this request is GET /." : "";
  return {
    kind: "checked",
    check: check("target-available", failed ? "fail" : "pass", `${lines.join(" ")}${suffix}`),
  };
}

function navigationFailure(origin: string, path: string, status: number): string {
  if (status === 404) {
    return `GET ${path} on ${origin} returned status 404. The navigation path is missing.`;
  }
  if (status >= 500) {
    return `GET ${path} on ${origin} returned status ${status}. The server responded, but the response is a server failure.`;
  }
  return `GET ${path} on ${origin} returned status ${status}. The server responded, but the response is not successful.`;
}

async function probeIdentity(input: { origin: string; appId: string; fetchImpl: FetchLike }): Promise<DoctorCheck> {
  const result = await probeGet(input.fetchImpl, input.origin, "/__reproseed/identity");
  if (result.kind === "network" || result.kind === "refused") {
    return check("target-identity", "fail", result.detail);
  }
  if (result.kind === "redirect") {
    return check("target-identity", "fail", "GET /__reproseed/identity was a redirect. Doctor did not follow it.");
  }
  if (result.status === 404) {
    return check(
      "target-identity",
      "fail",
      "GET /__reproseed/identity returned 404. The application has not opted in. Start it with REPROSEED_APP_ID set.",
    );
  }
  if (result.status < 200 || result.status >= 300) {
    return check("target-identity", "fail", `GET /__reproseed/identity failed (${result.status}).`);
  }
  const appId = readAppId(result.body);
  if (appId === undefined) {
    return check("target-identity", "fail", "GET /__reproseed/identity did not return a string app id.");
  }
  if (appId !== input.appId) {
    return check(
      "target-identity",
      "fail",
      `GET /__reproseed/identity returned ${showId(appId)}, which does not match REPROSEED_APP_ID (${showId(input.appId)}).`,
    );
  }
  return check("target-identity", "pass", `GET /__reproseed/identity returned ${showId(appId)}.`);
}

async function probeCleanState(
  input: {
    origin: string;
    verifyPath: string;
    verifyIsDefault: boolean;
    fetchImpl: FetchLike;
  },
  responses: Map<string, ProbeGet>,
): Promise<DoctorCheck> {
  const result = await loadGet(input.fetchImpl, input.origin, input.verifyPath, responses);
  if (result.kind === "network" || result.kind === "refused") {
    return check("clean-state-endpoint", "fail", result.detail);
  }
  if (result.kind === "redirect") {
    return check("clean-state-endpoint", "fail", `GET ${input.verifyPath} was a redirect. Doctor did not follow it.`);
  }
  if (result.status < 200 || result.status >= 300) {
    return check("clean-state-endpoint", "fail", `GET ${input.verifyPath} failed (${result.status}).`);
  }
  if (result.bodyError !== undefined) {
    return check("clean-state-endpoint", "fail", `GET ${input.verifyPath} ${result.bodyError}.`);
  }
  if (!Array.isArray(result.body)) {
    return check("clean-state-endpoint", "fail", `GET ${input.verifyPath} did not return a JSON array.`);
  }
  const suffix = input.verifyIsDefault ? " reset.verify is omitted, so this is the default clean-state path." : "";
  const noun = result.body.length === 1 ? "item" : "items";
  return check(
    "clean-state-endpoint",
    "pass",
    `GET ${input.verifyPath} returned a JSON array with ${result.body.length} ${noun}. Reset verification accepts any JSON array items.${suffix}`,
  );
}

async function probeOracle(
  input: {
    origin: string;
    oracle: Oracle;
    verifyPath: string;
    fetchImpl: FetchLike;
  },
  responses: Map<string, ProbeGet>,
): Promise<DoctorCheck> {
  if (input.oracle.id !== "record-count") {
    return check(
      "oracle-endpoint",
      "pass",
      "The dom-text oracle reads element text. Doctor did not request a record list.",
    );
  }
  const oraclePath = input.oracle.request.path;
  const samePath = sameAuthorizedPath(input.origin, input.verifyPath, oraclePath);
  const result = await loadGet(input.fetchImpl, input.origin, oraclePath, responses);
  const shared = samePath ? " This is the same GET as reset verification." : " This is the record-count oracle, not reset verification.";
  if (result.kind === "network" || result.kind === "refused") {
    return check("oracle-endpoint", "fail", `${result.detail}${shared}`);
  }
  if (result.kind === "redirect") {
    return check("oracle-endpoint", "fail", `GET ${oraclePath} was a redirect. Doctor did not follow it.${shared}`);
  }
  if (result.status < 200 || result.status >= 300) {
    return check("oracle-endpoint", "fail", `GET ${oraclePath} failed (${result.status}).${shared}`);
  }
  if (result.bodyError !== undefined) {
    return check("oracle-endpoint", "fail", `GET ${oraclePath} ${result.bodyError}.${shared}`);
  }
  if (!Array.isArray(result.body)) {
    return check("oracle-endpoint", "fail", `GET ${oraclePath} did not return a JSON array.${shared}`);
  }
  if (result.body.length > 0) {
    const problems = recordShapeProblems(result.body);
    if (problems.length > 0) {
      return check(
        "oracle-endpoint",
        "fail",
        `GET ${oraclePath} returned a JSON array that the record-count oracle cannot read. ${formatRecordShapeProblems(problems)} Each item needs string id, email, and note, and numeric createdAt. Record values are not printed.${shared}`,
      );
    }
  }
  const noun = result.body.length === 1 ? "item" : "items";
  const shape =
    result.body.length > 0 ? " Each item matches the record-count shape." : " The record-count oracle accepts an empty list.";
  return check(
    "oracle-endpoint",
    "pass",
    `GET ${oraclePath} returned a JSON array with ${result.body.length} ${noun}.${shape}${shared}`,
  );
}

function sameAuthorizedPath(origin: string, left: string, right: string): boolean {
  try {
    const first = resolveAuthorizedUrl(origin, left);
    const second = resolveAuthorizedUrl(origin, right);
    return `${first.pathname}${first.search}` === `${second.pathname}${second.search}`;
  } catch {
    return left === right;
  }
}

async function loadGet(
  fetchImpl: FetchLike,
  origin: string,
  path: string,
  responses: Map<string, ProbeGet>,
): Promise<ProbeGet> {
  let key: string;
  try {
    const url = resolveAuthorizedUrl(origin, path);
    key = `${url.pathname}${url.search}`;
  } catch (error) {
    return { kind: "refused", detail: cliMessage(error) };
  }
  const cached = responses.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = await probeGet(fetchImpl, origin, key);
  responses.set(key, result);
  return result;
}

type ProbeGet =
  | { kind: "network"; detail: string }
  | { kind: "refused"; detail: string }
  | { kind: "redirect" }
  | { kind: "http"; status: number; body: unknown; bodyError?: string };

async function probeGet(fetchImpl: FetchLike, origin: string, path: string): Promise<ProbeGet> {
  let url: URL;
  try {
    url = resolveAuthorizedUrl(origin, path);
  } catch (error) {
    return { kind: "refused", detail: cliMessage(error) };
  }
  if (url.origin !== canonicalOrigin(origin)) {
    return { kind: "refused", detail: "doctor refused to contact a URL outside the authorized origin" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return { kind: "redirect" };
    }
    const parsed = await readLimitedJson(response);
    if (!parsed.ok) {
      return { kind: "http", status: response.status, body: undefined, bodyError: parsed.detail };
    }
    return { kind: "http", status: response.status, body: parsed.value };
  } catch (error) {
    if (controller.signal.aborted) {
      return { kind: "network", detail: `The request to ${url.origin} timed out after ${PROBE_TIMEOUT_MS}ms.` };
    }
    if (isRedirectError(error)) {
      return { kind: "redirect" };
    }
    return { kind: "network", detail: `Could not connect to ${canonicalOrigin(origin)} (${cliMessage(error)}).` };
  } finally {
    clearTimeout(timer);
  }
}

function guardedFetch(fetchImpl: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = requestUrl(input);
    if (method !== "GET" || url.includes("/__reproseed/reset")) {
      throw new Error("doctor refused to send a reset request");
    }
    return fetchImpl(input, init);
  };
}

function requestUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

async function readLimitedJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, detail: "body could not be read" };
  }
  if (text.length > 1_000_000) {
    return { ok: false, detail: "response was too large" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, detail: "response was not JSON" };
  }
}

function readAppId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("appId" in value)) {
    return undefined;
  }
  const appId = (value as { appId?: unknown }).appId;
  return typeof appId === "string" ? appId : undefined;
}

function present(env: NodeJS.ProcessEnv, name: (typeof ENV_NAMES)[number]): boolean {
  return rawEnv(env, name) !== undefined;
}

function rawEnv(env: NodeJS.ProcessEnv, name: (typeof ENV_NAMES)[number]): string | undefined {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}

function originsDisagree(listed: string, configured: string): boolean {
  try {
    return canonicalOrigin(listed) !== canonicalOrigin(configured);
  } catch {
    return listed.trim() !== configured.trim();
  }
}

function showId(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") {
    return "(empty)";
  }
  return compact.length <= 80 ? compact : `${compact.slice(0, 80)}…`;
}

function isRedirectError(error: unknown): boolean {
  return error instanceof Error && /redirect/i.test(error.message);
}

function cliMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "check failed";
  return oneLine(message);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
