import { CliError, EXIT } from "./errors.ts";
import { MINIMIZE_HELP, ROOT_HELP } from "./help.ts";

export const DEFAULT_REPORT_PATH = "artifacts/report.json";
export const DEFAULT_SPEC_PATH = "artifacts/minimized.spec.ts";

export type ParsedArgs =
  | { kind: "help"; text: string }
  | { kind: "version" }
  | {
      kind: "minimize";
      scenarioPath: string;
      reportPath: string;
      specPath: string;
      force: boolean;
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
  if (command !== "minimize") {
    throw new CliError(`unknown command ${command ?? ""}\n\n${ROOT_HELP}`, EXIT.usage);
  }
  if (help) {
    return { kind: "help", text: MINIMIZE_HELP };
  }
  return parseMinimize(tokens.slice(1));
}

function parseMinimize(args: readonly string[]): ParsedArgs {
  let scenarioPath: string | undefined;
  let reportPath = DEFAULT_REPORT_PATH;
  let specPath = DEFAULT_SPEC_PATH;
  let force = false;
  let sawReport = false;
  let sawSpec = false;
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
  return { kind: "minimize", scenarioPath, reportPath, specPath, force };
}

function readOption(
  args: readonly string[],
  index: number,
  arg: string,
  name: "report" | "spec",
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
