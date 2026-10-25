export const CHROMIUM_INSTALL_ARGS: readonly ["install", "--with-deps", "--no-shell", "chromium"];

export function playwrightVersionFromLock(lock: {
  packages?: Record<string, { version?: string } | undefined>;
}): string;

export function selectProbeProcessTree(
  listing: string,
  identity: { installerPid: number; executablePath: string },
): {
  leaderPid: number | undefined;
  ownedPids: number[];
  reason: string;
  candidatePids?: number[];
};

export function pidsUsingExecutable(listing: string, executablePath: string): number[];

export function commandStillMatches(snapshotArgs: string, currentArgs: string | undefined): boolean;

export function terminationTargets(
  ownedRecords: readonly { pid: number; args: string }[],
  currentArgsByPid: ReadonlyMap<number, string | undefined>,
): number[];

export function parseProcessListing(listing: string): { pid: number; ppid: number; args: string }[];
