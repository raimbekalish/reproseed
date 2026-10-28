import {
  DEFAULT_TIMING_MAX_REPLAYS,
  DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
  DEFAULT_TIMING_RESOLUTION_MS,
  type TimingSearchConfig,
} from "../core/duration.ts";
import { CliError, EXIT } from "./errors.ts";
import { DOCTOR_HELP, INIT_HELP, MINIMIZE_HELP, ROOT_HELP } from "./help.ts";
import { DEFAULT_INIT_PATH } from "./init.ts";
import type { StarterOracle } from "./starter.ts";

export const DEFAULT_REPORT_PATH = "artifacts/report.json";
export const DEFAULT_SPEC_PATH = "artifacts/minimized.spec.ts";

export type ParsedArgs =
  | { kind: "help"; text: string }
  | { kind: "version" }
  | { kind: "doctor"; scenarioPath: string }
  | { kind: "init"; scenarioPath: string; oracle: StarterOracle; force: boolean }
  | {
      kind: "minimize";
      scenarioPath: string;
      reportPath: string;
      specPath: string;
      tracePath?: string;
      force: boolean;
      tuneDelays?: TimingSearchConfig;
    };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new CliError(`a command is required\n\n${ROOT_HELP}`, EXIT.usage);
  }
  if (argv.includes("--version")) {
    if (argv.length !== 1 || argv[0] !== "--version") {
      throw new CliError("--version does not take other arguments", EXIT.usage);
    }
    return { kind: "version" };
  }

  const help = argv.includes("--help") || argv.includes("-h");
  const tokens = argv.filter((arg) => arg !== "--help" && arg !== "-h");
  if (help && tokens.length === 0) {
    return { kind: "help", text: ROOT_HELP };
  }
  const command = tokens[0];
  if (command === "init") {
    if (help) {
      return { kind: "help", text: INIT_HELP };
    }
    return parseInit(tokens.slice(1));
  }
  if (command === "doctor") {
    if (help) {
      return { kind: "help", text: DOCTOR_HELP };
    }
    return parseDoctor(tokens.slice(1));
  }
  if (command !== "minimize") {
    throw new CliError(`unknown command ${command ?? ""}\n\n${ROOT_HELP}`, EXIT.usage);
  }
  if (help) {
    return { kind: "help", text: MINIMIZE_HELP };
  }
  return parseMinimize(tokens.slice(1));
}

function parseDoctor(args: readonly string[]): ParsedArgs {
  let scenarioPath: string | undefined;
  let optionsOpen = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (optionsOpen && arg === "--") {
      optionsOpen = false;
      continue;
    }
    if (optionsOpen && arg.startsWith("-")) {
      throw new CliError(`unknown option ${arg}`, EXIT.usage);
    }
    if (scenarioPath !== undefined) {
      throw new CliError("only one scenario file can be checked", EXIT.usage);
    }
    scenarioPath = arg;
  }
  if (scenarioPath === undefined) {
    throw new CliError("scenario file is required", EXIT.usage);
  }
  return { kind: "doctor", scenarioPath };
}

function parseInit(args: readonly string[]): ParsedArgs {
  let scenarioPath = DEFAULT_INIT_PATH;
  let sawPath = false;
  let oracle: StarterOracle = "record-count";
  let sawOracle = false;
  let force = false;
  let optionsOpen = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (optionsOpen && arg === "--") {
      optionsOpen = false;
      continue;
    }
    if (optionsOpen && arg.startsWith("-")) {
      if (arg === "--force") {
        force = true;
        continue;
      }
      if (arg === "--oracle" || arg.startsWith("--oracle=")) {
        if (sawOracle) {
          throw new CliError("--oracle was provided more than once", EXIT.usage);
        }
        const read = readOracle(args, index, arg);
        oracle = read.value;
        sawOracle = true;
        index = read.index;
        continue;
      }
      throw new CliError(`unknown option ${arg}`, EXIT.usage);
    }
    if (sawPath) {
      throw new CliError("only one scenario file can be created", EXIT.usage);
    }
    scenarioPath = arg;
    sawPath = true;
  }
  return { kind: "init", scenarioPath, oracle, force };
}

function readOracle(
  args: readonly string[],
  index: number,
  arg: string,
): { value: StarterOracle; index: number } {
  const prefix = "--oracle=";
  let raw: string;
  let nextIndex = index;
  if (arg.startsWith(prefix)) {
    raw = arg.slice(prefix.length);
  } else {
    const next = args[index + 1];
    if (next === undefined || next === "--" || next.startsWith("-")) {
      throw new CliError("--oracle must be record-count or dom-text", EXIT.usage);
    }
    raw = next;
    nextIndex = index + 1;
  }
  if (raw !== "record-count" && raw !== "dom-text") {
    throw new CliError("--oracle must be record-count or dom-text", EXIT.usage);
  }
  return { value: raw, index: nextIndex };
}

function parseMinimize(args: readonly string[]): ParsedArgs {
  let scenarioPath: string | undefined;
  let reportPath = DEFAULT_REPORT_PATH;
  let specPath = DEFAULT_SPEC_PATH;
  let tracePath: string | undefined;
  let force = false;
  let tuneDelays = false;
  let resolutionMs: number | undefined;
  let maxReplays: number | undefined;
  let maxWallClockMs: number | undefined;
  let sawReport = false;
  let sawSpec = false;
  let sawTrace = false;
  let sawResolution = false;
  let sawMaxReplays = false;
  let sawMaxWall = false;
  let optionsOpen = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (optionsOpen && arg === "--") {
      optionsOpen = false;
      continue;
    }
    if (optionsOpen && arg.startsWith("-")) {
      if (arg === "--force") {
        force = true;
        continue;
      }
      if (arg === "--tune-delays") {
        if (tuneDelays) {
          throw new CliError("--tune-delays was provided more than once", EXIT.usage);
        }
        tuneDelays = true;
        continue;
      }
      if (arg === "--timing-resolution" || arg.startsWith("--timing-resolution=")) {
        if (sawResolution) {
          throw new CliError("--timing-resolution was provided more than once", EXIT.usage);
        }
        resolutionMs = readIntegerOption(args, index, arg, "timing-resolution");
        sawResolution = true;
        if (arg.startsWith("--timing-resolution=")) {
          continue;
        }
        index += 1;
        continue;
      }
      if (arg === "--timing-max-replays" || arg.startsWith("--timing-max-replays=")) {
        if (sawMaxReplays) {
          throw new CliError("--timing-max-replays was provided more than once", EXIT.usage);
        }
        maxReplays = readIntegerOption(args, index, arg, "timing-max-replays");
        sawMaxReplays = true;
        if (arg.startsWith("--timing-max-replays=")) {
          continue;
        }
        index += 1;
        continue;
      }
      if (arg === "--timing-max-ms" || arg.startsWith("--timing-max-ms=")) {
        if (sawMaxWall) {
          throw new CliError("--timing-max-ms was provided more than once", EXIT.usage);
        }
        maxWallClockMs = readIntegerOption(args, index, arg, "timing-max-ms");
        sawMaxWall = true;
        if (arg.startsWith("--timing-max-ms=")) {
          continue;
        }
        index += 1;
        continue;
      }
      if (arg === "--report" || arg.startsWith("--report=")) {
        if (sawReport) {
          throw new CliError("--report was provided more than once", EXIT.usage);
        }
        const read = readOption(args, index, arg, "report");
        reportPath = read.value;
        sawReport = true;
        index = read.index;
        continue;
      }
      if (arg === "--spec" || arg.startsWith("--spec=")) {
        if (sawSpec) {
          throw new CliError("--spec was provided more than once", EXIT.usage);
        }
        const read = readOption(args, index, arg, "spec");
        specPath = read.value;
        sawSpec = true;
        index = read.index;
        continue;
      }
      if (arg === "--trace" || arg.startsWith("--trace=")) {
        if (sawTrace) {
          throw new CliError("--trace was provided more than once", EXIT.usage);
        }
        const read = readOption(args, index, arg, "trace");
        tracePath = read.value;
        sawTrace = true;
        index = read.index;
        continue;
      }
      throw new CliError(`unknown option ${arg}`, EXIT.usage);
    }
    if (scenarioPath !== undefined) {
      throw new CliError("only one scenario file can be minimized", EXIT.usage);
    }
    scenarioPath = arg;
  }

  if (scenarioPath === undefined) {
    throw new CliError("scenario file is required", EXIT.usage);
  }
  if ((sawResolution || sawMaxReplays || sawMaxWall) && !tuneDelays) {
    throw new CliError("timing options require --tune-delays", EXIT.usage);
  }
  return {
    kind: "minimize",
    scenarioPath,
    reportPath,
    specPath,
    ...(tracePath !== undefined ? { tracePath } : {}),
    force,
    ...(tuneDelays
      ? {
          tuneDelays: {
            resolutionMs: resolutionMs ?? DEFAULT_TIMING_RESOLUTION_MS,
            maxReplayExecutions: maxReplays ?? DEFAULT_TIMING_MAX_REPLAYS,
            maxWallClockMs: maxWallClockMs ?? DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
          },
        }
      : {}),
  };
}

function readIntegerOption(
  args: readonly string[],
  index: number,
  arg: string,
  name: "timing-resolution" | "timing-max-replays" | "timing-max-ms",
): number {
  const prefix = `--${name}=`;
  let raw: string;
  if (arg.startsWith(prefix)) {
    raw = arg.slice(prefix.length);
  } else {
    const next = args[index + 1];
    if (next === undefined || next === "--" || next.startsWith("-")) {
      throw new CliError(`--${name} requires a positive integer`, EXIT.usage);
    }
    raw = next;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new CliError(`--${name} requires a positive integer`, EXIT.usage);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError(`--${name} requires a positive integer`, EXIT.usage);
  }
  return value;
}

function readOption(
  args: readonly string[],
  index: number,
  arg: string,
  name: "report" | "spec" | "trace",
): { value: string; index: number } {
  const prefix = `--${name}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (value === "") {
      throw new CliError(`--${name} requires a file path`, EXIT.usage);
    }
    return { value, index };
  }
  const next = args[index + 1];
  if (next === undefined || next === "--" || next.startsWith("-")) {
    throw new CliError(`--${name} requires a file path`, EXIT.usage);
  }
  return { value: next, index: index + 1 };
}
