import type { Page, Request, Response } from "playwright";

import { sameAuthorizedOrigin } from "./safety.ts";
import { sleep } from "./timing.ts";

const QUIET_MS = 50;

export type RequestTracker = {
  pending: () => number;
  waitUntilSettled: (signal: AbortSignal) => Promise<void>;
  dispose: () => void;
};

/** Tracks same-origin browser requests so the oracle runs after delayed responses are delivered. */
export function trackOriginRequests(page: Page, origin: string): RequestTracker {
  const pending = new Set<Request>();
  const onRequest = (request: Request): void => {
    if (sameAuthorizedOrigin(request.url(), origin)) {
      pending.add(request);
    }
  };
  const onDone = (request: Request): void => {
    pending.delete(request);
  };
  const onResponse = (response: Response): void => {
    // A fulfilled route delivers the response without always emitting requestfinished.
    pending.delete(response.request());
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  return {
    pending: () => pending.size,
    waitUntilSettled: async (signal) => {
      let quietStarted: number | undefined;
      while (true) {
        if (pending.size === 0) {
          if (quietStarted === undefined) {
            quietStarted = Date.now();
          }
          if (Date.now() - quietStarted >= QUIET_MS) {
            return;
          }
        } else {
          quietStarted = undefined;
        }
        await sleep(15, signal);
      }
    },
    dispose: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
}

/**
 * Gives a fetch callback time to write textContent after the response is delivered.
 * The network is already quiet. Two timers let the response JSON callback run first.
 */
export async function settleAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          setTimeout(() => {
            resolve();
          }, 0);
        }, 0);
      }),
  );
}
