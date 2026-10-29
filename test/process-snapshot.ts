import { execFile } from "node:child_process";

const LIST_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const NOTE_LINES = 20;
const NOTE_WIDTH = 160;

/**
 * POSIX `ps -A` lists every process on macOS and Linux.
 * BSD `ps -ax` is rejected by procps on Ubuntu.
 * `-ww` keeps the executable path from being truncated to the terminal width.
 */
export const PROCESS_LIST_ARGS = ["-Aww", "-o", "pid=,args="] as const;

/** Parent and arguments. `ps -ax` is rejected by procps, so this stays `-Aww`. */
export const PROCESS_TREE_ARGS = ["-Aww", "-o", "pid=,ppid=,args="] as const;

export type ProcessRecord = {
  pid: number;
  ppid: number;
  args: string;
};

export const BROWSER_PROCESS_PATTERN =
  /chrome-headless-shell|chromium_headless_shell|ms-playwright|chrome-linux64\/chrome|chrome-linux-arm64\/chrome|Google Chrome for Testing/;

export function listProcesses(): Promise<string> {
  return execText("ps", [...PROCESS_LIST_ARGS], LIST_TIMEOUT_MS);
}

export function listProcessTree(): Promise<string> {
  return execText("ps", [...PROCESS_TREE_ARGS], LIST_TIMEOUT_MS);
}

export function parseProcessTree(listing: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    records.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? "" });
  }
  return records;
}

/**
 * Processes whose parent chain reaches `rootPid` through records in this listing.
 * Pid 0 and pid 1 stop the walk, so a process reparented to init is not owned.
 * A missing parent stops the walk as well. `rootPid` itself is not included.
 * `rootPid` of 0 or 1 owns nothing: that would claim every process under init.
 */
export function descendantPids(records: readonly ProcessRecord[], rootPid: number): Set<number> {
  const owned = new Set<number>();
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return owned;
  }
  const parents = new Map<number, number>();
  for (const record of records) {
    if (record.pid > 0 && !parents.has(record.pid)) {
      parents.set(record.pid, record.ppid);
    }
  }
  for (const record of records) {
    if (record.pid === rootPid || record.pid <= 1) {
      continue;
    }
    const seen = new Set<number>([record.pid]);
    let parent = record.ppid;
    let reached = false;
    for (let depth = 0; depth < 64; depth += 1) {
      if (parent === rootPid) {
        reached = true;
        break;
      }
      if (parent <= 1 || seen.has(parent)) {
        break;
      }
      const next = parents.get(parent);
      if (next === undefined) {
        break;
      }
      seen.add(parent);
      parent = next;
    }
    if (reached) {
      owned.add(record.pid);
    }
  }
  return owned;
}

export type BrowserLeakSplit = {
  owned: number[];
  suspected: number[];
};

/** New browser pids split by whether the parent chain reaches `rootPid`. */
export function splitNewBrowserPids(
  records: readonly ProcessRecord[],
  before: ReadonlySet<number>,
  rootPid: number,
): BrowserLeakSplit {
  const descendants = descendantPids(records, rootPid);
  const owned: number[] = [];
  const suspected: number[] = [];
  for (const record of records) {
    if (!BROWSER_PROCESS_PATTERN.test(record.args) || before.has(record.pid) || record.pid <= 1) {
      continue;
    }
    if (descendants.has(record.pid)) {
      owned.push(record.pid);
    } else {
      suspected.push(record.pid);
    }
  }
  owned.sort((left, right) => left - right);
  suspected.sort((left, right) => left - right);
  return { owned, suspected };
}

/** A pid may be signalled only when it is still a browser process and is not init. */
export function killableOwnedBrowser(pid: number, args: string | undefined): boolean {
  return Number.isInteger(pid) && pid > 1 && args !== undefined && BROWSER_PROCESS_PATTERN.test(args);
}

export type SignalReason =
  | "owned-browser"
  | "process-group"
  | "pid-out-of-range"
  | "runner"
  | "exited"
  | "identity-changed"
  | "not-owned";

export type SignalDecision = {
  action: "signal" | "skip";
  reason: SignalReason;
};

/**
 * Decides whether one pid may be signalled.
 * Ownership is the parent chain in `records` reaching `rootPid`.
 * A browser reparented to init, or whose parent is missing, is not owned.
 * This does not treat a new Chromium pid as owned, and it does not invent
 * ownership after the parent has exited. The caller reports that case and
 * does not signal it.
 * `currentArgs` is a fresh `ps` reading. A reused pid with different arguments
 * is skipped. Pid 0, pid 1, a negative process-group id, and the runner are skipped.
 */
export function planOwnedBrowserSignal(input: {
  pid: number;
  rootPid: number;
  runnerPid: number;
  currentArgs: string | undefined;
  records: readonly ProcessRecord[];
}): SignalDecision {
  const { pid, rootPid, runnerPid, currentArgs, records } = input;
  if (!Number.isInteger(pid) || pid < 0) {
    return { action: "skip", reason: "process-group" };
  }
  if (pid === 0 || pid === 1) {
    return { action: "skip", reason: "pid-out-of-range" };
  }
  if (pid === runnerPid || pid === rootPid) {
    return { action: "skip", reason: "runner" };
  }
  if (currentArgs === undefined) {
    return { action: "skip", reason: "exited" };
  }
  if (!BROWSER_PROCESS_PATTERN.test(currentArgs)) {
    return { action: "skip", reason: "identity-changed" };
  }
  if (!descendantPids(records, rootPid).has(pid)) {
    return { action: "skip", reason: "not-owned" };
  }
  return { action: "signal", reason: "owned-browser" };
}

/** The direct child pid to signal, or undefined when the pid is not a safe single process. */
export function directChildPid(pid: number | undefined, runnerPid: number): number | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === runnerPid) {
    return undefined;
  }
  return pid;
}

/** Signals one direct child. Returns false when the pid is not safe to signal. */
export function signalDirectChild(pid: number | undefined, runnerPid: number, signal: (pid: number) => void): boolean {
  const target = directChildPid(pid, runnerPid);
  if (target === undefined) {
    return false;
  }
  signal(target);
  return true;
}

/** Stops a child this test spawned. Does not signal a process group or any other pid. */
export function stopDirectChild(child: {
  pid?: number;
  stdout?: { destroy(): void } | null;
  stderr?: { destroy(): void } | null;
}): void {
  try {
    signalDirectChild(child.pid, process.pid, (pid) => {
      process.kill(pid, "SIGKILL");
    });
  } catch {
    // The child already exited.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function browserPidSet(records: readonly ProcessRecord[]): Set<number> {
  const pids = new Set<number>();
  for (const record of records) {
    if (record.pid > 1 && BROWSER_PROCESS_PATTERN.test(record.args)) {
      pids.add(record.pid);
    }
  }
  return pids;
}

export async function browserSnapshot(): Promise<Set<number>> {
  return browserPidSet(parseProcessTree(await listProcessTree()));
}

export async function readBrowserLeaks(before: ReadonlySet<number>, rootPid: number): Promise<BrowserLeakSplit> {
  return splitNewBrowserPids(parseProcessTree(await listProcessTree()), before, rootPid);
}

const LEAK_POLLS = 60;
const LEAK_POLL_MS = 250;

/** Waits for browsers still parented under `rootPid` to exit. Unattributed pids are left in `suspected`. */
export async function settleBrowserLeaks(before: ReadonlySet<number>, rootPid: number): Promise<BrowserLeakSplit> {
  let split = await readBrowserLeaks(before, rootPid);
  for (let attempt = 0; attempt < LEAK_POLLS && split.owned.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, LEAK_POLL_MS));
    split = await readBrowserLeaks(before, rootPid);
  }
  return split;
}

/**
 * Signals only pids that still pass `planOwnedBrowserSignal` on a fresh listing.
 * A pid that exited, changed command, or lost its parent chain is not signalled.
 */
export async function signalProvenBrowserLeaks(
  pids: readonly number[],
  rootPid: number,
  runnerPid: number,
): Promise<SignalDecision[]> {
  const decisions: SignalDecision[] = [];
  for (const pid of pids) {
    const records = parseProcessTree(await listProcessTree());
    const currentArgs = await processCommand(pid);
    const decision = planOwnedBrowserSignal({ pid, rootPid, runnerPid, currentArgs, records });
    decisions.push(decision);
    if (decision.action !== "signal") {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the ownership check and the signal.
    }
  }
  return decisions;
}

/**
 * Waits for owned browsers, signals only those that still prove ownership, and
 * reports the rest. The returned `owned` list is what remained after the wait,
 * before signalling, so a real owned leak still fails the caller.
 */
export async function finishBrowserCleanup(before: ReadonlySet<number>, rootPid = process.pid): Promise<BrowserLeakSplit> {
  const leaks = await settleBrowserLeaks(before, rootPid);
  await signalProvenBrowserLeaks(leaks.owned, rootPid, rootPid);
  if (leaks.suspected.length > 0) {
    const note = await leakedProcessNote(leaks.suspected);
    console.log(`Suspected browser processes were left running because ownership was not established:\n${note}`);
  }
  return leaks;
}

export function processCommand(pid: number): Promise<string | undefined> {
  return execText("ps", ["-p", String(pid), "-o", "args="], PROCESS_TIMEOUT_MS).then(
    (stdout) => stdout,
    () => undefined,
  );
}

export function browserPidsFromListing(listing: string): Set<number> {
  const pids = new Set<number>();
  for (const line of listing.split("\n")) {
    if (!BROWSER_PROCESS_PATTERN.test(line)) {
      continue;
    }
    const match = /^\s*(\d+)/.exec(line);
    if (match?.[1] !== undefined) {
      pids.add(Number(match[1]));
    }
  }
  return pids;
}

export async function browserPids(): Promise<Set<number>> {
  return browserPidsFromListing(await listProcesses());
}

export async function leakedProcessNote(pids: readonly number[]): Promise<string> {
  if (pids.length === 0) {
    return "";
  }
  try {
    const wanted = new Set(pids);
    const lines = (await listProcesses())
      .split("\n")
      .filter((line) => {
        const match = /^\s*(\d+)/.exec(line);
        return match?.[1] !== undefined && wanted.has(Number(match[1]));
      })
      .slice(0, NOTE_LINES)
      .map((line) => line.trim().slice(0, NOTE_WIDTH));
    if (lines.length === 0) {
      return `browser processes exited before they could be described: ${pids.join(", ")}`;
    }
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `browser process list unavailable: ${message.slice(0, NOTE_WIDTH)}`;
  }
}

/** Short note for a timed-out browser child. Empty when no browser process is listed. */
export async function browserProcessNote(): Promise<string> {
  try {
    const lines = (await listProcesses())
      .split("\n")
      .filter((line) => BROWSER_PROCESS_PATTERN.test(line))
      .slice(0, NOTE_LINES)
      .map((line) => line.trim().slice(0, NOTE_WIDTH));
    if (lines.length === 0) {
      return "browser processes: none";
    }
    return `browser processes:\n${lines.join("\n")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `browser process list unavailable: ${message.slice(0, NOTE_WIDTH)}`;
  }
}

function execText(command: string, args: readonly string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
