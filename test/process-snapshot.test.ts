import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BROWSER_PROCESS_PATTERN,
  PROCESS_LIST_ARGS,
  browserPidsFromListing,
  leakedProcessNote,
  listProcesses,
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
});
