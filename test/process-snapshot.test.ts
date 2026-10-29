import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";

import {
  BROWSER_PROCESS_PATTERN,
  PROCESS_LIST_ARGS,
  PROCESS_TREE_ARGS,
  browserPidsFromListing,
  descendantPids,
  directChildPid,
  killableOwnedBrowser,
  leakedProcessNote,
  listProcesses,
  parseProcessTree,
  planOwnedBrowserSignal,
  processCommand,
  signalDirectChild,
  splitNewBrowserPids,
  stopDirectChild,
  type ProcessRecord,
} from "./process-snapshot.ts";

const CHROME = "/opt/ms-playwright/chromium-1248/chrome-linux64/chrome";

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
    const decisions = decisionsFor(records, new Set<number>(), 10, 10);
    assert.deepEqual(
      decisions.filter((decision) => decision.action === "signal").map((decision) => decision.pid),
      [42, 43],
    );
    assert.equal(decisionFor(records, 99, 10, 10, chromeArgs(99, records)).reason, "not-owned");
    assert.equal(decisionFor(records, 100, 10, 10, chromeArgs(100, records)).reason, "not-owned");
    assert.equal(decisionFor(records, 200, 10, 10, chromeArgs(200, records)).reason, "not-owned");
    assert.equal(decisionFor(records, 5, 10, 10, chromeArgs(5, records)).reason, "not-owned");
    assert.equal(decisionFor(records, 99, 10, 10, chromeArgs(99, records)).action, "skip");
  });

  it("refuses pid 0, pid 1, the runner, a process group, and a reparented browser", () => {
    const records = parseProcessTree(
      ["  1 0 /sbin/init", `  42 1 ${CHROME}`, `  43 10 ${CHROME}`, "  10 1 node --test"].join("\n"),
    );
    assert.equal(planOwnedBrowserSignal({ pid: 0, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).reason, "pid-out-of-range");
    assert.equal(planOwnedBrowserSignal({ pid: 1, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).reason, "pid-out-of-range");
    assert.equal(planOwnedBrowserSignal({ pid: -42, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).reason, "process-group");
    assert.equal(planOwnedBrowserSignal({ pid: 10, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).reason, "runner");
    assert.equal(planOwnedBrowserSignal({ pid: 42, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).reason, "not-owned");
    assert.equal(planOwnedBrowserSignal({ pid: 43, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records }).action, "signal");
    assert.equal(planOwnedBrowserSignal({ pid: 43, rootPid: 0, runnerPid: 10, currentArgs: CHROME, records }).reason, "not-owned");
    assert.equal(planOwnedBrowserSignal({ pid: 43, rootPid: 1, runnerPid: 10, currentArgs: CHROME, records }).reason, "not-owned");
  });

  it("skips a pid that exited or changed identity before signalling", () => {
    const records = parseProcessTree([`  42 10 ${CHROME}`, "  10 1 node --test"].join("\n"));
    assert.equal(
      planOwnedBrowserSignal({ pid: 42, rootPid: 10, runnerPid: 10, currentArgs: undefined, records }).reason,
      "exited",
    );
    assert.equal(
      planOwnedBrowserSignal({ pid: 42, rootPid: 10, runnerPid: 10, currentArgs: "bash -c reused", records }).reason,
      "identity-changed",
    );
    const reparented = parseProcessTree([`  42 1 ${CHROME}`, "  10 1 node --test"].join("\n"));
    assert.equal(
      planOwnedBrowserSignal({ pid: 42, rootPid: 10, runnerPid: 10, currentArgs: CHROME, records: reparented }).reason,
      "not-owned",
    );
  });

  it("signals only a direct child and ignores unsafe pids", () => {
    const signaled: number[] = [];
    const signal = (pid: number): void => {
      signaled.push(pid);
    };
    assert.equal(signalDirectChild(42, 10, signal), true);
    assert.equal(signalDirectChild(undefined, 10, signal), false);
    assert.equal(signalDirectChild(0, 10, signal), false);
    assert.equal(signalDirectChild(1, 10, signal), false);
    assert.equal(signalDirectChild(-15, 10, signal), false);
    assert.equal(signalDirectChild(10, 10, signal), false);
    assert.deepEqual(signaled, [42]);
    assert.equal(directChildPid(42, 10), 42);
    assert.equal(directChildPid(1, 10), undefined);
  });

  it("cleans up a direct child after it exits", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(child, "exit");
    stopDirectChild(child);
    assert.equal(await processCommand(child.pid ?? 0), undefined);
  });

  it("cleans up a direct child after a failure and does not record an unrelated pid", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const owned = child.pid;
    assert.equal(typeof owned, "number");
    const signaled: number[] = [];
    let failed = false;
    try {
      throw new Error("assertion failed");
    } catch {
      failed = true;
      assert.equal(signalDirectChild(owned, process.pid, (pid) => signaled.push(pid)), true);
      assert.equal(signalDirectChild(1, process.pid, (pid) => signaled.push(pid)), false);
      stopDirectChild(child);
    }
    assert.equal(failed, true);
    assert.deepEqual(signaled, [owned]);
    await once(child, "exit");
    assert.equal(await processCommand(owned ?? 0), undefined);
  });
});

function chromeArgs(pid: number, records: readonly ProcessRecord[]): string {
  return records.find((record) => record.pid === pid)?.args ?? "";
}

function decisionFor(
  records: readonly ProcessRecord[],
  pid: number,
  rootPid: number,
  runnerPid: number,
  currentArgs: string | undefined,
) {
  return planOwnedBrowserSignal({ pid, rootPid, runnerPid, currentArgs, records });
}

function decisionsFor(records: readonly ProcessRecord[], before: ReadonlySet<number>, rootPid: number, runnerPid: number) {
  const split = splitNewBrowserPids(records, before, rootPid);
  return [...split.owned, ...split.suspected].map((pid) => ({
    pid,
    ...planOwnedBrowserSignal({ pid, rootPid, runnerPid, currentArgs: chromeArgs(pid, records), records }),
  }));
}
