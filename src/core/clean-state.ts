import { ScenarioError, type JsonArrayEmptyVerify, type ResetSpec } from "./types.ts";

/** Duplicate-submit scenarios that omit `reset.verify` keep this endpoint. */
export const DEFAULT_CLEAN_STATE_PATH = "/api/records";

/**
 * The check the runner, CLI, and exporter actually perform.
 * An omitted rule stays `GET /api/records`. A declared rule is copied, not rewritten.
 */
export function cleanStateVerify(reset: ResetSpec): JsonArrayEmptyVerify {
  if (reset.verify === undefined) {
    return { kind: "json-array-empty", method: "GET", path: DEFAULT_CLEAN_STATE_PATH };
  }
  return { kind: reset.verify.kind, method: reset.verify.method, path: reset.verify.path };
}

/** Rejects anything other than one same-origin GET that expects an empty JSON array. */
export function assertCleanStateVerify(reset: ResetSpec): void {
  const verify = reset.verify;
  if (verify === undefined) {
    return;
  }
  if (verify.kind !== "json-array-empty" || verify.method !== "GET") {
    throw new ScenarioError("reset.verify must be a GET json-array-empty check");
  }
  if (typeof verify.path !== "string") {
    throw new ScenarioError("reset.verify.path is required");
  }
  assertRelativePath(verify.path);
}

function assertRelativePath(path: string): void {
  if (path.length === 0 || path.length > 300 || path !== path.trim()) {
    throw new ScenarioError("reset.verify.path must be a same-origin path");
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    throw new ScenarioError("reset.verify.path must stay on the authorized origin");
  }
  if (/[\u0000-\u001f\u007f]/.test(path) || /javascript\s*:/i.test(path) || /^[a-zA-Z][a-zA-Z+\-.]*:/.test(path)) {
    throw new ScenarioError("reset.verify.path must stay on the authorized origin");
  }
  let url: URL;
  try {
    url = new URL(path, "http://127.0.0.1");
  } catch {
    throw new ScenarioError("reset.verify.path must stay on the authorized origin");
  }
  if (url.origin !== "http://127.0.0.1" || url.username !== "" || url.password !== "" || url.protocol !== "http:") {
    throw new ScenarioError("reset.verify.path must stay on the authorized origin");
  }
}
