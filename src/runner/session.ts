import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { chromium, type Browser } from "playwright";

import { bounded, CLEANUP_BUDGET_MS } from "./timing.ts";

const MISSING_EXECUTABLE = /Executable doesn't exist at ([^\n]+)/;
const LAUNCH_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_PATH_LIMIT = 180;
const DIAGNOSTIC_LIMIT = 1_200;
const DOWNLOADED_CHROMIUM = /(?:^|\/)chromium-\d+\//;

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
 * Launches Playwright's downloaded Chromium build, not chrome-headless-shell
 * and not a system Chrome channel. On macOS 26 the headless shell aborts with
 * SIGTRAP during replays. `channel: "chromium"` selects that downloaded revision
 * on Linux and macOS. A missing executable is recovered only when the same
 * Chromium revision is already present in Playwright's default cache.
 */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      channel: "chromium",
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch (error) {
    const executablePath = chromiumLaunchFallback(error);
    if (executablePath === undefined) {
      throw annotateLaunchError(error);
    }
    try {
      return await chromium.launch({ headless: true, executablePath, timeout: LAUNCH_TIMEOUT_MS });
    } catch (fallbackError) {
      throw annotateLaunchError(fallbackError, executablePath);
    }
  }
}

/**
 * Same-revision recovery for `launchChromium`. Headless-shell and system-browser
 * paths are refused so a failed Chromium launch cannot switch binaries.
 */
export function chromiumLaunchFallback(
  error: unknown,
  browsersRoot = defaultPlaywrightBrowsersRoot(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidate = fallbackPlaywrightExecutable(error, browsersRoot, exists);
  if (candidate === undefined || !isDownloadedChromiumExecutable(candidate)) {
    return undefined;
  }
  return candidate;
}

/** Bounded launch context for CI logs. Does not include the reset credential. */
export function formatLaunchDiagnostic(fallbackPath?: string): string {
  let executable = "unavailable";
  try {
    const candidate = chromium.executablePath();
    executable = `${candidate} (${existsSync(candidate) ? "present" : "missing"})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    executable = `unavailable (${message})`;
  }
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const browsers = configured === undefined || configured === "" ? "unset" : truncate(configured, DIAGNOSTIC_PATH_LIMIT);
  const lines = [
    `playwright launch: platform=${process.platform} arch=${process.arch} headless=true channel=chromium timeoutMs=${LAUNCH_TIMEOUT_MS}`,
    `playwright executable=${truncate(executable, DIAGNOSTIC_PATH_LIMIT)}`,
    `PLAYWRIGHT_BROWSERS_PATH=${browsers}`,
  ];
  if (fallbackPath !== undefined) {
    const state = existsSync(fallbackPath) ? "present" : "missing";
    lines.push(`fallback executable=${truncate(fallbackPath, DIAGNOSTIC_PATH_LIMIT)} (${state})`);
  }
  return redact(lines.join("\n")).slice(0, DIAGNOSTIC_LIMIT);
}

function annotateLaunchError(error: unknown, fallbackPath?: string): Error {
  const note = formatLaunchDiagnostic(fallbackPath);
  if (error instanceof Error) {
    const annotated = new Error(`${error.message}\n${note}`);
    annotated.name = error.name;
    annotated.cause = error;
    return annotated;
  }
  return new Error(`${String(error)}\n${note}`);
}

function isDownloadedChromiumExecutable(executablePath: string): boolean {
  const normalized = executablePath.replaceAll("\\", "/");
  if (normalized.includes("chrome-headless-shell") || normalized.includes("chromium_headless_shell-")) {
    return false;
  }
  return DOWNLOADED_CHROMIUM.test(normalized);
}

function truncate(value: string, limit: number): string {
  const compact = value.replaceAll("\n", " ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}

function redact(value: string): string {
  const secret = process.env.REPROSEED_RESET_AUTHORIZATION;
  if (secret === undefined || secret === "") {
    return value;
  }
  return value.split(secret).join("[redacted]");
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
