import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { chromiumLaunchFallback, fallbackPlaywrightExecutable, formatLaunchDiagnostic } from "../src/runner/session.ts";

const MISSING_ARM64 = [
  "browserType.launch: Executable doesn't exist at /var/folders/cache/playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "╔════════════════════════════════════════════════════════════╗",
  "║ Looks like Playwright was just installed or updated.       ║",
  "╚════════════════════════════════════════════════════════════╝",
].join("\n");

describe("playwright browser fallback", () => {
  it("uses the same revision from the default cache when the configured path is empty", () => {
    const root = "/tmp/ms-playwright";
    const found = fallbackPlaywrightExecutable(new Error(MISSING_ARM64), root, (path) =>
      path.endsWith("chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    );
    assert.equal(
      found,
      resolve(root, "chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    );
  });

  it("keeps the original launch error when that revision is not installed", () => {
    assert.equal(fallbackPlaywrightExecutable(new Error(MISSING_ARM64), "/tmp/ms-playwright", () => false), undefined);
    assert.equal(fallbackPlaywrightExecutable(new Error("navigation timeout"), "/tmp/ms-playwright", () => true), undefined);
    assert.equal(fallbackPlaywrightExecutable("not an error", "/tmp/ms-playwright", () => true), undefined);
  });

  it("does not follow a missing path outside the default cache", () => {
    const message =
      "browserType.launch: Executable doesn't exist at /var/folders/cache/playwright/chromium_headless_shell-1248/../../etc/passwd";
    assert.equal(fallbackPlaywrightExecutable(new Error(message), "/tmp/ms-playwright", () => true), undefined);
  });
});

describe("chromium launch fallback", () => {
  it("uses the downloaded Chromium revision from the default cache", () => {
    const root = "/tmp/ms-playwright";
    const linux = new Error(
      "browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    );
    const mac = new Error(
      "browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    assert.equal(
      chromiumLaunchFallback(linux, root, (path) => path.endsWith("chrome-linux64/chrome")),
      resolve(root, "chromium-1248/chrome-linux64/chrome"),
    );
    assert.equal(
      chromiumLaunchFallback(mac, root, (path) => path.includes("Google Chrome for Testing")),
      resolve(
        root,
        "chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    );
  });

  it("does not substitute chrome-headless-shell or a system browser", () => {
    const root = "/tmp/ms-playwright";
    assert.equal(chromiumLaunchFallback(new Error(MISSING_ARM64), root, () => true), undefined);
    assert.equal(
      chromiumLaunchFallback(
        new Error("browserType.launch: Executable doesn't exist at /opt/google/chrome/chrome"),
        root,
        () => true,
      ),
      undefined,
    );
    assert.equal(chromiumLaunchFallback(new Error("navigation timeout"), root, () => true), undefined);
  });
});

describe("launch diagnostics", () => {
  it("records the Chromium channel and omits the reset credential", () => {
    const previousBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const previousSecret = process.env.REPROSEED_RESET_AUTHORIZATION;
    const secret = "super-secret-reset-token";
    process.env.PLAYWRIGHT_BROWSERS_PATH = `/tmp/browsers/${secret}`;
    process.env.REPROSEED_RESET_AUTHORIZATION = secret;
    try {
      const note = formatLaunchDiagnostic("/tmp/browsers/chromium-1248/chrome-linux64/chrome");
      assert.match(note, new RegExp(`platform=${process.platform}`));
      assert.match(note, /headless=true channel=chromium timeoutMs=30000/);
      assert.match(note, /PLAYWRIGHT_BROWSERS_PATH=\/tmp\/browsers\/\[redacted\]/);
      assert.match(note, /fallback executable=/);
      assert.equal(note.includes(secret), false);
      assert.ok(note.length <= 1_200);
    } finally {
      restoreEnv("PLAYWRIGHT_BROWSERS_PATH", previousBrowsers);
      restoreEnv("REPROSEED_RESET_AUTHORIZATION", previousSecret);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
