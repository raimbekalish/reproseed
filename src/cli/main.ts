import { readFileSync } from "node:fs";

import { parseArgs } from "./args.ts";
import { CliError, EXIT } from "./errors.ts";
import { redactSecrets } from "./redact.ts";
import { runMinimizeCommand, type MinimizeCommand } from "./run.ts";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  minimize?: MinimizeCommand["minimize"];
  preflight?: MinimizeCommand["preflight"];
};

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const secret = io.env.REPROSEED_RESET_AUTHORIZATION;
  const secrets = typeof secret === "string" ? [secret] : [];
  const stdout = (text: string): void => io.stdout(redactSecrets(text, secrets));
  const stderr = (text: string): void => io.stderr(redactSecrets(text, secrets));
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "help") {
      stdout(parsed.text.endsWith("\n") ? parsed.text : `${parsed.text}\n`);
      return EXIT.verified;
    }
    if (parsed.kind === "version") {
      stdout(`${readPackageVersion()}\n`);
      return EXIT.verified;
    }
    return await runMinimizeCommand({
      scenarioPath: parsed.scenarioPath,
      reportPath: parsed.reportPath,
      specPath: parsed.specPath,
      force: parsed.force,
      cwd: io.cwd,
      env: io.env,
      stdout,
      stderr,
      ...(io.minimize !== undefined ? { minimize: io.minimize } : {}),
      ...(io.preflight !== undefined ? { preflight: io.preflight } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reproseed failed";
    stderr(`reproseed: ${redactSecrets(message, secrets)}\n`);
    if (error instanceof CliError) {
      return error.exitCode;
    }
    return EXIT.internal;
  }
}

function readPackageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8")) as unknown;
  } catch {
    throw new CliError("package version could not be read", EXIT.internal);
  }
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new CliError("package version is missing", EXIT.internal);
  }
  const version = parsed.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new CliError("package version is missing", EXIT.internal);
  }
  return version;
}
