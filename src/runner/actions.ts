import type { Page } from "playwright";

import type { ClickStep, FillStep, GotoStep, WaitStep } from "../core/types.ts";
import { assertPageStayed, resolveAuthorizedUrl } from "./safety.ts";
import { ReplayTimeout, sleep, throwIfAborted } from "./timing.ts";

export async function executeAction(
  page: Page,
  step: GotoStep | FillStep | ClickStep | WaitStep,
  input: { origin: string; signal: AbortSignal; startedAt: number; timeoutMs: number },
): Promise<void> {
  const timeout = remainingMs(input);
  switch (step.kind) {
    case "goto": {
      const url = resolveAuthorizedUrl(input.origin, step.path);
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout });
      if (response === null || response.status() >= 300) {
        throw new Error(response !== null && response.status() < 400 ? "navigation refused a redirect" : "goto failed");
      }
      assertPageStayed(response.url(), input.origin, false);
      assertPageStayed(page.url(), input.origin, false);
      return;
    }
    case "fill":
      await page.locator(step.selector).fill(step.value, { timeout });
      assertPageStayed(page.url(), input.origin, true);
      return;
    case "click":
      await page.locator(step.selector).click({ timeout, noWaitAfter: true });
      assertPageStayed(page.url(), input.origin, true);
      return;
    case "wait":
      if (step.ms > timeout) {
        await sleep(timeout, input.signal);
        throw new ReplayTimeout();
      }
      await sleep(step.ms, input.signal);
      assertPageStayed(page.url(), input.origin, true);
      return;
    default: {
      const unreachable: never = step;
      throw new Error(`unknown action ${(unreachable as { kind?: string }).kind ?? "step"}`);
    }
  }
}

function remainingMs(input: { signal: AbortSignal; startedAt: number; timeoutMs: number }): number {
  throwIfAborted(input.signal);
  const left = input.timeoutMs - (Date.now() - input.startedAt);
  if (left <= 0) {
    throw new ReplayTimeout();
  }
  return left;
}
