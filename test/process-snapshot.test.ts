import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BROWSER_PROCESS_PATTERN,
  PROCESS_LIST_ARGS,
  PROCESS_TREE_ARGS,
  browserPidsFromListing,
  descendantPids,
  killableOwnedBrowser,
  leakedProcessNote,
  listProcesses,
  parseProcessTree,
  splitNewBrowserPids,
} from "./process-snapshot.ts";

describe("process snapshots", () => {
  it("uses a ps invocation that procps and macOS both accept", () => {
    const args: readonly string[] = PROCESS_LIST_ARGS;
    assert.deepEqual([...args], ["-Aww", "-o", "pid=,args="]);
    assert.equal(args.includes("-ax"), false);
  });

  it("reads browser pids from Linux and macOS process lines", () => {
    const listing = [
      "  10 /usr/bin/node --test",
      "  42 /home/runner/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome --headless",
      "  43 /home/runner/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
      "  99 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "  100 /Users/dev/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ].join("\n");
    assert.deepEqual([...browserPidsFromListing(listing)], [42, 43, 100]);
    assert.equal(BROWSER_PROCESS_PATTERN.test("node --test test/runner/replay.test.ts"), false);
  });

  it("lists processes on this machine", async () => {
    const listing = await listProcesses();
    assert.match(listing, /^\s*\d+/m);
  });

  it("describes no leaked processes when the pid list is empty", async () => {
    assert.equal(await leakedProcessNote([]), "");
  });

  it("attributes browser descendants and leaves unrelated processes alone", () => {
    const args: readonly string[] = PROCESS_TREE_ARGS;
    assert.deepEqual([...args], ["-Aww", "-o", "pid=,ppid=,args="]);
    const listing = [
      "  1 0 /sbin/launchd",
      "  10 1 node --test",
      "  42 10 /opt/ms-playwright/chromium-1248/chrome-linux64/chrome --headless",
      "  43 42 /opt/ms-playwright/chromium-1248/chrome-linux64/chrome --type=renderer",
      "  80 1 node other-suite",
      "  99 1 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "  100 80 /Users/dev/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "  200 999 /opt/ms-playwright/chromium-1248/chrome-linux64/chrome --orphan",
      "  5 6 /opt/ms-playwright/chromium-1248/chrome-linux64/chrome --cycle",
      "  6 5 /opt/ms-playwright/chromium-1248/chrome-linux64/chrome --cycle",
    ].join("\n");
    const records = parseProcessTree(listing);
    assert.deepEqual([...descendantPids(records, 10)].sort((left, right) => left - right), [42, 43]);
    assert.deepEqual([...descendantPids(records, 1)], []);
    assert.deepEqual([...descendantPids(records, 0)], []);
    const split = splitNewBrowserPids(records, new Set<number>(), 10);
    assert.deepEqual(split.owned, [42, 43]);
    assert.deepEqual(split.suspected, [5, 6, 99, 100, 200]);
    const after = splitNewBrowserPids(records, new Set([99, 100]), 10);
    assert.deepEqual(after.owned, [42, 43]);
    assert.equal(after.suspected.includes(99), false);
    assert.equal(after.suspected.includes(100), false);
    assert.equal(killableOwnedBrowser(1, records.find((record) => record.pid === 42)?.args), false);
    assert.equal(killableOwnedBrowser(42, "node --test"), false);
    assert.equal(killableOwnedBrowser(42, undefined), false);
    assert.equal(killableOwnedBrowser(42, records.find((record) => record.pid === 42)?.args), true);
  });
});
