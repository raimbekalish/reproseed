import { randomUUID } from "node:crypto";
import type { BrowserContext, Route } from "playwright";

import { canonicalOrigin, sameAuthorizedOrigin } from "./safety.ts";
import { sleep } from "./timing.ts";

const FETCH_HEADER = "x-reproseed-internal-fetch";

export type ResponseDelay = {
  dispose: () => Promise<void>;
  inFlight: () => number;
};

/**
 * Holds the browser-visible response after the server has processed the POST.
 * `route.fetch()` performs the real request. The wait happens before
 * `route.fulfill({ response })`. Each matching request is delayed on its own
 * so overlapping submits do not share one response.
 */
export async function installMatchedResponseDelay(
  context: BrowserContext,
  input: {
    origin: string;
    urlIncludes: string;
    method: "POST";
    ms: number;
    signal?: AbortSignal;
    onDelayedPost?: () => void;
  },
): Promise<ResponseDelay> {
  const marker = randomUUID();
  const localController = new AbortController();
  const abortFromParent = (): void => {
    localController.abort();
  };
  if (input.signal?.aborted === true) {
    localController.abort();
  } else {
    input.signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  let inFlight = 0;
  let disposing: Promise<void> | undefined;

  const handler = async (route: Route): Promise<void> => {
    try {
      if (!matchesDelayedRequest(route, input)) {
        await route.fallback();
        return;
      }
      if (route.request().headers()[FETCH_HEADER] === marker) {
        await route.continue();
        return;
      }
      if (localController.signal.aborted) {
        await route.abort();
        return;
      }
      inFlight += 1;
      try {
        const response = await route.fetch({
          headers: forwardedHeaders(route.request().headers(), marker),
          maxRedirects: 0,
          signal: localController.signal,
          timeout: 0,
        });
        input.onDelayedPost?.();
        await sleep(input.ms, localController.signal);
        if (localController.signal.aborted) {
          await route.abort();
          return;
        }
        await fulfillFetched(route, response);
      } finally {
        inFlight -= 1;
      }
    } catch {
      try {
        await route.abort();
      } catch {
        // The route was already settled, or the context is closing.
      }
    }
  };

  await context.route("**/*", handler);

  return {
    inFlight: () => inFlight,
    dispose: () => {
      if (disposing === undefined) {
        disposing = (async () => {
          localController.abort();
          input.signal?.removeEventListener("abort", abortFromParent);
          const deadline = Date.now() + 2_000;
          while (inFlight > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          try {
            await context.unroute("**/*", handler);
          } catch {
            // The context is already closed.
          }
        })();
      }
      return disposing;
    },
  };
}

/**
 * Serves same-origin responses without letting the browser follow a redirect
 * off the authorized origin. `route.continue()` lets Chromium follow that
 * redirect before another route handler can see it.
 */
export async function installOriginGuard(context: BrowserContext, origin: string): Promise<void> {
  const allowed = canonicalOrigin(origin);
  const marker = randomUUID();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    try {
      if (!sameAuthorizedOrigin(url, origin)) {
        await route.abort("blockedbyclient");
        return;
      }
      if (request.headers()[FETCH_HEADER] === marker) {
        await route.continue();
        return;
      }
      const response = await route.fetch({
        headers: forwardedHeaders(request.headers(), marker),
        maxRedirects: 0,
        timeout: 0,
      });
      if (redirectLeavesOrigin(response.status(), response.headers()["location"], url, allowed)) {
        await response.body().catch(() => undefined);
        await route.abort("blockedbyclient");
        return;
      }
      await fulfillFetched(route, response);
    } catch {
      try {
        await route.abort("blockedbyclient");
      } catch {
        // The context is closing.
      }
    }
  });
}

function redirectLeavesOrigin(status: number, location: string | undefined, url: string, allowed: string): boolean {
  if (status < 300 || status >= 400) {
    return false;
  }
  if (location === undefined || location === "") {
    return true;
  }
  try {
    return new URL(location, url).origin !== allowed;
  } catch {
    return true;
  }
}

async function fulfillFetched(route: Route, response: Awaited<ReturnType<Route["fetch"]>>): Promise<void> {
  const headers: Record<string, string> = { ...response.headers() };
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers["content-encoding"];
  await route.fulfill({
    status: response.status(),
    headers,
    body: await response.body(),
  });
}

function forwardedHeaders(headers: Record<string, string>, marker: string): Record<string, string> {
  const forwarded: Record<string, string> = { ...headers, [FETCH_HEADER]: marker };
  for (const name of ["host", "content-length", "connection", "transfer-encoding"]) {
    delete forwarded[name];
  }
  return forwarded;
}

function matchesDelayedRequest(
  route: Route,
  input: { origin: string; urlIncludes: string; method: "POST" },
): boolean {
  const request = route.request();
  if (request.method() !== input.method) {
    return false;
  }
  const url = request.url();
  return sameAuthorizedOrigin(url, input.origin) && url.includes(input.urlIncludes);
}
