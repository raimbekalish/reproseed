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

export const BROWSER_PROCESS_PATTERN =
  /chrome-headless-shell|chromium_headless_shell|ms-playwright|chrome-linux64\/chrome|chrome-linux-arm64\/chrome|Google Chrome for Testing/;

export function listProcesses(): Promise<string> {
  return execText("ps", [...PROCESS_LIST_ARGS], LIST_TIMEOUT_MS);
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
