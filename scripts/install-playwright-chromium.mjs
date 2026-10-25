import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "package.json"));

export const CHROMIUM_INSTALL_ARGS = ["install", "--with-deps", "--no-shell", "chromium"];
const LAUNCH_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const EXIT_WAIT_MS = 15_000;

export function playwrightVersionFromLock(lock) {
  const version = lock?.packages?.["node_modules/playwright"]?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package-lock.json is missing node_modules/playwright");
  }
  return version;
}

export async function installPlaywrightChromium() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const locked = playwrightVersionFromLock(lock);
  const installed = require("playwright/package.json").version;
  if (installed !== locked) {
    throw new Error(`Playwright version mismatch: installed ${installed}, lockfile ${locked}`);
  }
  const cli = join(root, "node_modules/playwright/cli.js");
  if (!existsSync(cli)) {
    throw new Error(`Playwright CLI is missing at ${cli}`);
  }
  console.log(
    `Installing Playwright Chromium ${installed} (${process.platform} ${process.arch}) with ${CHROMIUM_INSTALL_ARGS.join(" ")}`,
  );
  await run(process.execPath, [cli, ...CHROMIUM_INSTALL_ARGS]);
  await verifyChromiumLaunch(installed);
}

async function verifyChromiumLaunch(version) {
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(`Chromium executable is missing: ${executable}`);
  }
  if (executable.includes("chrome-headless-shell") || executable.includes("chromium_headless_shell")) {
    throw new Error(`Refusing chrome-headless-shell at ${executable}`);
  }
  if (!/(?:^|\/)chromium-\d+\//.test(executable.replaceAll("\\", "/"))) {
    throw new Error(`Chromium executable is not Playwright's downloaded revision: ${executable}`);
  }
  console.log(`Playwright ${version} Chromium executable: ${executable}`);
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    timeout: LAUNCH_TIMEOUT_MS,
  });
  console.log("Chromium launched headless=true channel=chromium");
  try {
    const listing = await listProcesses();
    const tree = selectProbeProcessTree(listing, { installerPid: process.pid, executablePath: executable });
    if (tree.leaderPid === undefined) {
      const shared = pidsUsingExecutable(listing, executable);
      throw new Error(
        `Could not identify the Chromium process launched by installer pid ${process.pid} (${tree.reason}). ` +
          `Refusing to signal processes that share ${executable}. ` +
          `Processes using that executable: ${shared.join(", ") || "none"}.`,
      );
    }
    const ownedRecords = parseProcessListing(listing).filter((record) => tree.ownedPids.includes(record.pid));
    try {
      await closeBrowser(browser);
    } catch (error) {
      const cleanup = await terminateOwned(tree.leaderPid, ownedRecords);
      throw new Error(`${error instanceof Error ? error.message : error}\n${formatCleanup(cleanup, executable)}`);
    }
    await assertOwnedExited(tree.leaderPid, ownedRecords, executable);
    console.log("Chromium process exited");
  } finally {
    await closeBrowser(browser).catch(() => undefined);
  }
}

function closeBrowser(browser) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`browser close timed out after ${CLOSE_TIMEOUT_MS}ms`)), CLOSE_TIMEOUT_MS);
    browser.close().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The probe owns one process tree: the single direct child of this installer
 * whose command contains the launched executable, plus that child's descendants.
 * Another Chromium process using the same executable is not part of the tree.
 * Zero or several direct children means ownership is not established.
 */
export function selectProbeProcessTree(listing, { installerPid, executablePath }) {
  if (typeof executablePath !== "string" || executablePath.trim() === "") {
    return { leaderPid: undefined, ownedPids: [], reason: "missing-executable" };
  }
  if (!Number.isInteger(installerPid) || installerPid <= 1) {
    return { leaderPid: undefined, ownedPids: [], reason: "missing-installer" };
  }
  const records = parseProcessListing(listing);
  const direct = records.filter(
    (record) => record.ppid === installerPid && record.pid !== installerPid && record.args.includes(executablePath),
  );
  if (direct.length !== 1) {
    return {
      leaderPid: undefined,
      ownedPids: [],
      reason: direct.length === 0 ? "no-direct-child" : "ambiguous-direct-children",
      candidatePids: direct.map((record) => record.pid),
    };
  }
  const leaderPid = direct[0].pid;
  const owned = new Set([leaderPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (owned.has(record.ppid) && !owned.has(record.pid)) {
        owned.add(record.pid);
        changed = true;
      }
    }
  }
  return { leaderPid, ownedPids: [...owned].sort((left, right) => left - right), reason: "owned" };
}

export function pidsUsingExecutable(listing, executablePath) {
  if (typeof executablePath !== "string" || executablePath.trim() === "") {
    return [];
  }
  return parseProcessListing(listing)
    .filter((record) => record.args.includes(executablePath))
    .map((record) => record.pid);
}

export function commandStillMatches(snapshotArgs, currentArgs) {
  if (currentArgs === undefined) {
    return false;
  }
  return normalizeCommand(currentArgs) === normalizeCommand(snapshotArgs);
}

function normalizeCommand(args) {
  return args.trim().replaceAll(/\s+/g, " ");
}

/** Pids from the owned snapshot whose live command is still the snapshotted command. */
export function terminationTargets(ownedRecords, currentArgsByPid) {
  return ownedRecords
    .filter((record) => commandStillMatches(record.args, currentArgsByPid.get(record.pid)))
    .map((record) => record.pid);
}

export function parseProcessListing(listing) {
  const records = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    records.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? "" });
  }
  return records;
}

async function assertOwnedExited(leaderPid, ownedRecords, executable) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await aliveOwned(ownedRecords)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const cleanup = await terminateOwned(leaderPid, ownedRecords);
  const reapDeadline = Date.now() + 2_000;
  let still = await aliveOwned(ownedRecords);
  while (still.length > 0 && Date.now() < reapDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    still = await aliveOwned(ownedRecords);
  }
  if (still.length > 0) {
    const shared = pidsUsingExecutable(await listProcesses(), executable);
    const untouched = shared.filter((pid) => !ownedRecords.some((record) => record.pid === pid));
    throw new Error(
      `Owned Chromium did not exit within ${EXIT_WAIT_MS}ms. ` +
        `Still alive: ${still.map((record) => record.pid).join(", ")}. ` +
        `${formatCleanup(cleanup, executable)} ` +
        `Untouched processes sharing the executable: ${untouched.join(", ") || "none"}.`,
    );
  }
}

async function aliveOwned(ownedRecords) {
  const current = await currentArgsFor(ownedRecords);
  const alive = terminationTargets(ownedRecords, current);
  return ownedRecords.filter((record) => alive.includes(record.pid));
}

async function terminateOwned(leaderPid, ownedRecords) {
  const current = await currentArgsFor(ownedRecords);
  const targets = terminationTargets(ownedRecords, current);
  const refused = ownedRecords
    .filter((record) => current.get(record.pid) !== undefined && !targets.includes(record.pid))
    .map((record) => record.pid);
  let signaledGroup = false;
  if (targets.includes(leaderPid)) {
    signaledGroup = signalGroup(leaderPid);
  }
  const signaledPids = [];
  for (const pid of targets) {
    if (pid === leaderPid && signaledGroup) {
      continue;
    }
    signal(pid, "SIGKILL");
    signaledPids.push(pid);
  }
  return { signaledGroup, signaledPids, refused, targets };
}

async function currentArgsFor(ownedRecords) {
  const current = new Map();
  for (const record of ownedRecords) {
    current.set(record.pid, await processArgs(record.pid));
  }
  return current;
}

function formatCleanup(cleanup, executable) {
  return (
    `Signaled probe process group: ${cleanup.signaledGroup}. ` +
    `Signaled owned pids: ${cleanup.signaledPids.join(", ") || "none"}. ` +
    `Refused because the command changed: ${cleanup.refused.join(", ") || "none"}. ` +
    `Did not select other processes using ${executable}.`
  );
}

function processArgs(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-ww", "-o", "args="],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const args = stdout.trim();
        resolve(args === "" ? undefined : args);
      },
    );
  });
}

function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-Aww", "-o", "pid=,ppid=,args="],
      { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
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

function signalGroup(leaderPid) {
  if (!Number.isInteger(leaderPid) || leaderPid <= 1) {
    return false;
  }
  try {
    process.kill(-leaderPid, "SIGKILL");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) {
      return false;
    }
    throw error;
  }
}

function signal(pid, name) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }
  try {
    process.kill(pid, name);
  } catch {
    // The process already exited.
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, killSignal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code ?? killSignal}`));
    });
  });
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  installPlaywrightChromium().then(
    () => {
      process.exit(0);
    },
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exit(1);
    },
  );
}
