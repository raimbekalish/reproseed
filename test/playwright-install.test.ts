import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CHROMIUM_INSTALL_ARGS, playwrightVersionFromLock } from "../scripts/install-playwright-chromium.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

describe("Playwright Chromium install", () => {
  it("installs the locked Chromium build without the headless shell", () => {
    assert.deepEqual([...CHROMIUM_INSTALL_ARGS], ["install", "--with-deps", "--no-shell", "chromium"]);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    const locked = playwrightVersionFromLock(lock);
    const installed = (require("playwright/package.json") as { version: string }).version;
    assert.equal(installed, locked);
    assert.equal(locked, "1.64.1");
  });

  it("rejects a lockfile that does not pin playwright", () => {
    assert.throws(() => playwrightVersionFromLock({}), /node_modules\/playwright/);
    assert.throws(() => playwrightVersionFromLock({ packages: { "node_modules/playwright": { version: " " } } }), /playwright/);
  });
});
