import { cleanStateVerify } from "../core/clean-state.ts";
import type { JsonArrayEmptyVerify, ResetSpec } from "../core/types.ts";
import { assertLocalAuthorizedTarget, canonicalOrigin, resolveAuthorizedUrl } from "./safety.ts";
import { errorMessage, isAbortLike, ReplayTimeout } from "./timing.ts";

export type FetchLike = typeof fetch;

export type ListedRecord = {
  id: string;
  email: string;
  note: string;
  createdAt: number;
};

export class ResetFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetFailed";
  }
}

export async function fetchRecords(origin: string, fetchImpl: FetchLike = fetch): Promise<ListedRecord[]> {
  return readRecordList({ origin, path: "/api/records", fetchImpl });
}

export async function readRecordList(input: {
  origin: string;
  path: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ListedRecord[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = resolveAuthorizedUrl(input.origin, input.path);
  let response: Response;
  try {
    response = await fetchImpl(url, requestInit({ signal: input.signal }));
  } catch (error) {
    if (isAbortLike(error, input.signal)) {
      throw new ReplayTimeout();
    }
    throw new Error(errorMessage(error));
  }
  if (!response.ok) {
    throw new Error(`record list failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(isListedRecord)) {
    throw new Error("record list payload was not a list of records");
  }
  return body;
}

const RECORD_FIELDS = [
  ["id", "string"],
  ["email", "string"],
  ["note", "string"],
  ["createdAt", "number"],
] as const;

const RECORD_SHAPE_REPORT_LIMIT = 8;

/**
 * The minimizer and doctor share this shape. Extra fields are allowed.
 * A missing field and a field of the wrong type are different problems.
 * The text names the item and the field. It does not include field values.
 */
export function isListedRecord(value: unknown): value is ListedRecord {
  return recordShapeProblem(value, 0) === undefined;
}

export function recordShapeProblems(items: readonly unknown[]): string[] {
  const problems: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const problem = recordShapeProblem(items[index], index);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return problems;
}

export function formatRecordShapeProblems(problems: readonly string[]): string {
  if (problems.length <= RECORD_SHAPE_REPORT_LIMIT) {
    return problems.join(" ");
  }
  const hidden = problems.length - RECORD_SHAPE_REPORT_LIMIT;
  const noun = hidden === 1 ? "item" : "items";
  return `${problems.slice(0, RECORD_SHAPE_REPORT_LIMIT).join(" ")} ${hidden} more ${noun} also failed the record shape.`;
}

function recordShapeProblem(value: unknown, index: number): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `item ${index} is not a record object`;
  }
  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const [field, type] of RECORD_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      missing.push(field);
      continue;
    }
    if (typeof record[field] !== type) {
      wrong.push(field);
    }
  }
  if (missing.length === 0 && wrong.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing ${missing.join(", ")}`);
  }
  if (wrong.length > 0) {
    parts.push(`wrong type for ${wrong.join(", ")}`);
  }
  return `item ${index}: ${parts.join("; ")}`;
}

/**
 * Confirms the process identity, then resets it, then reads the clean-state endpoint.
 * A loopback address is not enough: the exposed app id must match, and the
 * authorization header must be accepted. Redirects are rejected so the
 * authorization header cannot be forwarded to another host.
 * `verify` defaults to `GET /api/records` when a scenario omits the rule.
 * The path is resolved before any request. The check is a JSON array of length 0.
 */
export async function resetAndConfirmEmpty(input: {
  origin: string;
  expectedAppId: string;
  resetAuthorization: string;
  verify?: JsonArrayEmptyVerify;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<void> {
  assertLocalAuthorizedTarget(input.origin, input.expectedAppId, input.resetAuthorization);
  const verify = requireJsonArrayEmpty(input.verify);
  const origin = canonicalOrigin(input.origin);
  resolveAuthorizedUrl(origin, verify.path);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const identityResponse = await fetchImpl(
      resolveAuthorizedUrl(origin, "/__reproseed/identity"),
      requestInit({ signal: input.signal }),
    );
    if (redirected(identityResponse)) {
      throw new ResetFailed("target identity check refused a redirect");
    }
    if (!identityResponse.ok) {
      throw new ResetFailed(`target did not expose an app identity (${identityResponse.status})`);
    }
    const identity: unknown = await identityResponse.json();
    if (!isIdentity(identity) || identity.appId !== input.expectedAppId) {
      throw new ResetFailed("target app identity does not match");
    }
    const resetResponse = await fetchImpl(resolveAuthorizedUrl(origin, "/__reproseed/reset"), {
      ...requestInit({ method: "POST", signal: input.signal }),
      headers: {
        "x-reproseed-app-id": input.expectedAppId,
        "x-reproseed-reset-authorization": input.resetAuthorization,
      },
    });
    if (redirected(resetResponse)) {
      throw new ResetFailed("reset refused a redirect");
    }
    if (!resetResponse.ok) {
      throw new ResetFailed(`reset failed (${resetResponse.status})`);
    }
    await confirmJsonArrayEmpty({ origin, path: verify.path, fetchImpl, signal: input.signal });
  } catch (error) {
    if (isAbortLike(error, input.signal)) {
      throw new ReplayTimeout();
    }
    if (error instanceof ResetFailed) {
      throw error;
    }
    throw new ResetFailed(errorMessage(error));
  }
}

function requireJsonArrayEmpty(verify: JsonArrayEmptyVerify | undefined): JsonArrayEmptyVerify {
  const resolved = cleanStateVerify(resetSpec(verify));
  if (resolved.kind !== "json-array-empty" || resolved.method !== "GET") {
    throw new ResetFailed("reset verification must be a GET json-array-empty check");
  }
  return resolved;
}

function resetSpec(verify: JsonArrayEmptyVerify | undefined): ResetSpec {
  return {
    method: "POST",
    path: "/__reproseed/reset",
    ...(verify !== undefined ? { verify } : {}),
  };
}

async function confirmJsonArrayEmpty(input: {
  origin: string;
  path: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<void> {
  const url = resolveAuthorizedUrl(input.origin, input.path);
  let response: Response;
  try {
    response = await input.fetchImpl(url, requestInit({ signal: input.signal }));
  } catch (error) {
    if (isAbortLike(error, input.signal)) {
      throw new ReplayTimeout();
    }
    throw new ResetFailed(errorMessage(error));
  }
  if (redirected(response)) {
    throw new ResetFailed("clean-state check refused a redirect");
  }
  if (!response.ok) {
    throw new ResetFailed(`clean-state check failed (${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortLike(error, input.signal)) {
      throw new ReplayTimeout();
    }
    throw new ResetFailed("clean-state response was not JSON");
  }
  if (!Array.isArray(body)) {
    throw new ResetFailed("clean-state response was not a JSON array");
  }
  if (body.length !== 0) {
    throw new ResetFailed("clean-state response was not empty");
  }
}

function redirected(response: Response): boolean {
  return response.redirected || (response.status >= 300 && response.status < 400);
}

function requestInit(input: { method?: "POST"; signal?: AbortSignal }): RequestInit {
  return {
    redirect: "error",
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

function isIdentity(value: unknown): value is { appId: string } {
  return typeof value === "object" && value !== null && "appId" in value && typeof value.appId === "string";
}
