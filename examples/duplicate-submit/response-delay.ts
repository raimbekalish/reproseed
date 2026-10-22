import type { Page } from "playwright";

import { installMatchedResponseDelay } from "../../src/runner/faults.ts";

export type ResponseDelay = {
  postCount: () => number;
  dispose: () => Promise<void>;
};

/**
 * Holds the browser-visible response after the server has processed the POST.
 * Delegates to the runner so the demo and the replayer share one delay path:
 * `route.fetch()`, wait, then `route.fulfill({ response })`.
 */
export async function installResponseDelay(page: Page, delayMs: number): Promise<ResponseDelay> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error("response delay must be a positive number");
  }
  const origin = new URL(page.url()).origin;
  let posts = 0;
  const delay = await installMatchedResponseDelay(page.context(), {
    origin,
    urlIncludes: "/api/records",
    method: "POST",
    ms: delayMs,
    onDelayedPost: () => {
      posts += 1;
    },
  });
  return {
    postCount: () => posts,
    dispose: () => delay.dispose(),
  };
}
