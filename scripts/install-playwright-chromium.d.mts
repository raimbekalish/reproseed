export const CHROMIUM_INSTALL_ARGS: readonly ["install", "--with-deps", "--no-shell", "chromium"];

export function playwrightVersionFromLock(lock: {
  packages?: Record<string, { version?: string } | undefined>;
}): string;
