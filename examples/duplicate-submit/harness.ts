import type { DemoRecord } from "./server.ts";

export type FetchLike = typeof fetch;

export function assertLoopbackOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("target origin must be an absolute URL");
  }
  if (url.protocol !== "http:") {
    throw new Error("demo reset refuses a non-http origin");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("demo reset refuses credentials embedded in the origin");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("demo reset target must be an origin");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
    throw new Error(`demo reset refuses non-loopback host ${url.hostname}`);
  }
}

export function assertLocalAuthorizedTarget(origin: string, appId: string, resetAuthorization: string): void {
  if (appId.trim() === "") {
    throw new Error("target.appId is required before reset");
  }
  if (resetAuthorization.trim() === "") {
    throw new Error("target.resetAuthorization is required before reset");
  }
  assertLoopbackOrigin(origin);
}

export async function fetchRecords(origin: string, fetchImpl: FetchLike = fetch): Promise<DemoRecord[]> {
  assertLoopbackOrigin(origin);
  const response = await fetchImpl(new URL("/api/records", origin), { redirect: "error" });
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
}): Promise<void> {
  assertLocalAuthorizedTarget(input.origin, input.expectedAppId, input.resetAuthorization);
  const fetchImpl = input.fetchImpl ?? fetch;
  const identityResponse = await fetchImpl(new URL("/__reproseed/identity", input.origin), { redirect: "error" });
  if (!identityResponse.ok) {
    throw new Error(`target did not expose an app identity (${identityResponse.status})`);
  }
  const identity: unknown = await identityResponse.json();
  if (!isIdentity(identity) || identity.appId !== input.expectedAppId) {
    throw new Error("target app identity does not match");
  }
  const resetResponse = await fetchImpl(new URL("/__reproseed/reset", input.origin), {
    method: "POST",
    redirect: "error",
    headers: {
      "x-reproseed-app-id": input.expectedAppId,
      "x-reproseed-reset-authorization": input.resetAuthorization,
    },
  });
  if (!resetResponse.ok) {
    throw new Error(`reset failed (${resetResponse.status})`);
  }
  const records = await fetchRecords(input.origin, fetchImpl);
  if (records.length !== 0) {
    throw new Error("record list was not empty after reset");
  }
}

function isIdentity(value: unknown): value is { appId: string } {
  return typeof value === "object" && value !== null && "appId" in value && typeof value.appId === "string";
}

function isRecord(value: unknown): value is DemoRecord {
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
