import type { Page, Route } from "playwright";

export type ResponseDelay = {
  postCount: () => number;
  dispose: () => Promise<void>;
};

/**
 * Holds the browser-visible response after the server has processed the POST.
 * `route.fetch()` performs the real request. The wait happens before
 * `route.fulfill({ response })`. Delaying before `route.continue()` would
 * hold request dispatch instead, and would not reproduce this bug.
 */
export async function installResponseDelay(page: Page, delayMs: number): Promise<ResponseDelay> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error("response delay must be a positive number");
  }
  const controller = new AbortController();
  let posts = 0;

  const handler = async (route: Route): Promise<void> => {
    try {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      posts += 1;
      await sleep(delayMs, controller.signal);
      if (controller.signal.aborted) {
        await route.abort();
        return;
      }
      await route.fulfill({ response });
    } catch {
      // The page or context is closing.
    }
  };

  await page.route("**/api/records", handler);
  return {
    postCount: () => posts,
    dispose: async () => {
      controller.abort();
      await page.unroute("**/api/records", handler);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
