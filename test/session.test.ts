import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { fallbackPlaywrightExecutable } from "../src/runner/session.ts";

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
