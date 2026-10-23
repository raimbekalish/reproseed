/**
 * Decides whether one browser request receives an injected response delay.
 *
 * The needle is compared with the pathname and query only. The origin is checked
 * separately, so a needle cannot match the host or port.
 *
 * POST keeps substring matching. Existing scenarios delay `POST /api/records`
 * with the needle `/api/records`, including a request that adds a query string.
 *
 * GET requires the needle to end at a boundary (`&`, `#`, or the end of the
 * path and query). `/api/search?q=alpha` therefore matches that search and does
 * not match `/api/search?q=alphabet` or `/api/search?q=beta`.
 *
 * `/__reproseed/identity` and `/__reproseed/reset` are never delayed. Page
 * resources and other requests stay fast unless their own path and query match.
 *
 * This file is embedded in generated Playwright specs, so it must stay free of imports.
 */

export type DelayMatchMethod = "GET" | "POST";

const CONTROL_PATHS = ["/__reproseed/identity", "/__reproseed/reset"];

export function requestMatchesDelay(input: {
  method: string;
  url: string;
  origin: string;
  urlIncludes: string;
  delayMethod: DelayMatchMethod;
}): boolean {
  if (input.urlIncludes === "" || input.method !== input.delayMethod) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return false;
  }
  if (parsed.origin !== input.origin) {
    return false;
  }
  if (CONTROL_PATHS.includes(parsed.pathname)) {
    return false;
  }
  const target = `${parsed.pathname}${parsed.search}`;
  if (input.delayMethod === "POST") {
    return target.includes(input.urlIncludes);
  }
  return includesBounded(target, input.urlIncludes);
}

function includesBounded(target: string, needle: string): boolean {
  let from = 0;
  while (from <= target.length) {
    const at = target.indexOf(needle, from);
    if (at === -1) {
      return false;
    }
    const next = target[at + needle.length];
    if (next === undefined || next === "&" || next === "#") {
      return true;
    }
    from = at + 1;
  }
  return false;
}
