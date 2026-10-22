import { chromium, type Browser } from "playwright";

import { bounded, CLEANUP_BUDGET_MS } from "./timing.ts";

export type BrowserPool = {
  acquire: () => Promise<Browser>;
  current: () => Browser | undefined;
  close: () => Promise<void>;
};

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Reuses one browser process. Each replay still opens its own context. */
export function createBrowserPool(launch: () => Promise<Browser> = launchChromium): BrowserPool {
  let browser: Browser | undefined;

  return {
    current: () => browser,
    acquire: async () => {
      if (browser !== undefined && browser.isConnected()) {
        return browser;
      }
      const stale = browser;
      browser = undefined;
      if (stale !== undefined && stale.isConnected()) {
        await stale.close().catch(() => undefined);
      }
      browser = await launch();
      return browser;
    },
    close: async () => {
      const current = browser;
      browser = undefined;
      if (current === undefined || !current.isConnected()) {
        return;
      }
      await bounded(current.close(), CLEANUP_BUDGET_MS, "browser cleanup timed out");
    },
  };
}
