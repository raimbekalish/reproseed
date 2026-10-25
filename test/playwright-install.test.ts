import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHROMIUM_INSTALL_ARGS,
  commandStillMatches,
  pidsUsingExecutable,
  playwrightVersionFromLock,
  selectProbeProcessTree,
  terminationTargets,
} from "../scripts/install-playwright-chromium.mjs";

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

  it("keeps an unrelated Chromium process out of the probe tree", () => {
    const executable = "/home/runner/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
    const listing = [
      "  10     1 node scripts/install-playwright-chromium.mjs",
      `  42    10 ${executable} --user-data-dir=/tmp/playwright-probe --headless`,
      `  43    42 ${executable} --type=renderer --user-data-dir=/tmp/playwright-probe`,
      "  44    42 /opt/chrome/chrome-helper --type=gpu-process",
      `  99    80 ${executable} --user-data-dir=/tmp/other-session`,
      ` 100    99 ${executable} --type=renderer --user-data-dir=/tmp/other-session`,
      "   7     1 /usr/lib/chromium/chrome",
    ].join("\n");

    const tree = selectProbeProcessTree(listing, { installerPid: 10, executablePath: executable });
    assert.equal(tree.reason, "owned");
    assert.equal(tree.leaderPid, 42);
    assert.deepEqual(tree.ownedPids, [42, 43, 44]);
    assert.deepEqual(pidsUsingExecutable(listing, executable), [42, 43, 99, 100]);
    for (const unrelated of [99, 100, 7, 10]) {
      assert.equal(tree.ownedPids.includes(unrelated), false);
    }
  });

  it("does not choose a kill target when several direct children share the executable", () => {
    const executable = "/home/runner/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
    const listing = [`  42    10 ${executable} --probe`, `  45    10 ${executable} --other`, `  99    80 ${executable} --unrelated`].join(
      "\n",
    );
    const tree = selectProbeProcessTree(listing, { installerPid: 10, executablePath: executable });
    assert.equal(tree.reason, "ambiguous-direct-children");
    assert.equal(tree.leaderPid, undefined);
    assert.deepEqual(tree.ownedPids, []);
    assert.deepEqual(tree.candidatePids, [42, 45]);
  });

  it("refuses a reused pid whose command no longer matches the probe snapshot", () => {
    const owned = [
      { pid: 42, args: "/chrome --user-data-dir=/tmp/playwright-probe" },
      { pid: 43, args: "/chrome --type=renderer --user-data-dir=/tmp/playwright-probe" },
    ];
    const current = new Map<number, string | undefined>([
      [42, owned[0]?.args],
      [43, "bash -c unrelated"],
      [99, "/chrome --user-data-dir=/tmp/other-session"],
    ]);
    assert.equal(commandStillMatches(owned[0]?.args ?? "", current.get(42)), true);
    assert.equal(commandStillMatches(owned[1]?.args ?? "", current.get(43)), false);
    assert.deepEqual(terminationTargets(owned, current), [42]);
    assert.equal(terminationTargets(owned, current).includes(99), false);
  });
});
