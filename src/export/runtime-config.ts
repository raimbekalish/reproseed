/**
 * Runtime configuration for a generated Playwright spec.
 * This module is embedded verbatim into that spec, so it must stay free of imports.
 */

export type RuntimeConfig = {
  origin: string;
  appId: string;
  resetAuthorization: string;
};

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const originValue = requiredEnv(env, "REPROSEED_ORIGIN");
  const appId = requiredEnv(env, "REPROSEED_APP_ID");
  const resetAuthorization = requiredEnv(env, "REPROSEED_RESET_AUTHORIZATION");
  return {
    origin: assertLoopbackHttpOrigin(originValue),
    appId,
    resetAuthorization,
  };
}

/** Accepts an http loopback origin and returns its canonical form. Credentials and paths are refused. */
export function assertLoopbackHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be an absolute http URL");
  }
  if (url.protocol !== "http:") {
    throw new Error("origin must be an absolute http URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("origin must not include credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("origin must not include a path, query, or hash");
  }
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("origin must be a loopback host");
  }
  return url.origin;
}

/** Resolves a scenario path and refuses anything that would leave the authorized origin. */
export function authorizedUrl(origin: string, path: string): string {
  const allowed = assertLoopbackHttpOrigin(origin);
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
  return url.href;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
