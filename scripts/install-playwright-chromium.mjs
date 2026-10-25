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
    await closeBrowser(browser);
  } catch (error) {
    await killExecutable(executable);
    throw error;
  }
  await assertExecutableExited(executable);
  console.log("Chromium process exited");
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

async function assertExecutableExited(executable) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await executablePids(executable)).length) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const pids = await killExecutable(executable);
  throw new Error(`Chromium did not exit within ${EXIT_WAIT_MS}ms: ${pids.join(", ") || executable}`);
}

async function killExecutable(executable) {
  const pids = await executablePids(executable);
  for (const pid of pids) {
    signal(pid, "SIGKILL");
  }
  return pids;
}

function executablePids(executable) {
  const normalized = executable.replaceAll("\\", "/");
  const marker = /chromium-\d+\/[^/]+/.exec(normalized)?.[0] ?? executable;
  return listProcesses().then((listing) => {
    const pids = [];
    for (const line of listing.split("\n")) {
      if (!line.includes(marker) && !line.includes(executable)) {
        continue;
      }
      if (line.includes("chrome-headless-shell") || line.includes("chromium_headless_shell")) {
        continue;
      }
      const match = /^\s*(\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        pids.push(Number(match[1]));
      }
    }
    return pids;
  });
}

function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-Aww", "-o", "pid=,args="],
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

function signal(pid, name) {
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
