import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { chromium, type Browser } from "playwright";

import { bounded, CLEANUP_BUDGET_MS } from "./timing.ts";

const MISSING_EXECUTABLE = /Executable doesn't exist at ([^\n]+)/;
const LAUNCH_TIMEOUT_MS = 30_000;

export type BrowserPool = {
  acquire: () => Promise<Browser>;
  current: () => Browser | undefined;
  close: () => Promise<void>;
};

/**
 * Point one child environment at Playwright's default cache when its
 * `PLAYWRIGHT_BROWSERS_PATH` does not contain the revision Playwright asked for.
 * An explicit path that already contains that executable is left unchanged.
 * Only the object passed in is modified, and only by deleting that one variable.
 */
export function useInstalledPlaywrightBrowsers(env: NodeJS.ProcessEnv): void {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === undefined || configured === "" || configured === "0") {
    return;
  }
  let executable: string;
  try {
    executable = chromium.executablePath();
  } catch {
    return;
  }
  if (existsSync(executable)) {
    return;
  }
  const fallback = fallbackPlaywrightExecutable(new Error(`Executable doesn't exist at ${executable}`));
  if (fallback !== undefined) {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
  }
}

/**
 * Launches Playwright's Chromium build, not chrome-headless-shell.
 * On macOS 26 the headless shell aborts with SIGTRAP during replays.
 * `channel: "chromium"` is that same downloaded revision (Chrome for Testing).
 * It is not the system Chrome channel.
 */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      channel: "chromium",
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch (error) {
    const executablePath = fallbackPlaywrightExecutable(error);
    if (executablePath === undefined) {
      throw error;
    }
    return chromium.launch({ headless: true, executablePath, timeout: LAUNCH_TIMEOUT_MS });
  }
}

/**
 * Playwright resolves its browser from PLAYWRIGHT_BROWSERS_PATH. When that
 * directory does not contain the revision it asked for, use the same relative
 * executable from Playwright's default cache if it is already installed.
 */
export function fallbackPlaywrightExecutable(
  error: unknown,
  browsersRoot = defaultPlaywrightBrowsersRoot(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const missing = MISSING_EXECUTABLE.exec(error.message)?.[1]?.trim();
  const relativeBrowser = missing === undefined ? undefined : relativeBrowserPath(missing);
  if (relativeBrowser === undefined) {
    return undefined;
  }
  const root = resolve(browsersRoot);
  const candidate = resolve(root, relativeBrowser);
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.split(sep).includes("..")) {
    return undefined;
  }
  return exists(candidate) ? candidate : undefined;
}

function relativeBrowserPath(missing: string): string | undefined {
  const normalized = missing.replaceAll("\\", "/");
  const headless = normalized.lastIndexOf("chromium_headless_shell-");
  const chromium = normalized.lastIndexOf("chromium-");
  const index = headless >= 0 ? headless : chromium;
  if (index < 0) {
    return undefined;
  }
  return join(...normalized.slice(index).split("/"));
}

function defaultPlaywrightBrowsersRoot(): string {
  if (process.platform === "linux") {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(cache, "ms-playwright");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "ms-playwright");
  }
  return join(homedir(), "ms-playwright");
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
