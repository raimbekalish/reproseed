/**
 * Loopback is not authorization. Reset still requires the app id and the
 * reset credential after these checks pass. Callers must run this before any
 * reset request.
 */

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
  if (!isLoopbackHost(url.hostname)) {
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

export function canonicalOrigin(origin: string): string {
  assertLoopbackOrigin(origin);
  return new URL(origin).origin;
}

/** Resolves a scenario path and refuses anything that would leave the authorized origin. */
export function resolveAuthorizedUrl(origin: string, path: string): URL {
  const allowed = canonicalOrigin(origin);
  if (path.includes("\\") || path.startsWith("//") || !path.startsWith("/") || /^[a-zA-Z][a-zA-Z+\-.]*:/.test(path)) {
    throw new Error("path must stay on the authorized origin");
  }
  let url: URL;
  try {
    url = new URL(path, allowed);
  } catch {
    throw new Error("path must stay on the authorized origin");
  }
  if (url.origin !== allowed || url.username !== "" || url.password !== "" || url.protocol !== "http:") {
    throw new Error("path must stay on the authorized origin");
  }
  return url;
}

export function sameAuthorizedOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === canonicalOrigin(origin);
  } catch {
    return false;
  }
}

export function assertPageStayed(pageUrl: string, origin: string, allowBlank: boolean): void {
  if (allowBlank && pageUrl === "about:blank") {
    return;
  }
  let current: URL;
  try {
    current = new URL(pageUrl);
  } catch {
    throw new Error("navigation left the authorized origin");
  }
  if (
    current.origin !== canonicalOrigin(origin) ||
    current.protocol !== "http:" ||
    current.username !== "" ||
    current.password !== ""
  ) {
    throw new Error("navigation left the authorized origin");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
