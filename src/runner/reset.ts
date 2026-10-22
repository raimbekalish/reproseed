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
  if (!Array.isArray(body) || !body.every(isRecord)) {
    throw new Error("record list payload was not a list of records");
  }
  return body;
}

/**
 * Confirms the process identity, then resets it.
 * A loopback address is not enough: the exposed app id must match, and the
 * authorization header must be accepted. Redirects are rejected so the
 * authorization header cannot be forwarded to another host.
 */
export async function resetAndConfirmEmpty(input: {
  origin: string;
  expectedAppId: string;
  resetAuthorization: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<void> {
  assertLocalAuthorizedTarget(input.origin, input.expectedAppId, input.resetAuthorization);
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = canonicalOrigin(input.origin);
  try {
    const identityResponse = await fetchImpl(
      resolveAuthorizedUrl(origin, "/__reproseed/identity"),
      requestInit({ signal: input.signal }),
    );
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
    if (!resetResponse.ok) {
      throw new ResetFailed(`reset failed (${resetResponse.status})`);
    }
    const records = await readRecordList({ origin, path: "/api/records", fetchImpl, signal: input.signal });
    if (records.length !== 0) {
      throw new ResetFailed("record list was not empty after reset");
    }
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

function isRecord(value: unknown): value is ListedRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { id?: unknown; email?: unknown; note?: unknown; createdAt?: unknown };
  return (
    typeof record.id === "string" &&
    typeof record.email === "string" &&
    typeof record.note === "string" &&
    typeof record.createdAt === "number"
  );
}
