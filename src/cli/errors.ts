/** Process statuses for `reproseed minimize`. Documented in `--help`. */
export const EXIT = {
  verified: 0,
  usage: 1,
  unstable: 2,
  budget: 3,
  internal: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
